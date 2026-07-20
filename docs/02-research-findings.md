# 02 — Research findings

Everything below was established empirically starting **2026-07-08** against `copilot-agent`
0.56.0 / VS Code 1.128.0 on a **remote server** setup (`~/.vscode-server`), and extended through
the build. This is the **empirical heart** — the API surface, a one-line **findings ledger**, and
the capability matrix. The detail (the options explored, the mechanics, and the **wrong turns** —
several first-pass conclusions were wrong, and the wrong turns are themselves useful) lives in the
**topic files** below; keep them so nobody re-derives the same dead ends.

> **Ledger IDs are stable anchors.** The `§N.x` tags (e.g. `§4.19`) are cited across docs/03–06.
> Each keeps a one-line outcome here and links to its full write-up in a topic file. The old
> "Corrections log" was split by topic (2026-07-16); the numbers did not change.

## Topic detail files

- [02.1 — Messaging & actuation](02.1-messaging.md) — send · steer · queue · stop · stop-and-send;
  command injection; per-session targeting.
- [02.2 — Turn tracking & observer liveness](02.2-turn-tracking.md) — the `inTurn` gate; the
  message-granular ceiling; session-list liveness.
- [02.3 — Tool call handling](02.3-tool-call-handling.md) — surfacing blockers (the hook seam,
  spool, overlay) + answering them (questions + approvals).
- [02.4 — On-disk storage & logs](02.4-storage-and-logs.md) — transcript vs debug-log, ephemeral
  storage, truncation, the chronicle DB.
- [02.5 — Session state](02.5-session-state.md) — the client-side `ChatModel`, title, telemetry,
  session controls, attachments, forks.

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

## Findings ledger

One line per finding; **`→`** links to the full write-up. Grouped by topic file.

### Messaging & actuation — [02.1](02.1-messaging.md)

- **§3.1** Command injection: `chat.open {query}` prefills/queues; a busy-loop injection is
  **auto-submitted** by the runtime queue. Non-deterministic; owning the loop is the robust path.
- **§3.4** Actuator lead: the on-server `@github/copilot` agent-host SDK is the live steer/input surface.
- **§4.2** Injection is **not** prefill-only — a busy-loop injection is queued **and** auto-submitted.
- **§4.12** Deterministic per-session send: `vscode.open(vscode-chat-session://local/<b64url(id)>)` →
  `chat.open {query}` targets a **specific** session. **Window-local**: foreign sessions are listed
  but not actuatable.
- **M3c** steer / queue / stop / stop-and-send are public `workbench.action.chat.*` sequences,
  live-confirmed; `isPartialQuery` is the steer↔send switch; none leaves an on-disk marker.

### Turn tracking & observer liveness — [02.2](02.2-turn-tracking.md)

- **§3.3** Remote session list works; **status must use mtime liveness**, not the last event type.
- **§3.6** Observer ceiling is **message-granular**, not token-live (buffered flush at discrete points).
- **§4.28** Mid-turn = an open `assistant.turn_start` with no `turn_end`, live-gated, with a
  **placeholder guard** (the spurious post-`turn_end` start). The action TYPE is not observable —
  only in-flight-ness (`SessionSummary.inTurn`, now also streamed live).

### Tool call handling — [02.3](02.3-tool-call-handling.md)

- **§3.2** Blocker signature: an interactive `tool.execution_start` with **no** matching `complete`
  = awaiting input; `arguments` carry the full question + options.
- **§3.5** Hooks are the supported observe+actuate seam; `PreToolUse` gets the payload + returns the decision.
- **§4.3** The observer **does** see interactive blockers (the earlier "blind" call was wrong).
- **§4.4** A `PreToolUse` hook **deterministically** drives tool approval (no owned loop); emit **no**
  decision to stay a pure observer.
- **§4.5** A blocking hook holds the tool **synchronously** for its full sleep — a viable pause-and-route.
- **§4.6** A live **pending** blocker is **not** on disk yet (flushed at answer time) → the **hook is required**.
- **§4.7** Two non-interchangeable answer channels: **questions ← injected text**, **approvals ← hook/command**.
- **§4.8** `vscode_askQuestions` returns `{answers:{header:{selected,freeText,skipped}}}`; `chat.open` can't produce it.
- **§4.9** Hook discovery: write `~/.copilot/hooks/cloakcode.json` (user-global) for zero-per-repo install.
- **§4.15** The approval decision (`permissionLevel`) is reachable per-request in the debug-log
  (**superseded** — CloakCode no longer replicates it).
- **§4.16** Take-control (**superseded** for approvals); questions answered structurally via
  `_chat.notifyQuestionCarouselAnswer` — no owned loop.
- **§4.17** Structured answering shipped: the answer VALUE shape must match the question TYPE (else
  `[object Object]`); a text question needs a **bare string**.
- **§4.18** Blind reset-on-restart (**superseded** by §4.19).
- **§4.19** Orphaned blockers clear **causally** (a later turn supersedes), never on a timer;
  force-stop also GCs the spool file.
- **§4.20** No permission replication — **surface every call + debounce** (default 3 s); approvals
  resolve via `acceptTool`/`skipTool` matched by exact session URI.
- **§4.27** The self-installed hook must be **cross-platform**: run the host runtime as node
  (`ELECTRON_RUN_AS_NODE=1`, safe on real node) and prefix the **Windows** form with PowerShell's
  `&`; ship one portable config via VS Code's `windows`/`linux`/`osx` override keys (no runtime branch).

### On-disk storage & logs — [02.4](02.4-storage-and-logs.md)

- **§2** Storage map: `transcripts/<id>.jsonl`, `debug-logs/<id>/main.jsonl`, the chronicle DB.
- **§4.1** Transcripts **are** on the server (the earlier "not on server" was wrong).
- **§4.10** The transcript is **incomplete** for editor-hosted sessions → the **debug-log is primary**.
- **§4.21** The debug-log's `agent_response` is truncated ~5 KB → **salvage** the text bodies.
- **§4.22** Ephemeral `workspaceStorage`: a rebuild wipes everything; the transcript **rehydrates**
  (with fake timestamps), the debug-log does **not**.
- **§4.23** The transcript is always **one reply behind**; the debug-log has the latest turn.
- **§4.24** The transcript schema is authoritatively typed; `tool.execution_complete` carries
  `result.content` (the tool output).
- **§4.25** Copilot Chat is **built into core VS Code** (the standalone repo was archived); the
  debug-log toggle was renamed + is experiment-gated.
- **§4.26** `session-store.db` is a **lagging** index — read the logs directly.
- **§4.28** The transcript storage root is **host-relative** — derive it from `context.globalStorageUri`
  (sibling `…/User/workspaceStorage`), not a hardcoded `~/.vscode-server` (0 sessions on desktop hosts).

### Session state — [02.5](02.5-session-state.md)

- **§4.11** VS Code's authoritative `ChatModel` is **client-side**, unreachable from the server
  (aligned with zero-code-sync).
- **§4.13** The session title is **LLM-generated** (`customTitle`); server-side only via the
  debug-log title child-session.
- **§4.14** Debug-log telemetry: model, tokens, `ttft`, `copilotUsageNanoAiu` (billing) — **SHIPPED** as the session `usage` bar (partial for stitched history).
- **§4.27** A **forked** conversation gets no transcript of its own → invisible as a distinct row
  (platform behaviour, not a scanner bug).
- **§4.29** File/text attachments are **inlined & recoverable**; **image bytes are not persisted**
  server-side.
- **§4.30** Session controls: **READ** on-disk (`models.json` + `llm_request`); **SET** is arg-driven
  & session-targeted (corrected — not actuator-only).

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
