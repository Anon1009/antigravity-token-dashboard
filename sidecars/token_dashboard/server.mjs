import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  computeConversationMetrics,
  FALLBACK_MODELS,
  findTranscriptPath,
  isValidUuid,
  listRecentConversations,
  readJsonLinesFile,
} from './metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..', '..');
const DATA_DIR = join(PLUGIN_ROOT, '.data');
const TIMINGS_DIR = join(DATA_DIR, 'timings');
const OBSERVED_DIR = join(DATA_DIR, 'observed');
const OVERRIDES_PATH = join(DATA_DIR, 'overrides.json');
const CATALOG_PATH = join(DATA_DIR, 'model-catalog.json');
const HTML_PATH = join(HERE, 'index.html');
const CATALOG_TTL_MS = 10 * 60 * 1000;

mkdirSync(TIMINGS_DIR, { recursive: true });
mkdirSync(OBSERVED_DIR, { recursive: true });

// --- Model Catalog via Language Server ----------------------------------------

let catalogCache = loadJsonFile(CATALOG_PATH, {});
let catalogFetchedAt = 0;

function loadJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function saveJsonFile(path, obj) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(obj, null, 2));
  } catch {
    // Non-fatal persistence failure.
  }
}

function lsRequest(method, body) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) return Promise.reject(new Error('No language server address'));
  const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
  const data = JSON.stringify(body);
  const transport = base.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 4000,
        rejectUnauthorized: false,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${method}: HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function refreshModelCatalog() {
  if (Date.now() - catalogFetchedAt < CATALOG_TTL_MS && Object.keys(catalogCache).length > 0) {
    return;
  }
  catalogFetchedAt = Date.now();
  try {
    const resp = await lsRequest('GetAvailableModels', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
    });
    const models = resp?.response?.models || resp?.models || {};
    const next = {};
    for (const [id, m] of Object.entries(models)) {
      const maxTokens = Number(m?.maxTokens) || 0;
      if (maxTokens > 0) {
        next[id] = {
          maxTokens,
          displayName: m.displayName || id,
        };
      }
    }
    if (Object.keys(next).length > 0) {
      catalogCache = next;
      saveJsonFile(CATALOG_PATH, next);
    }
  } catch {
    // Keep cached/fallback catalog if LS is temporarily unreachable.
  }
}

// --- Live Transcript Watcher & Observed Completion Cache ----------------------

const observedByConv = new Map(); // convId -> Map(stepIndex -> doneMs)
const knownStatusByConv = new Map(); // convId -> Map(stepIndex -> status)
const watchersByConv = new Map(); // convId -> { watcher, timer, fileStamp }

function getObservedMap(convId) {
  if (observedByConv.has(convId)) return observedByConv.get(convId);
  const saved = loadJsonFile(join(OBSERVED_DIR, `${convId}.json`), {});
  const map = new Map();
  for (const [k, v] of Object.entries(saved)) {
    const idx = Number(k);
    const ts = Number(v);
    if (Number.isInteger(idx) && Number.isFinite(ts)) {
      map.set(idx, ts);
    }
  }
  observedByConv.set(convId, map);
  return map;
}

function persistObservedMap(convId, map) {
  const obj = {};
  for (const [k, v] of map.entries()) {
    obj[String(k)] = v;
  }
  saveJsonFile(join(OBSERVED_DIR, `${convId}.json`), obj);
}

