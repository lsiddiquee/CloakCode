#!/usr/bin/env python3
"""
CloakCode research tool: inspect a single session transcript and detect blockers.

VALIDATED 2026-07-08. This is the seed of the extension's live "observer": it normalizes
the on-disk event stream and, crucially, detects the AWAITING-INPUT state that the file
logs do expose — an interactive `tool.execution_start` with no matching
`tool.execution_complete` for its `toolCallId`.

The blocker `arguments` payload carries the full question + options, which is everything
the phone needs to render a multiple-choice prompt and let the user answer remotely.

Usage:
    python3 research/inspect_session.py <session-id-prefix>
    python3 research/inspect_session.py 56514ca7        # partial id ok
"""

import glob
import json
import os
import sys

ROOT = os.path.expanduser("~/.vscode-server/data/User/workspaceStorage")
INTERACTIVE_TOOL_HINTS = ("ask", "question", "confirm", "input", "elicit")


def find_transcript(prefix: str) -> str | None:
    for t in glob.glob(os.path.join(ROOT, "*/GitHub.copilot-chat/transcripts/*.jsonl")):
        if os.path.basename(t)[:-6].startswith(prefix):
            return t
    return None


def inspect(transcript: str) -> None:
    open_tools: dict[str, dict] = {}  # toolCallId -> {name, arguments, ts}
    type_counts: dict[str, int] = {}
    print(f"== transcript: {transcript} ==\n")
    for line in open(transcript):
        if not line.strip():
            continue
        event = json.loads(line)
        etype, data = event.get("type"), event.get("data", {})
        type_counts[etype] = type_counts.get(etype, 0) + 1
        if etype == "tool.execution_start":
            open_tools[data.get("toolCallId")] = {
                "name": data.get("toolName"),
                "arguments": data.get("arguments"),
                "ts": event.get("timestamp"),
            }
        elif etype == "tool.execution_complete":
            open_tools.pop(data.get("toolCallId"), None)

    print("event type counts:")
    for t, n in sorted(type_counts.items(), key=lambda kv: -kv[1]):
        print(f"  {n:6} {t}")

    # Any still-open interactive tool call == the session is blocked awaiting input.
    blockers = [
        (cid, meta)
        for cid, meta in open_tools.items()
        if any(h in str(meta["name"]).lower() for h in INTERACTIVE_TOOL_HINTS)
    ]
    print("\n== blocker detection ==")
    if not blockers:
        print("no open interactive tool call — session is not awaiting input right now")
        return
    for cid, meta in blockers:
        print(f"BLOCKED on {meta['name']} (toolCallId={cid}) since {meta['ts']}")
        print("  question/options payload the phone would render:")
        print("  " + json.dumps(meta["arguments"])[:600])


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    t = find_transcript(sys.argv[1])
    if not t:
        print(f"no transcript found for prefix {sys.argv[1]!r}")
        sys.exit(1)
    inspect(t)


if __name__ == "__main__":
    main()
