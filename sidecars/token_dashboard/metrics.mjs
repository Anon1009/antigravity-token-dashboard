import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FALLBACK_MODELS = {
  'gemini-4-hydrogen-xhigh': { displayName: 'Gemini 4 Hydrogen (XHigh)', maxTokens: 1048576 },
  'gemini-4-hydrogen-high': { displayName: 'Gemini 4 Hydrogen (High)', maxTokens: 1048576 },
  'gemini-4-hydrogen-medium': { displayName: 'Gemini 4 Hydrogen (Medium)', maxTokens: 1048576 },
  'gemini-4-hydrogen-low': { displayName: 'Gemini 4 Hydrogen (Low)', maxTokens: 1048576 },
  'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', maxTokens: 1048576 },
  'gemini-4-argon-medium': { displayName: 'Gemini 4 Argon (Medium)', maxTokens: 1048576 },
  'gemini-4-argon-low': { displayName: 'Gemini 4 Argon (Low)', maxTokens: 1048576 },
  'gemini-4-carbon-disabled': { displayName: 'Gemini 4 Carbon', maxTokens: 1048576 },
  'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', maxTokens: 1048576 },
  'gemini-3.8-flash-medium': { displayName: 'Gemini 3.8 Flash (Medium)', maxTokens: 1048576 },
  'gemini-3.8-flash-low': { displayName: 'Gemini 3.8 Flash (Low)', maxTokens: 1048576 },
  'gemini-3-flash': { displayName: 'Gemini 3 Flash', maxTokens: 1048576 },
  'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', maxTokens: 1048576 },
  'gemini-2.5-flash': { displayName: 'Gemini 2.5 Flash', maxTokens: 1048576 },
  'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', maxTokens: 1000000 },
  'claude-opus-5-5-medium': { displayName: 'Claude Opus 5.5 (Medium)', maxTokens: 1000000 },
  'claude-opus-5-5-low': { displayName: 'Claude Opus 5.5 (Low)', maxTokens: 1000000 },
  'claude-sonnet-5-5-high': { displayName: 'Claude Sonnet 5.5 (High)', maxTokens: 1000000 },
  'claude-sonnet-5-5-medium': { displayName: 'Claude Sonnet 5.5 (Medium)', maxTokens: 1000000 },
  'claude-sonnet-5-5-low': { displayName: 'Claude Sonnet 5.5 (Low)', maxTokens: 1000000 },
  'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072 },
};

export const DEFAULT_CONTEXT_LIMIT = 1048576;

export function isValidUuid(id) {
  return typeof id === 'string' && UUID_RE.test(id.trim());
}

export function getAppDataDir() {
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    return process.env.ANTIGRAVITY_APP_DATA_DIR;
  }
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
  return join(geminiDir, 'antigravity');
}

export function getGeminiDir() {
  return process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
}

export function parseJsonLines(raw) {
  if (!raw) return [];
  const items = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      // Ignore partial line currently being flushed.
    }
  }
  return items;
}

