#!/usr/bin/env python3
"""
CloakCode research tool: list all on-disk Copilot chat sessions.

VALIDATED 2026-07-08 against copilot-agent 0.56.0 / VS Code 1.128.0 (remote server).
This is the seed of the extension's "remote session list" capability. It enumerates
every session transcript across all workspaces and derives title, turn count, liveness
status and age — exactly what the phone's session picker needs.

Key lesson baked in: STATUS must come from file mtime (liveness), NOT the last event
type. Transcripts frequently end on `assistant.turn_start`, which naively looks like
"running" even for sessions dormant for weeks.

Usage:  python3 research/list_sessions.py
"""

import glob
import json
import os
import time

ROOT = os.path.expanduser("~/.vscode-server/data/User/workspaceStorage")
INTERACTIVE_TOOL_HINTS = ("ask", "question", "confirm", "input", "elicit")
LIVE_WINDOW_SECONDS = 120


def workspace_name(hash_dir: str) -> str:
    """Resolve a workspace hash to its folder name via workspace.json, else the hash."""
    p = os.path.join(ROOT, hash_dir, "workspace.json")
    if os.path.exists(p):
        try:
            with open(p) as f:
                folder: str = json.load(f).get("folder", "")
            return os.path.basename(folder.rstrip("/")) or folder[:16]
        except Exception:
            pass
    return hash_dir[:8]


def scan() -> list[dict]:
    now = time.time()
    rows: list[dict] = []
    pattern = os.path.join(ROOT, "*/GitHub.copilot-chat/transcripts/*.jsonl")
    for transcript in glob.glob(pattern):
        hash_dir = transcript.split("/workspaceStorage/")[1].split("/")[0]
        session_id = os.path.basename(transcript)[:-6]
        title, turns, open_tools = "", 0, {}
        try:
            with open(transcript) as fh:
                for line in fh:
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    etype, data = event.get("type"), event.get("data", {})
                    if etype == "user.message":
                        turns += 1
                        if not title:
                            title = (data.get("content") or "").replace("\n", " ").strip()[:60]
                    elif etype == "tool.execution_start":
                        open_tools[data.get("toolCallId")] = data.get("toolName")
                    elif etype == "tool.execution_complete":
                        open_tools.pop(data.get("toolCallId"), None)
        except Exception:
            continue

        idle = now - os.path.getmtime(transcript)
        live = idle < LIVE_WINDOW_SECONDS
        # BLOCKER SIGNATURE: an interactive tool.execution_start with no matching complete.
        blocked = live and any(
            any(h in str(name).lower() for h in INTERACTIVE_TOOL_HINTS)
            for name in open_tools.values()
        )
        status = "blocked" if blocked else ("active" if live else "idle")
        rows.append(
            {
                "mtime": os.path.getmtime(transcript),
                "workspace": workspace_name(hash_dir),
                "session_id": session_id,
                "turns": turns,
                "status": status,
                "idle_seconds": int(idle),
                "title": title or "(no user message)",
            }
        )
    rows.sort(key=lambda r: r["mtime"], reverse=True)
    return rows


def human_age(seconds: int) -> str:
    if seconds > 86400:
        return f"{seconds // 86400}d"
    if seconds > 3600:
        return f"{seconds // 3600}h"
    return f"{seconds // 60}m"


def main() -> None:
    rows = scan()
    print(f'{"#":>2}  {"WORKSPACE":14} {"SESSION":36} {"TURNS":>5} {"STATUS":8} {"AGE":>4}  TITLE')
    print("-" * 120)
    for i, r in enumerate(rows, 1):
        print(
            f'{i:>2}  {r["workspace"][:14]:14} {r["session_id"]:36} '
            f'{r["turns"]:>5} {r["status"]:8} {human_age(r["idle_seconds"]):>4}  {r["title"]}'
        )
    print(f"\n{len(rows)} sessions total")


if __name__ == "__main__":
    main()
