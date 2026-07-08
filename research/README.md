# CloakCode research scripts

Validated, working proofs-of-concept from the 2026-07-08 investigation. These are the
**seeds** of the extension's observer/session-list capabilities — kept as runnable
reference (Python, zero deps) so the empirically-confirmed behaviour is never lost.

> Environment when validated: `copilot-agent` 0.56.0, VS Code 1.128.0, remote server
> (`~/.vscode-server`). Paths assume that layout.

| Script | What it proves / does |
|---|---|
| [`list_sessions.py`](list_sessions.py) | Enumerates every on-disk chat session across all workspaces with title, turn count, liveness status and age. The remote **session picker** in miniature. |
| [`inspect_session.py`](inspect_session.py) | Normalizes one session's event stream and detects the **awaiting-input / blocker** state via the unmatched interactive `tool.execution_start` signature, printing the exact question+options payload the phone would render. |

Run:

```bash
python3 research/list_sessions.py
python3 research/inspect_session.py 56514ca7
```

See [../docs/02-research-findings.md](../docs/02-research-findings.md) for the full
account of what these scripts demonstrated and the corrections made along the way.