export function readJsonLinesFile(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    return parseJsonLines(readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

export function findTranscriptPath(conversationId, hookEvents = []) {
  if (!isValidUuid(conversationId)) return null;

  for (let i = hookEvents.length - 1; i >= 0; i -= 1) {
    const p = hookEvents[i]?.transcriptPath;
    if (typeof p === 'string' && p && existsSync(p)) {
      return p;
    }
  }

  const appDataDir = getAppDataDir();
  const geminiDir = getGeminiDir();
  const candidates = [
    join(appDataDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl'),
    join(geminiDir, 'antigravity', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl'),
    join(geminiDir, 'antigravity-ide', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl'),
    join(geminiDir, 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export function listRecentConversations(limit = 20) {
  const brainDir = join(getAppDataDir(), 'brain');
  if (!existsSync(brainDir)) return [];

  const entries = [];
  try {
    for (const dirent of readdirSync(brainDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !isValidUuid(dirent.name)) continue;
      const transcriptPath = join(brainDir, dirent.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(transcriptPath)) continue;
      try {
        const st = statSync(transcriptPath);
        entries.push({
          conversationId: dirent.name,
          updatedAtMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        // Ignore transient stat error.
      }
    }
  } catch {
    return [];
  }

  entries.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return entries.slice(0, limit);
}

export function parseIsoMs(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function resolveModelInfo({ hookEvents, catalog, overrideModelId, customLimit }) {
  const merged = { ...FALLBACK_MODELS, ...(catalog || {}) };

  if (Number.isFinite(customLimit) && customLimit > 0) {
    return {
      modelId: overrideModelId || 'custom',
      displayName: merged[overrideModelId]?.displayName || `Custom (${customLimit.toLocaleString()})`,
      maxTokens: customLimit,
      source: 'manual',
    };
  }

  if (overrideModelId && merged[overrideModelId]) {
    return {
      modelId: overrideModelId,
      displayName: merged[overrideModelId].displayName || overrideModelId,
      maxTokens: merged[overrideModelId].maxTokens,
      source: 'manual',
    };
  }

  let detected = '';
  for (let i = hookEvents.length - 1; i >= 0; i -= 1) {
    const m = String(hookEvents[i]?.modelName || '').trim();
    if (m && m.toLowerCase() !== 'auto') {
      detected = m;
      break;
    }
  }

  if (detected && merged[detected]) {
    return {
      modelId: detected,
      displayName: merged[detected].displayName || detected,
      maxTokens: merged[detected].maxTokens,
      source: 'hook+catalog',
    };
  }

  return {
    modelId: detected || 'auto',
    displayName: detected ? `${detected} (默认上限)` : '默认窗口 (1M)',
    maxTokens: DEFAULT_CONTEXT_LIMIT,
    source: 'default',
  };
}

function matchPreInvocations(plannerSteps, preInvocations) {
  const matched = new Map();
  if (!preInvocations.length || !plannerSteps.length) return matched;

  for (let k = 0; k < preInvocations.length; k += 1) {
    const pre = preInvocations[k];
    const startIdx = Number.isFinite(Number(pre.initialNumSteps))
      ? Number(pre.initialNumSteps)
      : 0;
    const nextPre = preInvocations[k + 1];
    const endIdx = nextPre && Number.isFinite(Number(nextPre.initialNumSteps))
      ? Number(nextPre.initialNumSteps)
      : Number.POSITIVE_INFINITY;

    const candidate = plannerSteps.find(
      (s) => s.step_index >= startIdx && s.step_index < endIdx && !matched.has(s.step_index)
    );
    if (candidate) {
      matched.set(candidate.step_index, pre);
    }
  }
  return matched;
}

export function computeConversationMetrics({
  conversationId,
  steps = [],
  hookEvents = [],
  observedDoneMap = new Map(),
  modelCatalog = {},
  overrideModelId = '',
  customLimit = null,
  nowMs = Date.now(),
}) {
  const orderedSteps = [...steps].sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));
  const sortedHooks = [...hookEvents].sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));

  const preInvocations = sortedHooks.filter((e) => e.event === 'PreInvocation');
  const stopEvents = sortedHooks.filter((e) => e.event === 'Stop');

  const userTurns = orderedSteps.filter((s) => s.type === 'USER_INPUT').length;
  const plannerSteps = orderedSteps.filter((s) => s.type === 'PLANNER_RESPONSE');
  const preMatchMap = matchPreInvocations(plannerSteps, preInvocations);

  let totalNetInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let measuredOutput = 0;
  let measuredDurationMs = 0;
  let peakTokPerSec = null;

  const history = [];

  for (let idx = 0; idx < plannerSteps.length; idx += 1) {
    const step = plannerSteps[idx];
    const stepIndex = Number(step.step_index ?? idx);
    const inputTokens = Number(step.input_tokens || 0);
    const cacheReadTokens = Number(step.cache_read_tokens || 0);
    const outputTokens = Number(step.output_tokens || 0);
    const promptTokens = inputTokens + cacheReadTokens;
    const cacheHitRate = promptTokens > 0 ? (cacheReadTokens / promptTokens) * 100 : null;

    totalNetInput += inputTokens;
    totalCacheRead += cacheReadTokens;
    totalOutput += outputTokens;

    const preHook = preMatchMap.get(stepIndex);
    const createdAtMs = parseIsoMs(step.created_at);
    const startMs = preHook?.tsMs ?? createdAtMs;
    const hasHookStart = Boolean(preHook?.tsMs);

    const nextPlanner = plannerSteps[idx + 1];
    const nextUser = orderedSteps.find(
      (s) => s.step_index > stepIndex && s.type === 'USER_INPUT'
    );
    const boundaryStepIdx = Math.min(
      nextPlanner ? nextPlanner.step_index : Number.POSITIVE_INFINITY,
      nextUser ? nextUser.step_index : Number.POSITIVE_INFINITY
    );

    const nextPre = preInvocations.find((e) => e.tsMs > (startMs ?? 0));
    const isFinalBeforeStopBoundary = boundaryStepIdx === (nextUser ? nextUser.step_index : Number.POSITIVE_INFINITY);

    let endMs = null;
    let timingQuality = 'unmeasured';

    // 1. Exact Stop hook right after this final response (before any next PreInvocation).
    if (startMs != null && (idx === plannerSteps.length - 1 || isFinalBeforeStopBoundary)) {
      const stop = stopEvents.find(
        (e) => e.tsMs >= startMs && (!nextPre || e.tsMs <= nextPre.tsMs)
      );
      if (stop) {
        endMs = stop.tsMs;
        timingQuality = hasHookStart ? 'hook' : 'watch';
      }
    }

    // 2. Live watcher timestamp captured when this step transitioned to DONE.
    if (endMs == null && startMs != null && observedDoneMap.has(stepIndex)) {
      const watchedMs = observedDoneMap.get(stepIndex);
      if (watchedMs >= startMs) {
        endMs = watchedMs;
        timingQuality = hasHookStart ? 'hook+watch' : 'watch';
      }
    }

    // 3. Fallback for historical tool-calling responses: next GENERIC tool step creation time.
    if (endMs == null && startMs != null) {
      const firstToolStep = orderedSteps.find(
        (s) =>
          s.step_index > stepIndex &&
          s.step_index < boundaryStepIdx &&
          s.type === 'GENERIC'
      );
      const toolCreatedMs = parseIsoMs(firstToolStep?.created_at);
      if (toolCreatedMs != null && toolCreatedMs - startMs >= 1000 && toolCreatedMs - startMs <= 600000) {
        endMs = toolCreatedMs;
        timingQuality = 'estimated';
      }
    }

    let durationMs = null;
    let tokPerSec = null;
    if (startMs != null && endMs != null && step.status === 'DONE') {
      const rawDt = endMs - startMs;
      if (rawDt >= 50 && rawDt <= 600000) {
        durationMs = rawDt;
        if (outputTokens > 0) {
          tokPerSec = outputTokens / (durationMs / 1000);
          measuredOutput += outputTokens;
          measuredDurationMs += durationMs;
          if (peakTokPerSec == null || tokPerSec > peakTokPerSec) {
            peakTokPerSec = tokPerSec;
          }
        }
      }
    }

    history.push({
      stepIndex,
      status: step.status || 'UNKNOWN',
      createdAt: step.created_at || null,
      inputTokens,
      cacheReadTokens,
      promptTokens,
      outputTokens,
      totalTokens: promptTokens + outputTokens,
      cacheHitRate,
      durationMs,
      tokPerSec,
      timingQuality,
    });
  }

  // Detect whether an invocation is currently in flight.
  const latestPre = preInvocations[preInvocations.length - 1];
  const latestStop = stopEvents[stopEvents.length - 1];
  const latestPlanner = plannerSteps[plannerSteps.length - 1];
  const latestPlannerHasDone =
    latestPlanner &&
    latestPre &&
    Number(latestPlanner.step_index) >= Number(latestPre.initialNumSteps ?? 0) &&
    latestPlanner.status === 'DONE';

  const hasRunningPlanner = plannerSteps.some((s) => s.status === 'RUNNING');
  const hookGenerating =
    Boolean(latestPre) &&
    (!latestStop || latestPre.tsMs > latestStop.tsMs) &&
    !latestPlannerHasDone;

  const activeStartMs = hookGenerating
    ? latestPre.tsMs
    : hasRunningPlanner
      ? parseIsoMs(plannerSteps.find((s) => s.status === 'RUNNING')?.created_at)
      : null;

  const generating = Boolean(hookGenerating || hasRunningPlanner);
  const activeElapsedMs = generating && activeStartMs != null ? Math.max(0, nowMs - activeStartMs) : 0;

  const measuredEntries = history.filter((h) => h.tokPerSec != null);
  const latestMeasured = measuredEntries[measuredEntries.length - 1] || null;
  const lastStep = history[history.length - 1] || null;

  const totalPromptTokens = totalNetInput + totalCacheRead;
  const sessionCacheHitRate =
    totalPromptTokens > 0 ? (totalCacheRead / totalPromptTokens) * 100 : null;

  const modelInfo = resolveModelInfo({
    hookEvents: sortedHooks,
    catalog: modelCatalog,
    overrideModelId,
    customLimit,
  });

  const currentContextTokens = lastStep ? lastStep.promptTokens : 0;
  const projectedNextTokens = lastStep ? lastStep.promptTokens + lastStep.outputTokens : 0;
  const contextPercent =
    modelInfo.maxTokens > 0 ? (currentContextTokens / modelInfo.maxTokens) * 100 : 0;
  const projectedPercent =
    modelInfo.maxTokens > 0 ? (projectedNextTokens / modelInfo.maxTokens) * 100 : 0;

  return {
    conversationId,
    updatedAtMs: nowMs,
    generating,
    activeElapsedMs,
    hookActive: sortedHooks.length > 0,
    hookEventsCount: sortedHooks.length,
    model: modelInfo,
    speed: {
      latestTokPerSec: latestMeasured?.tokPerSec ?? null,
      latestDurationMs: latestMeasured?.durationMs ?? null,
      latestOutputTokens: latestMeasured?.outputTokens ?? null,
      latestTimingQuality: latestMeasured?.timingQuality ?? 'unmeasured',
      latestStepIndex: latestMeasured?.stepIndex ?? null,
      avgTokPerSec:
        measuredDurationMs > 0 && measuredOutput > 0
          ? measuredOutput / (measuredDurationMs / 1000)
          : null,
      peakTokPerSec,
      measuredCalls: measuredEntries.length,
      totalCalls: history.length,
    },
    cache: {
      latestHitRate: lastStep?.cacheHitRate ?? null,
      latestCacheRead: lastStep?.cacheReadTokens ?? 0,
      latestNetInput: lastStep?.inputTokens ?? 0,
      sessionHitRate: sessionCacheHitRate,
      totalCacheRead,
      totalNetInput,
    },
    totals: {
      totalAllTokens: totalPromptTokens + totalOutput,
      totalNetInput,
      totalCacheRead,
      totalPromptTokens,
      totalOutput,
      userTurns,
      plannerCalls: history.length,
    },
    context: {
      currentTokens: currentContextTokens,
      projectedNextTokens,
      limitTokens: modelInfo.maxTokens,
      percent: contextPercent,
      projectedPercent,
    },
    history,
  };
}
