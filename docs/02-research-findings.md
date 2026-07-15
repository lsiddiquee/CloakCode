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
§4.1.) Base: `~/.vscode-server/data/User/`. _Two later refinements: the transcript is
**incomplete for editor-hosted** sessions (§4.10, so the **debug-log is now primary**), and
VS Code's authoritative `ChatModel` (title + full conversation) is **client-side**, not on the
server at all (§4.11)._

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
| `tool.execution_complete`                     | **`toolCallId, success, result?: { content }`**      |

`debug-logs/main.jsonl` adds `llm_request`, `agent_response`, `tool_call`, `turn_start/end`,
`child_session_ref`, plus the full `system_prompt_*.json` and `tools_*.json`.

> **The transcript is not always complete (§4.10).** For **editor-hosted** sessions it records
> only `assistant.turn_start` (no assistant message/turn_end). The **debug-log** is complete for
> both panel and editor hosting, so it is the observer's **primary** source, with the transcript
> as the zero-config fallback. Debug-logging is gated by
> `github.copilot.chat.agentDebugLog.fileLogging.enabled` (default false, **experiment-gated**; §4.25).

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

### 3.5 The Hooks feature — the supported observe + actuate seam

Copilot Chat ships a **documented, JSON-configured Hooks feature**
(<https://code.visualstudio.com/docs/copilot/customization/hooks>; source
`src/platform/chat/common/{chatHookService,hookCommandTypes}.ts`). Hooks are **external
commands** (not extension code) registered in `.github/hooks/*.json` (team) or
`~/.claude/settings.json` (user), fired at lifecycle points — `SessionStart`,
`UserPromptSubmit`, **`PreToolUse`**, `PostToolUse`, `PreCompact`, `SubagentStart/Stop`,
`Stop`, `ErrorOccurred` — with **JSON on stdin → JSON on stdout**.

- **`PreToolUse`** receives `{ tool_name, tool_input, tool_use_id }` and returns
  `hookSpecificOutput.permissionDecision = allow | ask | deny` (+ reason / `updatedInput` /
  `additionalContext`); exit code 2 blocks. This is a **supported remote tool-approval seam** —
  the hook hands CloakCode the full payload, waits for the phone, and returns the decision.
- **The transcript is flushed to disk _before_ each hook runs**, so a hook fires with a fresh
  on-disk transcript — hooks compose cleanly with the read-only observer.
- **Caveats:** a long-blocking hook is an "anti-pattern" — wait N seconds for the phone, else
  return `ask` (fall back to the native prompt); a **prose-only** blocker with no tool call is
  still missed (same gap as §3.2); requires a Copilot Chat recent enough to support hooks.

This is the basis for the live-pending notifier + remote approval (design in docs/03 §M3,
security in docs/04). It needs **no proposed API** (`chatHooks@6` is used by Copilot itself,
not by hook authors), which is why the extension is an optional convenience, not a core
dependency of the actuator.

### 3.6 Observer liveness ceiling (message-granular, not token-live)

From `sessionTranscriptService.ts`: transcript entries are **buffered in memory** and written
only on **`flush()`**, which fires at **discrete points** (turn boundaries, tool start/complete,
and before every hook) — **not** continuously. `assistant.message` is a **single entry with the
full `content`** (no partial/streaming entry). The `debug-logs/main.jsonl` copy has its own
timer (`github.copilot.chat.agentDebugLog.fileLogging.flushIntervalMs`, default 4000 ms; §4.25).

**Consequence:** a file observer **cannot token-stream**; its ceiling is **message-granular** —
user message appears → (silence while the assistant generates) → the whole assistant message
appears on flush → tool cards update on start/complete. To feel more live without owning the
loop: the hybrid `fs.watch` + short mtime-poll follower catches flushes sub-second, and a no-op
flush-forcing hook makes tool cards real-time. **Token-live** requires owning the `vscode.lm`
loop (opt-in "live chat", docs/05).

---

## 4. Corrections log (things I got wrong)

- **4.1** "Chat transcripts aren't on the server" → **WRONG.** They are, live and
  structured, under `workspaceStorage/*/GitHub.copilot-chat/transcripts/`. I had only
  checked `chat-session-resources/` + the flattened `session-store.db`.
- **4.2** "Command injection is prefill-only / can't submit" → **INCOMPLETE.** A busy-loop
  injection is **queued and auto-submitted** by the runtime.
- **4.3** "The observer is blind to the blocker" → **WRONG.** Interactive blockers appear
  as unmatched interactive `tool.execution_start`s carrying the full question payload.
