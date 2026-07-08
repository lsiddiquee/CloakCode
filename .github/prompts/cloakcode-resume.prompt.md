---
mode: agent
description: Resume CloakCode with full project context (run this first in a fresh session).
---

You are resuming work on **CloakCode** — a local-to-remote bridge to observe and drive GitHub
Copilot from a phone with **zero code-sync to GitHub**. A prior session did the full research
and design; it is all captured in this repo. Do the following before proposing any work:

1. Read, in order:
   - `.github/copilot-instructions.md` (the non-negotiable rules + conventions + Definition of Done)
   - `docs/README.md` (index + fast orientation)
   - `docs/02-research-findings.md` (the empirical record: on-disk transcript observer, the
     **blocker signature**, command-injection/queue findings, and the corrections log)
   - `docs/03-architecture.md` (the `SessionPart` schema + observer/actuator split)
   - `docs/05-roadmap-and-open-questions.md` (what's proven, what's next, open questions Q1–Q5)
   - `docs/06-field-notes.md` (preserved raw working memory — the compressed field log)
   - `research/list_sessions.py` and `research/inspect_session.py` (validated PoCs to port to TS)

2. Then give me a short briefing:
   - One-paragraph recap of where the project stands (status: M0 complete).
   - The capability matrix (what's proven vs. what's left).
   - The concrete plan for **M1** (protocol `SessionPart` + zod, the TS transcript observer
     ported from the Python PoCs, and the localhost bridge WS server with `sessions.list` +
     `session.subscribe`).

3. Do **not** re-run the research or re-derive the on-disk event vocabulary / blocker signature —
   they are already proven in `docs/02`. Respect the package boundaries (only
   `@cloakcode/extension` imports `vscode`) and the TDD/YAGNI/DRY discipline in the instructions.

Wait for my go-ahead before writing code.
