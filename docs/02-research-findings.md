# 02 — Research findings

Everything below was established empirically on **2026-07-08** against `copilot-agent`
0.56.0 / VS Code 1.128.0 on a **remote server** setup (`~/.vscode-server`). Findings
include corrections — several first-pass conclusions were wrong and are marked as such,
because the wrong turns are themselves useful.

---

## 1. VS Code API surface

### 1.1 Language Model API — `vscode.lm` (stable, the core enabler)

Custom extensions get consented access to Copilot-backed models:

```ts
const [model] = await vscode.lm.selectChatModels({
  vendor: "copilot",
  family: "gpt-4o",
});
const res = await model.sendRequest(
  [vscode.LanguageModelChatMessage.User(prompt)],
  {},
  token,
);
for await (const chunk of res.text) {
  /* stream */
}
```

- `vscode.lm.selectChatModels(selector)` → enumerate models (`gpt-4o`, `claude-3.5-sonnet`, `o1`, …).
- `LanguageModelChat.sendRequest` → streamed response; `countTokens` for budgeting.
- First use triggers a **native consent dialog** — an auditability feature, not a blocker.
- The Language Model **Tools API** (`vscode.lm.registerTool`, `LanguageModelToolCallPart`) is stable and is what lets us build our own tool-calling loop.

### 1.2 No public API to read Copilot's own in-memory chat session

There is **no** supported API to attach to Copilot's built-in chat session and read its
transcript or inject into it. The chat architecture is one-directional: extensions either
_respond_ (participants) or _provide their own_ sessions.

### 1.3 Chat session provider (proposed — not publishable)

`vscode.proposed.chatSessionsProvider.d.ts` exists (it powers the "Chat Sessions" view /
coding-agent sessions). Relevant types: `ChatSessionItemProvider`,
`ChatSessionItemController` (`createChatSessionItem`, `items` collection),
`ChatSessionContentProvider` (`provideChatSessionContent` returning `ChatSession` with
`history` + `requestHandler`), `ChatSessionStatus` (`InProgress`/`NeedsInput`/…). It lets
you contribute **your own** session type — but:

1. **Proposed API → cannot be published to the Marketplace** (sideload only).
2. The sessions you manage are yours, not Copilot's private ones.

**Conclusion:** the rich remote experience should ride our **own protocol**, not proposed
API. VS Code API only matters for (a) model access (`vscode.lm`, stable) and (b) an
optional later native-UI layer.

---

## 2. On-disk storage map (the big discovery)

Copilot persists chat data **server-side**, reachable by an extension/process in the
container. (A first-pass claim that "transcripts aren't on the server" was **WRONG** — see
§4.1.) Base: `~/.vscode-server/data/User/`.

```text
workspaceStorage/<hash>/GitHub.copilot-chat/
├─ transcripts/<sessionId>.jsonl          ← LIVE, structured, event-sourced transcript
├─ debug-logs/<sessionId>/
│  ├─ main.jsonl                           ← richer: llm_request, agent_response, tool_call, child_session_ref
│  ├─ models.json, system_prompt_0.json, tools_0.json
├─ chat-session-resources/<sessionId>/<toolCallId>/content.txt   ← tool-output blobs
└─ memory-tool/memories/

globalStorage/github.copilot-chat/
├─ session-store.db                        ← SQLite "chronicle" index (see §2.3)
└─ agent-host-config.json                  ← config for the "copilot-agent" agent host
```

### 2.1 The live transcript (`transcripts/<sessionId>.jsonl`)

An **event-sourced, threaded** log written in near-real-time (observed being flushed ~1s
after events). Each line: `{ type, data, id, parentId, timestamp }`.

**Complete event vocabulary** (confirmed across 22 files, ~28k tool events):

| Event                                         | Payload of note                                      |
| --------------------------------------------- | ---------------------------------------------------- |
| `session.start`                               | `sessionId, copilotVersion, vscodeVersion, producer` |
| `user.message`                                | `content, attachments`                               |
| `assistant.turn_start` / `assistant.turn_end` | threaded by `turnId`                                 |
| `assistant.message`                           | `messageId, content, toolRequests, reasoningText`    |
| `tool.execution_start`                        | **`toolCallId, toolName, arguments`**                |
| `tool.execution_complete`                     | **`toolCallId, success`**                            |

`debug-logs/main.jsonl` adds `llm_request`, `agent_response`, `tool_call`, `turn_start/end`,
`child_session_ref`, plus the full `system_prompt_*.json` and `tools_*.json`.

### 2.2 Remote-topology caveat

All transcripts on disk are produced by `producer: "copilot-agent"` (the **agent host**).
In a remote/dev-container setup the interactive chat **UI** lives on the desktop client;
its `workbench.desktop.main.js` (and the UI-only command IDs) are **not** on the server.
The agent-host extension **is** on the server: `.../extensions/copilot/dist/extension.js`
and `.../extensions/copilot/node_modules/@github/copilot/sdk/index.js` — the primary lead
for an actuator (§3.4).

### 2.3 The chronicle DB (`session-store.db`)

SQLite index, tables `sessions / turns / session_files / session_refs / checkpoints /
search_index (fts5)`. It is a **flattened, lagging** index (reindexed from debug logs);
`turns.assistant_response` is plain text and **loses structured parts**. Useful for search,
**not** for live mirroring.

---

## 3. Experiments & verdicts

### 3.1 Command injection (the _actuator_ question)

Using VS Code's command execution (`run_vscode_command`):