- **4.4** "The actuator is unsolved / needs owning the loop" → **SUPERSEDED.** Copilot Chat
  runs Claude-compatible **hooks** (`.github/hooks/*.json`). A `PreToolUse` hook that returns
  `permissionDecision: allow|deny` **deterministically drives tool approval** — no proposed
  API, no owned loop. Verified 2026-07-09 by probe (`.local/hook-probe/`, gitignored).
  - _A hook returning `allow` **bypasses VS Code's native approval entirely** — it
    auto-approves regardless of the user's "bypass approvals" setting. To stay a pure
    observer the hook must emit **no `permissionDecision`** (empty `{}`), which defers to VS
    Code. (Bit us in testing: an `allow`-returning probe silently auto-approved everything.)_
- **4.5** "A slow hook will be killed quickly / can't block for a human" → **WRONG.** A
  blocking `PreToolUse` hook holds the tool call **synchronously** for its full sleep and
  Copilot does **not** proceed early. Probed 2026-07-09: 15s and 90s sleeps both ran to
  completion (`post-sleep` line always written; `slept_ms` ≈ configured), well under the hook
  `timeout: 300`. This makes a blocking hook a viable **pause-and-route**: hold the tool
  server-side, fetch an answer from the phone, then release. (Over-`timeout` kill behaviour
  not yet probed — not a blocker: the local surface is always a graceful fallback.)
- **4.6** "4.3 — a live _pending_ interactive blocker is visible on disk" → **REFINED / mostly
  WRONG.** Verified 2026-07-09 by a side-by-side probe while a `vscode_askQuestions` picker
  was on screen **unanswered**: its `tool.execution_start` was **not yet on disk** — Copilot
  buffers the turn and flushes `start`+`complete` **together at answer time** (the transcript
  ended at `assistant.turn_start`). The on-disk start's _timestamp_ reflects when the picker
  appeared, but the _write_ happens at completion. So for a **live, pending** blocker the
  transcript observer is a **lagging** indicator and cannot surface it — 4.3 held only
  post-hoc / for a frozen session. In the same instant the **`PreToolUse` hook had the full
  `questions[]` payload**. _Implication: the live-blocker notifier (the AFK-answer core)
  **requires the hook**; transcript parsing alone cannot do it. The hook is non-intrusive —
  it emits no `permissionDecision`, so local VS Code drives the prompt unchanged._
