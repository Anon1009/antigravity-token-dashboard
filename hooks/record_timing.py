#!/usr/bin/env python3
"""Lightweight lifecycle hook for recording exact millisecond invocation timing."""

import json
import os
import re
import sys
import time

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def main() -> None:
    event = sys.argv[1] if len(sys.argv) > 1 else "Unknown"
    raw = ""
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}

    conv_id = str(payload.get("conversationId") or "").strip()
    if UUID_RE.match(conv_id):
        plugin_root = os.environ.get("PLUGIN_ROOT") or os.path.dirname(
            os.path.dirname(os.path.abspath(__file__))
        )
        timings_dir = os.path.join(plugin_root, ".data", "timings")
        try:
            os.makedirs(timings_dir, exist_ok=True)
            record = {
                "event": event,
                "tsMs": int(time.time() * 1000),
                "conversationId": conv_id,
                "invocationNum": payload.get("invocationNum"),
                "initialNumSteps": payload.get("initialNumSteps"),
                "executionNum": payload.get("executionNum"),
                "terminationReason": payload.get("terminationReason"),
                "modelName": payload.get("modelName"),
                "transcriptPath": payload.get("transcriptPath"),
            }
            out_path = os.path.join(timings_dir, f"{conv_id}.jsonl")
            with open(out_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception:
            # Never fail or block the agent loop on telemetry I/O errors.
            pass

    if event == "Stop":
        sys.stdout.write(json.dumps({"decision": "stop"}) + "\n")
    else:
        sys.stdout.write("{}\n")


if __name__ == "__main__":
    main()