function fileStamp(path) {
  if (!path || !existsSync(path)) return '-';
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

function scanTranscriptForTransitions(convId, transcriptPath, { isInitial = false } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const steps = readJsonLinesFile(transcriptPath);
  const observedMap = getObservedMap(convId);
  let known = knownStatusByConv.get(convId);
  if (!known) {
    known = new Map();
    knownStatusByConv.set(convId, known);
    isInitial = true;
  }

  let observedChanged = false;
  const now = Date.now();

  for (const s of steps) {
    if (s?.type !== 'PLANNER_RESPONSE') continue;
    const idx = Number(s.step_index);
    const status = String(s.status || '');
    const prev = known.get(idx);

    if (!isInitial && status === 'DONE' && prev !== 'DONE' && !observedMap.has(idx)) {
      observedMap.set(idx, now);
      observedChanged = true;
    }
    known.set(idx, status);
  }

  if (observedChanged) {
    persistObservedMap(convId, observedMap);
  }
  return steps;
}

function ensureWatchingConversation(convId, transcriptPath) {
  if (!isValidUuid(convId) || !transcriptPath) return;
  if (watchersByConv.has(convId)) return;

  scanTranscriptForTransitions(convId, transcriptPath, { isInitial: true });

  const state = { watcher: null, timer: null, lastStamp: fileStamp(transcriptPath) };
  const dir = dirname(transcriptPath);
  try {
    if (existsSync(dir)) {
      state.watcher = watch(dir, (_eventType, filename) => {
        if (!filename || filename === 'transcript.jsonl') {
          const nextStamp = fileStamp(transcriptPath);
          if (nextStamp !== state.lastStamp) {
            state.lastStamp = nextStamp;
            scanTranscriptForTransitions(convId, transcriptPath, { isInitial: false });
          }
        }
      });
    }
  } catch {
    // Fallback to timer polling below.
  }

  state.timer = setInterval(() => {
    const nextStamp = fileStamp(transcriptPath);
    if (nextStamp !== state.lastStamp) {
      state.lastStamp = nextStamp;
      scanTranscriptForTransitions(convId, transcriptPath, { isInitial: false });
    }
  }, 350);

  watchersByConv.set(convId, state);
}

// --- Overrides ----------------------------------------------------------------

let overrides = loadJsonFile(OVERRIDES_PATH, {});

function getOverride(convId) {
  return overrides[convId] || {};
}

function setOverride(convId, { modelId, customLimit }) {
  overrides[convId] = {
    modelId: modelId || '',
    customLimit: Number.isFinite(Number(customLimit)) && Number(customLimit) > 0 ? Number(customLimit) : null,
  };
  saveJsonFile(OVERRIDES_PATH, overrides);
  return overrides[convId];
}

// --- Sidecar Server -----------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => {
  return new Response(readFileSync(HTML_PATH, 'utf-8'), {
    contentType: 'text/html; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
  });
});

app.api(
  '/api/conversations',
  async () => {
    await refreshModelCatalog();
    const mergedModels = { ...FALLBACK_MODELS, ...catalogCache };
    const modelsList = Object.entries(mergedModels)
      .map(([id, info]) => ({
        id,
        displayName: info.displayName || id,
        maxTokens: info.maxTokens,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return {
      defaultConversationId: app.config.conversationId || '',
      recent: listRecentConversations(20),
      models: modelsList,
    };
  },
  'GET'
);

app.api(
  '/api/stats',
  async (params) => {
    await refreshModelCatalog();
    let convId = String(params?.conversationId || app.config.conversationId || '').trim();
    if (!isValidUuid(convId)) {
      const recent = listRecentConversations(1);
      convId = recent[0]?.conversationId || '';
    }

    if (!isValidUuid(convId)) {
      return {
        error: 'No active conversation detected yet.',
        conversationId: '',
      };
    }

    const timingPath = join(TIMINGS_DIR, `${convId}.jsonl`);
    const hookEvents = readJsonLinesFile(timingPath);
    const transcriptPath = findTranscriptPath(convId, hookEvents);

    ensureWatchingConversation(convId, transcriptPath);
    const steps = scanTranscriptForTransitions(convId, transcriptPath, { isInitial: false });
    const observedDoneMap = getObservedMap(convId);
    const override = getOverride(convId);

    const metrics = computeConversationMetrics({
      conversationId: convId,
      steps,
      hookEvents,
      observedDoneMap,
      modelCatalog: catalogCache,
      overrideModelId: override.modelId || '',
      customLimit: override.customLimit ?? null,
      nowMs: Date.now(),
    });

    return {
      ...metrics,
      transcriptFound: Boolean(transcriptPath && existsSync(transcriptPath)),
    };
  },
  'GET'
);

app.api(
  '/api/override',
  async (data) => {
    const convId = String(data?.conversationId || app.config.conversationId || '').trim();
    if (!isValidUuid(convId)) {
      return new Response(JSON.stringify({ error: 'Invalid conversationId' }), {
        contentType: 'application/json',
        status: 400,
      });
    }
    const saved = setOverride(convId, {
      modelId: String(data?.modelId || ''),
      customLimit: data?.customLimit,
    });
    return { ok: true, override: saved };
  },
  'POST'
);

function cleanup() {
  for (const state of watchersByConv.values()) {
    try {
      state.watcher?.close();
    } catch {
      // Ignore close error.
    }
    if (state.timer) clearInterval(state.timer);
  }
  watchersByConv.clear();
  app.close().finally(() => process.exit(0));
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

await refreshModelCatalog();
if (isValidUuid(app.config.conversationId)) {
  const hookEvents = readJsonLinesFile(join(TIMINGS_DIR, `${app.config.conversationId}.jsonl`));
  const tp = findTranscriptPath(app.config.conversationId, hookEvents);
  ensureWatchingConversation(app.config.conversationId, tp);
}
await app.run();