- **4.7** "one remote channel answers any blocker" → **SPLIT (verified 2026-07-09 by manual
  test).** The two blocker classes need **different, non-interchangeable** answer channels:
  - _A submitted **chat message answers a `vscode_askQuestions`**_ — the agent interprets the
    freeform text as the answer and continues (screenshot: typing the file name + "overwrite"
    resolved the picker and the flow proceeded). So questions ← **injected text**, not the hook
    (hook `allow` on a question only lets the picker _show_; it can't _select_).
  - _A submitted chat message does **NOT** approve a **tool-call approval**_ ("Allow edits…") —
    the native Allow/Skip modal persists and the message just spawns **another tool-call turn**.
    So approvals ← hook **`allow`/`deny`**, not text.
  - _Implication for the actuator (M3b): questions and approvals use **complementary** channels
    — text-injection for questions, hook decision for approvals. Neither answers the other's
    blocker._
- **4.8** _`vscode_askQuestions` answer format_ (extracted 2026-07-09 from the built-in tool in
  the server's `extensionHostProcess.js`). The tool returns its result to the model as a **JSON
  text part**: `{ answers: { "<question.header>": { selected: string[], freeText: string|null,
skipped: boolean } } }` — `selected` = chosen option labels, `freeText` = the custom-answer
  field (or `null`), `skipped: true` when unanswered (a skipped result is all-`skipped`).
  Delivered as `content: [{ kind: "text", value: JSON.stringify({answers}) }]`.
  - _Injection caveat:_ `workbench.action.chat.open { query }` submits a **user message**, not a
    tool result, so it **cannot** produce this structure — it **skips** the pending tool and the
    message drives the next turn (matches the manual test, §4.7). Producing the exact `{answers}`
    result needs **owning the loop**. So the question channel is two-tier: **v1** =
    natural-language injection (lossy, skips the tool, targets the _active_ session — Q1);
    **high-fidelity** = owned-loop returning the JSON result.
- **4.9** _Hook discovery locations_ (grounded 2026-07-09 via the official VS Code **"Agent
  hooks"** + **"Agent plugins"** docs, then code — the general discovery lives in **VS Code
  core**, not the copilot-chat extension, which only carries the Claude-specific
  `claudeHookRegistry.ts`). Copilot loads hook config from, per the `chat.hookFilesLocations`
  setting (folders load every `*.json`; supports `~` paths):
  - **Workspace:** `.github/hooks/*.json` (what our probe uses) · `.claude/settings.json[.local]`.
  - **User-global:** **`~/.copilot/hooks/*.json`** (Copilot flat format) · `~/.claude/settings.json`
    (matcher format). These fire in **every** window/profile/workspace.
  - **Custom agent:** a `hooks:` block in `.agent.md` frontmatter (`chat.useCustomAgentHooks`).
  - **Plugin:** `hooks.json` / `hooks/hooks.json` in an agent plugin (registered via a marketplace,
    `chat.pluginLocations`, or `~/.copilot/installed-plugins/`); needs `chat.plugins.enabled`.
  - _`matcher` values are parsed but **ignored** — hooks run on every event. Tool-input props are
    **camelCase** in VS Code (`tool_input.filePath`), not Claude's snake_case._
  - _Product implication (supersedes earlier code-only guesses): the hook is a **config file**, not
    an extension API. For zero-per-repo install, the extension writes **`~/.copilot/hooks/cloakcode.json`**
    (user-global) on activate — this also fixes the **Extension Dev Host** (a separate profile that
    workspace `.github/hooks` never reaches). An agent **plugin** is the richer alternative (bundles
    hooks + skills + agents). The proposed `vscode.chat.registerHookProvider` exists but is
    sideload/preview-only — the config-file path is the stable choice._
- **4.10** _§2.1 "the transcript is the complete live record" →_ **REFINED (2026-07-10).** For a
  session hosted in a chat **EDITOR** (not the panel), Copilot's `sessionTranscriptService`
  writes only `assistant.turn_start` — **no `assistant.message`/`turn_end`** (the assistant side
  is invisible on disk). Panel/agent sessions stay complete. The **debug-log**
  (`debug-logs/<id>/main.jsonl`, OTel spans) is complete for **both** hostings. So the observer
  now reads the **debug-log as PRIMARY**, transcript as **fallback** (`findSessionLog`;
  `parseDebugLogEvents` maps `user_message`/`agent_response`/`tool_call` → the same
  `SessionPart`s). The debug-log is **opt-in**:
  `github.copilot.chat.agentDebugLog.fileLogging.enabled` (default **false**, experiment-gated;
  §4.25); buffered auto-flush **~4s**
  (`github.copilot.chat.agentDebugLog.fileLogging.flushIntervalMs`) + on
  session end; 50-log / 100 MB rotation. (Live overlay still uses the real-time hook spool.)
- **4.11** _§2/§4.1 "Copilot persists all chat data server-side" →_ **REFINED (2026-07-10).**
  Only **Copilot's** logs (transcript + debug-log) are server-side. VS Code's authoritative
  **`ChatModel`** — the full conversation, the session **title**, per-turn tokens/credits — is
  **workbench (client) state**, persisted by `ChatSessionStore` **on window shutdown** to the
  **client** machine. Verified on a devcontainer→WSL2→Windows 11 stack: an exhaustive
  `~/.vscode-server` scan finds **no** `chatSessions/` / `state.vscdb`; the store lives on
  **Windows** at `%APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\<sessionId>.json`
  (a `chatSessionOperationLog` JSONL — `{"kind":0,v:<snapshot>}` + appended `{"kind":1|2,k,v}`
  patches; append-incremental, compacted on close). The Windows FS isn't mounted in the
  container — the remote boundary is enforced. _Implication: CloakCode (server-side) can only
  read Copilot's two logs; the client store is unreachable (and that's aligned with
  zero-code-sync)._
- **4.12** _Actuator: deterministic per-session send_ (verified 2026-07-10). Our observed
  `sessionId` **is** the local chat-session id — Copilot builds
  `vscode-chat-session://local/${base64url(sessionId)}` (`toolCalling.tsx`), matching core's
  `LocalChatSessionUri`. So a **two-step** `vscode.open(<that URI>)` → `workbench.action.chat.open({query})`
  delivers a remote message to a **specific** session — proven live. `vscode.open` hosts it in an
  **editor** (which broke the transcript — moot now: the debug-log source stays complete for
  editor sessions, so targeting + observability coexist). **Panel** targeting is **impossible for
  extensions**: the capability is the internal `IChatWidgetService.openSession(uri, ChatViewPaneTarget)`;
  no extension-invokable command exists (`_chat.voice.switchToSession` is a controller method;
  `workbench.action.chat.openInSidebar` takes no session arg). `session.respond` was generalized
  (`toolCallId` optional) so it doubles as a **free-form chat message** channel.
  **⚠ Window-local caveat (2026-07-11).** This targeting resolves only a session that lives in
  the **window running the command** (the bridge's window). A `sessionId` owned by a
  **different window** — or any window with **no bridge** — has no editor/session to open, so
  `vscode.open` → `chat.open` **creates a NEW chat** in the bridge's window instead of driving
  the intended one. Because `scanSessions` lists **every** on-disk session across all
  `workspaceStorage/<hash>` (all stamped with the single bridge `instanceId`) and there is no
  on-disk owner signal, foreign sessions are **listed but not actuatable**. Tracked in docs/05
  (_cross-window actuation_).
- **4.13** _Session title is LLM-generated_ (verified 2026-07-10). The title VS Code shows is
  generated by the copilot `ChatTitleProvider` (an LLM child session) and stored as
  `ChatModel.customTitle` (client-side). Server-side it's reachable **only** via the debug-log:
  `main.jsonl` has a `child_session_ref` (`label:"title"`) → `title-<childId>.jsonl` whose
  `agent_response` text **equals** the title (`0ed16d08` → "New chat session testing" = the
  Windows store's `customTitle`). `scanSessions` now prefers it (`debugLogTitle`), falling back
  to the first user message when there's no debug-log.
- **4.14** _Debug-log telemetry_ (catalogued 2026-07-10, **build deferred post-MVP**). Each
  `llm_request` span carries what the transcript never had: `model`, agent `debugName`,
  `inputTokens`/`outputTokens`/`cachedTokens`, `ttft`, request `__dur`, `maxTokens`, and
  **`copilotUsageNanoAiu`** (billing); the Windows store confirms per-turn `copilotCredits`.
  `tool_call` spans add duration + error; `agent_response` adds `reasoning`. Surfacing this as
  session telemetry is a future slice (docs/05).
- **4.15** _Tool-approval replication for the blocking hook_ (verified from source 2026-07-10,
  vscode @ 789c53ec). **⚠ SUPERSEDED by §4.20 (2026-07-10):** CloakCode no longer replicates VS Code’s approval decision at all — the hook surfaces **every** call and the observer debounces (auto-approved calls self-retire), so the `permissionLevel` / global-auto-approve / allow-list reads **and** the take-control gate were all removed. The analysis below is kept as the record of why. To "only block if VS Code would have blocked" we read the actual decision.
  **Two independent mechanisms** in the agent-host (the path that honors `~/.copilot/hooks/`):
  (a) the **`PreToolUse` hook** fires for **every** tool call, before/independent of approval —
  VS Code even uses it internally for edit-tracking (`copilotAgentSession.ts::_handlePreToolUse`);
  (b) the **decision** `sessionPermissions.ts::getAutoApproval` returns a reason (auto-approved)
  or `undefined` (**confirmation needed**), precedence: global auto-approve
  (`chat.tools.global.autoApprove`, id in `constants.ts` `ChatConfiguration.GlobalAutoApprove`) →
  session **bypass** (`autoApprove`) → per-tool `permissions.allow` → read-in-workdir →
  write-pattern → tree-sitter shell rules → else prompt. Modes: `interactive | plan | autopilot`
  (autopilot auto-answers). **Because the hook fires before `getAutoApproval`, the hook must
  self-decide** — VS Code won't tell it "I'd have prompted." **Reachability (corrected 2026-07-10):**
  the session's effective approval mode IS reachable. It's logged **per request** in the debug-log
  `main.jsonl` as `permissionLevel` (`default` | `assisted` | `autoApprove` [= the "Bypass Approvals"
  status-bar toggle] | `autopilot`) — verified live (~382 hits in one session; value flows from the
  client `ChatModel.inputState` onto `request.permissionLevel`, `toolCallingLoop.ts`). The hook
  **stdin does NOT carry it** (`chatHookService.ts` writes only `{timestamp, hook_event_name,
session_id, transcript_path, tool_name, tool_input, tool_use_id, cwd}`), but it carries
  `transcript_path` + `session_id`, so the hook derives the sibling debug-log and reads the latest
  `permissionLevel` **live** at decision time (tail-read, best-effort). _An earlier draft wrongly
  called this unreachable — it conflated it with the agent-host `session.db`
  (`agentService::_persistConfigValues`), which is the separate "agent sessions" feature; that DB
  does **not** exist for classic Copilot Chat (verified: no `agentSessionData`/`session.db` on
  disk)._ **Decision (YAGNI/DRY):** respect the reachable signals — the global auto-approve setting,
  the session's own `permissionLevel` (`autoApprove`/`autopilot` ⇒ defer), and an operator-grown
  allow-list — and gate all blocking behind an explicit **take-control** toggle; VS Code's
  read/write-path + tree-sitter shell rules are **not** ported (they surface unless allow-listed).
  **Hook output shape**
  (authoritative, copilot-chat `hookCommandTypes.ts` + `chatHookService.ts:367-388`): the verdict
  lives inside `hookSpecificOutput` — `{ hookSpecificOutput: { hookEventName:"PreToolUse",
permissionDecision:"allow"|"deny"|"ask" } }`; an empty `{}` (no `hookSpecificOutput`) defers.
  Multiple hooks combine **most-restrictive**. _Note: `rg` is not installed in the container — use
  `grep`._
- **4.16** _Take-control blocking + the question/approval split_ (**live-verified 2026-07-10**). **⚠ SUPERSEDED for approvals by §4.20 (2026-07-10):** take-control is removed; approvals now resolve VS Code’s own confirmation via the `workbench.action.chat.acceptTool` / `skipTool` command (targeted by the session URI), so the hook never blocks. The question/approval split + structured answering (§4.17) still hold. A
  real take-control run held `run_in_terminal` calls (`printf …`, `rm -v …`) and resolved them
  remotely via Allow/Deny — the held tool **never** surfaced the native VS Code prompt. **Key
  constraint confirmed:** the hook's `permissionDecision` only gates whether a tool _runs_; it has
  **no channel to supply a tool result**, so it **cannot answer `vscode_askQuestions`** — `allow`
  runs the picker (native, local), `deny` rejects it, neither selects an option. Therefore a
  question **must run** and is answered only by the **text-inject** path (Copilot treats a submitted
  chat message as the answer — verified live: `"…→ scratch.txt …→ Overwrite"` yielded "Both answers
  received"). Consequences that are **by design, not bugs**: questions go `notify` + text (never
  block), and the native picker **also** appears (first-responder-wins across phone/desktop).
  **Correction (from the live test):** answering a question via chat-text actually **cancels** the
  carousel (tool result `ERROR: Canceled`) and relies on the agent re-reading free text — the proper
  answer is the structured `{"answers":{<header>:{selected,freeText,skipped}}}` the tool returns.
  And it **is** producible programmatically: the core `AskQuestionsTool` listens on
  `IChatService.onDidReceiveQuestionCarouselAnswer`, fired by the registered command
  **`_chat.notifyQuestionCarouselAnswer(resolveId, answers)`** (`chat.shared.contribution.ts`). So
  CloakCode can call that command from the ext host to submit a **structured** answer — no chat-text,
  no owning-the-loop. `answers` = `Record<"${resolveId}:${index}", {selectedValue|selectedValues,
freeformValue}>`; `resolveId` = `ChatToolInvocation.toolCallId` (= `chatStreamToolCallId ?? callId`,
  runSubagentTool.ts:248), derivable from the hook's `tool_use_id`. (Autopilot / auto-reply
  auto-answer in-tool — confirms mode #3.) _So "owning the loop" is NOT required for questions; that
  earlier claim was wrong._
- **4.17** _Structured question answering — SHIPPED + live-verified 2026-07-10._ Concrete facts
  nailed in testing of the `session.answer` → `_chat.notifyQuestionCarouselAnswer` path: (1) the
  **`resolveId` is the BASE id**, not the hook's suffixed `tool_use_id` — VS Code sets
  `chatStreamToolCallId = id.split('__vscode')[0]` (`inlineChatIntent.ts`), so the carousel keys on
  `toolu_…` (no `__vscode-<n>`). CloakCode preserves the raw id and fires the command for **both**
  the suffixed and stripped-base forms (the non-match no-ops). (2) the **answer VALUE shape must
  match the question TYPE for the carousel to RENDER**: `singleSelect` → `{selectedValue}`,
  `multiSelect` → `{selectedValues}`, freeform → `{freeformValue}`. The tool RESULT builder
  (`convertCarouselAnswers`) is type-tolerant (the model gets the answer regardless), but the
  DISPLAY is strict — `selectedValues` on a single-select renders blank; `selectedValue` on a
  multi-select renders **`[object Object]`**. (3) **`multiSelect` must be threaded through** (input
  → `toConfirmations` → protocol `confirmation`/`answer` → client multi-toggle → `selectedValues`).
  Live-verified: single-select, multi-select, freeform, and freeform-alongside-options all render +
  resolve. **No take-control needed for questions.** **Correction (2026-07-14):** point (2)'s
  "freeform → `{freeformValue}`" holds only for a question that **has options** (the single/multi
  carousel reads a custom value from `freeformValue`). A question with **no options** is a
  **`text`-type** carousel whose answer VS Code restores via `String(answer)`
  (`chatQuestionCarouselPart.ts` `renderText`) — so it needs a **bare string**; an object there
  renders **`[object Object]`** (the free-text-only bug). `buildCarouselAnswers` now emits a bare
  string whenever no option is selected, and objects only for `selectedValue`/`selectedValues`.
- **4.18** _On-disk state resets on restart, not on a timer_ (2026-07-10). **⚠ SUPERSEDED by §4.19 (2026-07-10):** the blind reset-on-activate was removed — it could drop a still-valid blocker after a window reload; orphans are now cleared **causally** (a later turn supersedes them), no restart or timer. Stale take-control
  policies and blockers from a window closed mid-question (`PostToolUse` never fired) are cleared on
  extension `activate()` — deliberately **not** TTL-based, so a long-running session keeps its state
  for its whole lifetime.
- **4.19** _Orphaned-blocker cleanup is causal, not timed (2026-07-10)._ A pending card whose tool
  call has **no end** — the turn was cancelled or the window closed before `PostToolUse` — used
  to linger. Fix: retire a spool record once the transcript shows a **later turn** than the record
  (`newestTurnTs` = max `timestamp` over `user.message` + `assistant.turn_start`, vs the record’s
  `ts`; see `isSuperseded`). **Causal** ("the session moved on"), never a wall-clock TTL, so a live
  blocker is safe: the transcript lags the in-flight turn (§4.6), so its turn events are older than
  the record and nothing supersedes it until real new activity happens. Tool events are ignored (a
  sibling tool finishing in the same turn must not retire a live approval); timestamps are
  non-monotonic across history so we take the **max** (an old out-of-order event can’t inflate it).
  Covers both questions and approvals (shared spool reconcile).
- **4.20** _No take-control, no permission replication — surface + debounce (2026-07-10; replaces
  the §4.15/§4.16 model)._ Since approvals resolve via `acceptTool`/`skipTool` (a command, not a
  held hook), the hook stopped deciding anything: it **surfaces every tool call** (`spoolRecordFor`
  — interactive → question, else → approval) and always defers; VS Code’s own outcome retires the
  card. To avoid flicker (the hook fires **before** `getAutoApproval`, so an auto-approved call would
  briefly show), the observer **debounces surfacing** by `cloakcode.surfaceDebounceMs` (default
  **3000 ms**): a call VS Code auto-approves/answers completes within the window and is retired
  before it ever shows. Applies to **both** questions and approvals; a question that autopilot auto-answers within the
  window is simply suppressed (the client disclaimer covers that race). **Known wart:** a _slow_ auto-approved tool can’t be told
  apart from a waiting one on disk (the §4.6 lag), so it shows a transient card until it completes —
  non-harmful (its buttons no-op) and self-clears; the client shows a standing disclaimer that a
  call may already be auto-resolved. **Session targeting** (verified vs vscode `chatUri.ts`):
  `acceptTool`/`skipTool` take `{sessionResource}` and match by **exact** URI equality
  (`getWidgetBySessionResource` → `isEqual`), so a wrong/empty id can only **no-op**, never resolve a
  different session; the URI is `vscode-chat-session://local/<unpadded-base64url(sessionId)>`
  (`localChatSessionUri`).
- **4.21** _Debug-log `agent_response.response` is truncated at ~5 KB (2026-07-11)._ VS Code writes
  the assistant turn's `response` (the LM message array `[{role,parts:[{type:'text',content}…]}]`)
  into the debug-log as a **capped** attr: at ~5000 chars it is cut mid-string and a literal
  `[truncated]` marker is appended, so it **no longer parses as JSON**. (Confirmed on this session's
  188 MB `main.jsonl`: 15 of 311 `agent_response` spans fail to parse, all len ≈ 5010, tail
  `…[truncated]`.) The **real** text is not truncated — it lives in the transcript's
  `assistant.message.content` and the live chat; only the debug-log's telemetry copy is capped.
  CloakCode's observer prefers the debug-log (it stays complete for editor-hosted sessions), so
  `assistantText` used to fall through and render the raw `[{"role":…}]` blob for those turns. Fix:
  on parse failure, **salvage** the `"type":"text","content":"…"` bodies (tolerant of truncation)
  instead of dumping raw JSON (`salvageAssistantText`, `session-observer.ts`). _Residual:_ salvaged
  long turns are still capped at ~5 KB in the CloakCode view; full text would need cross-referencing
  the transcript (deferred — the debug-log is preferred for completeness on editor-hosted sessions).
- **4.22** _Ephemeral `workspaceStorage` + transcript rehydration; the debug-log does not rehydrate
  (2026-07-12)._ Here `workspaceStorage` is on the **ephemeral overlay** FS (no volume), so a
  **container rebuild wipes** transcripts + debug-logs + every session dir. On restore, copilot-chat's
  `SessionTranscriptService.startSession(id, ctx, history)` finds **no** `<id>.jsonl` and **replays**
  the conversation `history` into a fresh transcript (`user.message → turn_start → assistant.message →
turn_end` per round; dir = `context.storageUri/transcripts`). `history` is reconstructed by VS Code
  **core** from the ChatModel, persisted **client-side** (`state.vscdb` / `chatSessions/<id>.json`,
  §2.2) — **not** the empty `session-store.db`. Replayed entries are stamped at **reconstruction
  time** (core drops original per-turn times — ours were one ~5-min burst), so a **rehydrated
  transcript's timestamps are not real turn times** (use mtime / max for liveness). The **debug-log
  has no replay path** (live OTel only) → it starts fresh post-rebuild. Transcripts are also **GC'd to
  the last 20** (`cleanupOldTranscripts`). _Correction:_ the debug-log does **not** "reset on reload" —
  it grew to 188 MB across many reloads; only the **rebuild** (overlay wipe) cleared it.
- **4.23** _Transcript is always one assistant reply behind; the debug-log has the latest
  (2026-07-12, live-verified)._ Buffered transcript entries flush only at the **next** turn boundary
  (§4.6), so a finished turn's `assistant.message` reaches disk only when the **following** turn
  starts — the **newest** reply is **never** on disk while it is the latest. Verified on session
  `4814afa5`: turn 1's reply appeared only once turn 2 began; turn 2's reply is absent. The
  **debug-log** writes `agent_response` per turn, so it **has the latest** (2 `user_message` → 2
  `agent_response`). Consequence for live viewing / remote-drive: the **transcript alone can never
  show the current answer** — the **debug-log is required** for the latest turn (its caveats stand:
  ~5 KB truncation §4.21 [salvaged], history loss on rebuild §4.22).
- **4.24** _Transcript schema is authoritatively typed; `tool.execution_complete` carries the tool
  output (2026-07-13)._ `sessionTranscriptService.ts` is the authoritative typed schema; the
  reverse-engineered vocabulary (§2.1) is correct with one refinement — **`tool.execution_complete.data`
  also carries `result?: { content: string }`** (the tool output lives in the transcript), not just
  `{ toolCallId, success }`. Likewise `session.start.data = { sessionId, version, producer,
copilotVersion, vscodeVersion, startTime, context?.cwd }` and `assistant.message.data =
{ messageId, content, toolRequests[], reasoningText? }`. Folded from local source research together
  with the Hooks-feature seam (§3.5) and the observer liveness ceiling (§3.6).
- **4.25** _Copilot Chat is now built into **core VS Code**; the debug-log setting was renamed and is
  experiment-gated (2026-07-13, host + container verified)._ The `microsoft/vscode-copilot-chat` repo was
  **archived 2026-05-20** — Copilot Chat now ships **inside VS Code** as the built-in `extensions/copilot`
  (bundled in the desktop / `vscode-server` install, which is what gives it host access). **Anchor all
  Copilot-internals research on core VS Code (`microsoft/vscode` → `extensions/copilot`), never the
  archived repo.** The debug-log toggle recorded above (§2.1 / §3.6 / §4.10) as
  `chat.chatDebug.fileLogging.enabled` was **renamed** to
  **`github.copilot.chat.agentDebugLog.fileLogging.enabled`** — source `configurationService.ts`:
  `ChatDebugFileLogging = defineAndMigrateExpSetting('chat.chatDebug.fileLogging.enabled',
'chat.agentDebugLog.fileLogging.enabled', false)`. It is the **canonical** toggle (the old
  `agentDebugLog.enabled` is deprecated → merged into it), **experiment-gated** (tags
  `['advanced','experimental','onExp']`, default **false**, needs a window reload). So file logging can be
  effectively on via **either** an explicit setting **or** an ExP treatment — **both were observed**: the
  **host** built-in **v0.56.0** has it explicitly `true` in User settings (mtime 2026-07-08); the
  **container** built-in **v0.52.0** has it in **no** settings.json yet writes logs → ExP. _Implication:_
  never assume the debug-log exists — CloakCode keeps the transcript fallback **and** offers a one-click
  explicit enable (`recommendDebugLog`). Red herring: `github.copilot.chat.copilotDebugCommand.enabled` is a
  **Preview** toggle for the `copilot-debug` **terminal command**, unrelated to logging. The palette command
  **"Developer: Open Agent Debug Logs"** = core `workbench.action.chat.openAgentDebugPanel`; it opens the
  panel and does **not** write the setting (verified: settings.json mtime unchanged after running it).
- **4.26** _`session-store.db` (chronicle) is a **lagging index**, not a live source; no-folder windows log
  to globalStorage (2026-07-13, host inventory)._ `globalStorage/github.copilot-chat/session-store.db`
  (schema*version 3; tables `sessions` / `turns` / `session_files` / `session_refs` / `checkpoints` /
  `search_index` [FTS5]; `sessions` keyed by `created_at` / `updated_at` / `cwd` / `repository`) **lags the
  on-disk logs**: on the host it stopped at **2026-05-26** (5 sessions / 154 turns) with a **4.1 MB
  uncommitted WAL** (larger than the 1.3 MB DB), while debug-logs + transcripts show activity weeks later and
  today — none indexed. So the observer **must read the debug-log / transcript directly** (as it does) and
  treat the DB as a **stale** convenience index (needs a reindex / WAL-checkpoint to catch up). Inventory
  notes: a window with **no folder open** writes its debug-log under
  **`globalStorage/github.copilot-chat/debug-logs/<id>/`** (not workspaceStorage); a rich session dir carries
  `main.jsonl` + `models.json` + `system_prompt*_.json`+`tools\__.json`+`categorization-<uuid>.jsonl`+`title-<uuid>.jsonl`(workspace sessions with no subagent carry only`main.jsonl`+`models.json`). The
built-in Copilot version **drifts across environments** (host 0.56.0 vs container 0.52.0); the desktop
install lives under `…/Microsoft VS Code/<commit-prefix>/resources/app/`.

- **4.27** _A forked conversation shares the PARENT's transcript; it gets only its own debug-log dir —
  so it is **invisible** as a distinct session-list row (observed 2026-07-15; **one reload-validation
  pending**)._ Forking a chat in the UI does **not** create a new
  `transcripts/<forkId>.jsonl`; the fork **appends into the parent's** transcript. Verified on-disk:
  the parent session `7e695673-…-1883bf14b05a` (hash `bf235c2e…`) kept growing (10405 → 10423 lines,
  mtime advancing) while the fork produced turns, and the fork's own message text landed **inside**
  the parent's `7e695673….jsonl`. The fork's session id `c62241fb-…-979b26941a75` has a
  `debug-logs/c62241fb…/` dir but **no** `transcripts/c62241fb….jsonl` (checked twice, minutes apart).
  Because `scanSessions` lists `transcripts/*.jsonl`, it correctly sees **one** session (the parent) —
  the fork is folded in, not dropped. This is **platform behaviour, not a scanner bug**. Surfacing
  forks as distinct rows would require keying off `debug-logs/<id>/` (each fork gets its own) — a
  design choice deferred **post-MVP** (docs/05, _Future / post-MVP capabilities_). **Still to confirm
  on the next window reload:** whether the fork's transcript is merely **lazily flushed** (appears
  later) vs. **never** created (always shares the parent) — i.e. is the transcript truly not "live"
  for forks. Re-run the mtime / lines / has-transcript sweep after reload and update this entry.

---

## 5. Capability matrix (current)

| Capability                                | Status      | Mechanism                                                                                                                          |
| ----------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| List sessions remotely                    | ✅ proven   | enumerate `transcripts/*.jsonl` + mtime liveness                                                                                   |
| Open/view a session transcript            | ✅ proven   | stream its JSONL (read-only)                                                                                                       |
| Track a **post-hoc** blocker (answered)   | ✅ proven   | unmatched interactive `tool.execution_start` — but only **after** it's answered (batched flush)                                    |
| Track a **live/pending** blocker          | ✅ via hook | `PreToolUse` fires when the picker appears, carrying the full payload; the transcript has **nothing** until answered (§4.6)        |
| Surface the blocker richly                | ✅ proven   | full question+options in the hook `tool_input` / event `arguments`                                                                 |
| Detect a tool-approval blocker (run/edit) | ✅ via hook | unmatched `PreToolUse` for an action tool (`run_in_terminal`, edits) — real-time, before the native prompt; transcript is post-hoc |
| Access Copilot models                     | ✅ (API)    | `vscode.lm.selectChatModels({vendor:'copilot'})`                                                                                   |
| Remotely **approve/deny** a tool call     | ✅ proven   | blocking `PreToolUse` hook returns `permissionDecision` (pause-and-route)                                                          |
| Answer / send to a session                | 🔶 partial  | queue-injection works when busy; steer/own-loop for deterministic                                                                  |
| Resume a dormant (idle) session           | ❌          | needs the session loaded in a live window + actuator                                                                               |
| Detect a prose-only blocker (no tool)     | ❌          | looks like a normal turn end                                                                                                       |

**Bottom line:** the entire **read/observe half is proven** and works for stock Copilot
sessions with no proposed API and without owning the loop. Remote **tool approval** is also
now proven via a blocking `PreToolUse` hook (pause-and-route, opt-in). The remaining actuator
work is **answering multiple-choice / prose blockers** (selecting an answer, not just
gating a tool), for which queue-injection is the partial path today.
