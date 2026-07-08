# 06 — Field notes (preserved working memory)

> Raw, terse working notes from the 2026-07-08 investigation, preserved verbatim-ish so
> nothing is lost if the assistant's memory store does not travel between machines/containers.
> The narrative versions live in [02-research-findings.md](02-research-findings.md); this is the
> compressed field log. Environment when captured: `copilot-agent` 0.56.0, VS Code 1.128.0,
> remote server (`~/.vscode-server`).

## Goal & requirements (evolved)

- Local-to-remote bridge to drive Copilot from a phone/desktop with **ZERO code-sync to GitHub**.
- Main client = phone (React PWA), sometimes another desktop. Terminal client rejected.
- Not just send prompts: **mirror the whole chat session live**, rich rendering like Copilot Chat
  (expandable sections, tool cards, multiple-choice confirmation prompts).
- Core pain: a long agent flow stalls on an unexpected blocker/confirmation; user must **see it
  and answer it remotely**.

## Where Copilot chat lives on disk (VERIFIED)

Base: `~/.vscode-server/data/User/`

- `workspaceStorage/<hash>/GitHub.copilot-chat/`
  - `transcripts/<sessionId>.jsonl` — **LIVE** event-sourced transcript (written ~1s realtime).
    Events: `session.start`, `user.message`, `assistant.turn_start/message/turn_end` (threaded by
    `turnId`), `tool.execution_start{toolCallId,toolName,arguments}`,
    `tool.execution_complete{toolCallId,success}`.
  - `debug-logs/<sessionId>/main.jsonl` — richer: `llm_request`, `agent_response`, `tool_call`,
    `turn_start/end`, `child_session_ref`, + `models.json`, `system_prompt_0.json`, `tools_0.json`.
  - `chat-session-resources/<sessionId>/<toolCallId>/content.txt` — tool output blobs.
- `globalStorage/github.copilot-chat/session-store.db` — SQLite "chronicle" index (tables
  `sessions/turns/session_files/session_refs/checkpoints/search_index` fts5). FLATTENED text, lags
  (reindexed from debug logs), **NOT live**. `turns.assistant_response` is plain text (loses
  structured parts).

## Key conclusions

- **READ/mirror:** strongly feasible + universal. Tail `transcripts/*.jsonl` in the devcontainer →
  normalize → stream to phone. Works even for **stock** Copilot sessions. No proposed API needed.
- Correction to earlier wrong assumption: transcript **IS** on the server/remote side and IS
  live + structured.
- **ANSWER the blocker:** not possible via files (append-only sink). Needs a live input hook: own
  the agent loop (`vscode.lm`) OR command injection OR the agent-host input channel
  (`globalStorage/agent-host-config.json`, producer `copilot-agent`).

## Experiments run (2026-07-08)

1. **Command injection (actuator) — partially viable (revised twice):**
   - `workbench.action.chat.open "text"`: ungated. If loop is **BUSY** → message is **QUEUED** and
     **auto-submitted** when the loop finishes (PROVEN: injected marker dispatched ~4 min later as a
     normal `user.message` with no user action; user confirmed it queued). If idle → prefill sits in
     the input box.
   - The "submit" gap is filled by the **runtime queue**, not a submit command.
   - `workbench.action.chat.newChat`: exists but "preconditions not met" (when-clause gated).
   - `workbench.action.chat.submit` AND `.acceptInput`: "Failed to find command".
   - 3 native SEND MODES: **Stop and Send** (interrupt now), **Add to Queue** (Alt+Enter, after
     loop), **Steer with Message** (Enter, inject INTO running loop / redirect). "Steer with Message"
     is the ideal remote blocker-answer / redirect primitive. Command IDs client-side, unverified.
   - CONFOUND WARNING: queue/steer/interrupt keyword hits in logs are mostly meta-conversation +
     system-prompt text, NOT structural events. No distinct `queued`/`steer` event type.

2. **Blocker tracking — CORRECTED: blockers ARE trackable when they go through a TOOL:**
   - Triggered `vscode_askQuestions` → `tool.execution_start {toolName, arguments:{full question +
     options + labels + descriptions + recommended}}` at T0, `tool.execution_complete` 35 s later.
   - **BLOCKER SIGNATURE:** a `tool.execution_start` whose `toolName` is interactive
     (`ask/question/confirm/input/elicit`) with no matching `tool.execution_complete` for its
     `toolCallId` yet = session AWAITING INPUT. Match by `toolCallId`.
   - SURFACE: the `arguments` payload carries the entire question + options → renders richly on phone.
   - Earlier "observer blind" was WRONG: the 22 historical files simply never invoked an interactive
     tool.
   - REMAINING GAP: a plain-prose blocker ending a turn (no tool) looks like normal
     `assistant.turn_end` — harder to distinguish. Answering still needs the actuator.

3. **Remote session list — WORKS (pure read, no proposed API, stock sessions):**
   - Enumerate `workspaceStorage/*/GitHub.copilot-chat/transcripts/*.jsonl` across ALL workspaces.
   - Per session: `sessionId`, workspace, title (first `user.message`), turns, status, age.
   - STATUS must use **liveness = file mtime** (NOT last event type — transcripts often end on
     `assistant.turn_start` giving a false RUNNING). `live = mtime < 120s` → active; live + open
     interactive tool → blocked; else idle.
   - Demo: 11 sessions found; only the current one active, rest idle 22–52 d.
   - Opening/viewing remotely = stream its JSONL (read-only). Resuming/sending to an IDLE session
     needs it loaded in a live VS Code window + the actuator; can't resume a dormant agent from files.

## Net architecture conclusion

- **ACTUATOR:** command injection is more viable than first thought — `chat.open` during a busy loop
  queues + submits; "Steer with Message" could answer/redirect a running flow. Send-mode control
  unverified. Owning the loop stays the most robust/deterministic path; injection + queue + steer is
  a promising lighter-weight alternative.
- **OBSERVER:** file-tailing gives a read mirror but cannot see/relay confirmations directly beyond
  the tool-based blocker signature. Reading and answering are separate problems.
- No public API to read Copilot's own in-memory chat session (`vscode.lm` is stable model access).

## Open follow-ups (see 05 for Q1–Q5)

- Steer / Stop-and-Send command IDs (client-side `workbench.desktop.main.js`).
- The `@github/copilot` agent-host SDK input/steer channel.
- Prose-only blocker detection; whether UI tool-approval confirmations log like `vscode_askQuestions`.