| Command                             | Result                                                          |
| ----------------------------------- | --------------------------------------------------------------- |
| `workbench.action.chat.open "text"` | ✅ ungated, but **prefill/queue only** (see below)              |
| `workbench.action.chat.newChat`     | ⚠️ exists but **"preconditions not met"** (`when`-clause gated) |
| `workbench.action.chat.submit`      | ❌ "Failed to find command"                                     |
| `workbench.action.chat.acceptInput` | ❌ "Failed to find command"                                     |

**The key twist (proven):** when injected **while the agent loop was busy**, the prompt was
**queued** and **auto-submitted when the loop finished** — arriving ~4 minutes later as a
genuine `user.message` with **no user action**. So the "submit" gap is filled by the
**runtime queue**, not a submit command.

VS Code chat exposes **three send modes** (from the input send-button):

- **Stop and Send** — interrupt the running loop and send now.
- **Add to Queue** (Alt+Enter) — after the current loop (what happened above).
- **Steer with Message** (Enter) — inject **into** the running loop to redirect it.

→ **"Steer with Message" is the ideal remote blocker-answer / redirect primitive.** Its
command ID is client-side and was not confirmable from the server.

> **Confound warning:** `queue`/`steer`/`interrupt` keyword hits in the logs are mostly
> this investigation's own meta-conversation content + system-prompt text, **not**
> structural events. There is **no** distinct `queued`/`steer` event type; a dispatched
> queued message looks like an ordinary `user.message`.

**Verdict:** command injection is a _viable but non-deterministic_ actuator (stage/queue
works; precise submit/steer control unconfirmed). Owning the loop stays the robust path.

### 3.2 Blocker tracking (the _observer_ question) — the payoff

Deliberately triggering a multiple-choice prompt (`vscode_askQuestions`) produced:

```text
tool.execution_start     13:50:17.410Z   vscode_askQuestions   (arguments = full question+options)
   … 35 s the session waited on the human …
tool.execution_complete  13:50:52.563Z
```

> **BLOCKER SIGNATURE:** a `tool.execution_start` whose `toolName` is interactive
> (`ask`/`question`/`confirm`/`input`/`elicit`) with **no matching
> `tool.execution_complete` for its `toolCallId`** = the session is **awaiting input**.

- **Track:** tail the transcript, match start↔complete by `toolCallId`; an open interactive
  call is the precise awaiting-input state (no timeout heuristics needed).
- **Surface:** the `arguments` payload contains the **entire question + options** (labels,
  descriptions, `recommended`) — everything to render the multiple-choice on the phone.

**Correction:** an earlier scan of 22 historical files found zero confirmation events and
I concluded "the observer is blind to the blocker." That was **WRONG** — those sessions
simply never invoked an interactive tool. Interactive prompts **do** leave a precise,
structured, trackable trace.

**Remaining gap:** a blocker expressed as **plain prose** ending a turn (no tool call)
looks like a normal `assistant.turn_end` and is harder to distinguish.

### 3.3 Remote session list — proven

Enumerating `transcripts/*.jsonl` across all workspaces yields a working session picker
(11 sessions found). Per session: `sessionId`, workspace, title (first `user.message`),
turn count, status, age.

> **Status must use liveness (file mtime), not the last event type** — transcripts often
> end on `assistant.turn_start`, which naively looks "running" even for weeks-dormant
> sessions. `live = mtime < 120s`; `blocked = live + open interactive tool`; else `idle`.

Reproduced by [`research/list_sessions.py`](../research/list_sessions.py) and
[`research/inspect_session.py`](../research/inspect_session.py).

### 3.4 Actuator lead: the `@github/copilot` agent-host SDK

The `copilot` agent-host extension (producer of the transcripts) is on the server and
inspectable: `.../extensions/copilot/dist/{extension.js,cli.js}` and
`.../node_modules/@github/copilot/sdk/index.js`, paired with
`globalStorage/github.copilot-chat/agent-host-config.json`. This SDK is the most promising
surface for a **live steer/input channel** and is the first build-time investigation.

---

## 4. Corrections log (things I got wrong)

- **4.1** "Chat transcripts aren't on the server" → **WRONG.** They are, live and
  structured, under `workspaceStorage/*/GitHub.copilot-chat/transcripts/`. I had only
  checked `chat-session-resources/` + the flattened `session-store.db`.
- **4.2** "Command injection is prefill-only / can't submit" → **INCOMPLETE.** A busy-loop
  injection is **queued and auto-submitted** by the runtime.
- **4.3** "The observer is blind to the blocker" → **WRONG.** Interactive blockers appear
  as unmatched interactive `tool.execution_start`s carrying the full question payload.

---

## 5. Capability matrix (current)

| Capability                            | Status     | Mechanism                                                         |
| ------------------------------------- | ---------- | ----------------------------------------------------------------- |
| List sessions remotely                | ✅ proven  | enumerate `transcripts/*.jsonl` + mtime liveness                  |
| Open/view a session transcript        | ✅ proven  | stream its JSONL (read-only)                                      |
| Track a blocker (multiple-choice)     | ✅ proven  | unmatched interactive `tool.execution_start` by `toolCallId`      |
| Surface the blocker richly            | ✅ proven  | full question+options in event `arguments`                        |
| Access Copilot models                 | ✅ (API)   | `vscode.lm.selectChatModels({vendor:'copilot'})`                  |
| Answer / send to a session            | 🔶 partial | queue-injection works when busy; steer/own-loop for deterministic |
| Resume a dormant (idle) session       | ❌         | needs the session loaded in a live window + actuator              |
| Detect a prose-only blocker (no tool) | ❌         | looks like a normal turn end                                      |

**Bottom line:** the entire **read/observe half is proven** and works for stock Copilot
sessions with no proposed API and without owning the loop. The remaining work is the
**actuator** (answering/steering), for which owning the loop is the deterministic path and
the `@github/copilot` SDK is the lead to prototype a lighter-weight alternative.
