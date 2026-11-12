# Antigravity Token Dashboard

A 100% local, zero-dependency **Sidecar UI plugin** for **Google Antigravity 2.0** that renders a real-time AI telemetry dashboard in the right-side auxiliary pane.

一款专为 **Antigravity 2.0** 打造的完全本地化、零外部依赖 **官方 Sidecar 右侧辅助面板插件**，用于实时监控对话中的模型输出速度与 Token 消耗。

## Features / 核心功能

- **Live Output Speed (`tok/s`) / 实时输出速度**：Combines official lifecycle hooks (`PreInvocation`, `Stop`) and live `transcript.jsonl` file watching to compute per-call, session-average, and peak `tok/s` (including thinking and TTFT latency), with transparent timing source badges.
- **Prompt Cache Hit Rate (`%`) / 缓存命中率**：Tracks both latest-call and cumulative `cache_read_tokens / (input_tokens + cache_read_tokens)`.
- **Conversation Token Totals / 对话总 Token**：Displays cumulative token usage broken down by net input, cache read, and output tokens, alongside user turns and model call counts.
- **Context Window Usage (`%`) / 上下文占比**：Reads exact prompt context length from the latest model call and resolves model window limits via `GetAvailableModels` (with manual model override support).
- **Interactive Charts & Call Breakdown / 趋势图表与明细**：Switchable SVG trend charts (`tok/s`, `Context %`, `Cache %`) and a per-step call breakdown table, automatically synced to Antigravity's light/dark theme.

## Installation / 安装方式

Requires **Antigravity 2.0** and **Python 3** (`/usr/bin/python3` on macOS, or `python3` in `PATH`).

```bash
git clone https://github.com/Anon1009/antigravity-token-dashboard.git ~/.gemini/config/plugins/token-dashboard
```

After cloning:
1. Restart Antigravity (or toggle **Token Dashboard** off and on under **Customizations → Installed**).
2. Open **Token Dashboard** from the right-side auxiliary pane.

## How It Works / 实现原理

- **Hooks (`hooks.json` + `hooks/record_timing.py`)**: Records millisecond timestamps on `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop` into `.data/timings/<conversationId>.jsonl` without altering tool permissions or injecting prompts.
- **Sidecar (`sidecars/token_dashboard/`)**: Uses Antigravity's built-in `sidecar_sdk` (`SidecarApp`) to watch `transcript.jsonl` in real time, query model context limits via `GetAvailableModels`, and serve the dashboard UI.
- **Privacy**: Everything runs locally on `127.0.0.1`. No data is sent to any external server.

## License

[MIT](./LICENSE)
