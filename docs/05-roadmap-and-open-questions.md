# 05 — Roadmap & open questions

## What's proven vs. what's left

- **Proven (read half):** list sessions · view transcript · track blockers · surface
  multiple-choice richly. All server-side, no proposed API, works for stock sessions.
- **Left (write half):** answer/steer a session remotely — the actuator.

## Open questions

| #   | Question                                                                                                        | Why it matters                                                                                                                                                        | How to answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Command IDs for **Steer with Message** / **Stop and Send** / **Add to Queue**?                                  | "Steer" is the ideal remote blocker-answer primitive.                                                                                                                 | **RESOLVED (2026-07-09).** `vscode.commands.executeCommand('workbench.action.chat.open', { query })` **submits** a message to the panel chat (verified in the copilot-chat source: `{ query }` alone sends; adding `isPartialQuery: true` only populates). This is the **question** answer channel (docs/02 §4.7) — but it needs the **extension host** (`vscode.commands`), so the actuator moves off the dev-server. v1 targets the active session; multi-session targeting is a refinement. |
| Q2  | Does the `@github/copilot` **agent-host SDK** expose a live input/steer channel?                                | Lighter-weight actuator than owning the whole loop.                                                                                                                   | Read `.../extensions/copilot/dist/extension.js` + `node_modules/@github/copilot/sdk/index.js` and `agent-host-config.json`.                                                                                                                                                                                                                                                                                                                                                                    |
| Q3  | Can a **prose-only** blocker (question ending a turn, no tool) be detected?                                     | The one blocker class the observer currently misses.                                                                                                                  | Compare `assistant.turn_end` patterns; possibly infer via "open turn, quiet for N s."                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q4  | Are UI-layer **tool-approval confirmations** observable **and answerable**?                                     | The most common agent blocker.                                                                                                                                        | **RESOLVED (2026-07-09).** Copilot Chat **hooks** fire `PreToolUse` for _every_ tool (incl. `run_in_terminal`, `vscode_askQuestions`) with `{ session_id, transcript_path, tool_name, tool_input, tool_use_id }`; returning `allow`/`deny` approves/blocks it. Observe via the transcript (zero-config); **answer via an optional hook** routed by `session_id` (= the observer's sessionId). See M3.                                                                                          |
| Q5  | Do **queued/steered** messages carry any structural marker?                                                     | Cleaner provenance for the actuator.                                                                                                                                  | Inspect a session where steer/queue is used with known text.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Q6  | How do **many concurrent instances** (dev containers, WSL distros, host) get discovered without port collision? | The extension runs in every window; `127.0.0.1` is not shared across environments, so a fixed port false-collides (WSL↔host) and can't cross namespaces (containers). | **Two-tier** (see [03 — Multi-instance topology](03-architecture.md#multi-instance-topology--discovery)): one leader observer **per environment** (lock file in `globalStorage`, since one `~/.vscode-server` User dir = all repos in that env), each leader **registers outbound** to a rendezvous relay that serves the union to the phone. Needs `instanceId` in the protocol (M1) + ephemeral bridge port.                                                                                 |

## Milestones

### M0 — Dev experience (this commit)

Dev container (fixed `/workspaces/cloakcode` mount + cache volume, Node LTS + pnpm +
extension/Copilot tooling), monorepo skeleton, full docs, preserved research scripts. ✅

### M1 — Protocol + Observer (read, end-to-end)

- `@cloakcode/protocol`: `SessionPart` union + RPC + zod, sequence-numbered event log.
  Include an **`instanceId`** + environment metadata so `sessions.list` rows and
  `session.subscribe` key on `(instanceId, sessionId)` from day one (forward-compat with the
  multi-instance relay — see Q6).
- `@cloakcode/extension`: transcript observer (port the Python PoCs to TS), bridge WS
  server on `127.0.0.1` with a **configurable/ephemeral port** (`port: 0` fallback; a fixed
  port is only an optional same-host convenience, not the discovery/collision mechanism),
  `sessions.list` + `session.subscribe`. Single-instance **leader election per environment**
  (lock file in `globalStorage`) so multiple windows don't duplicate the whole-environment
  observer.
- Proves the full loop for **stock** sessions: list → open → live mirror → blocker detected.

> The rendezvous **relay** that unifies _different_ environments (distro↔distro, host↔WSL,
> container↔container) is **M4** (with the tunnel). M1 only bakes in the `instanceId` seam and
> the per-environment leader so no rework is needed later.

### M2 — PWA client

- `@cloakcode/web`: session list + live mirror, component-per-`SessionPart`, resumable
  stream (`lastSeq`), Web Push on `awaiting-input`, installable manifest.

### M3 — Actuator (optional, opt-in)

- **Read never depends on this.** The observer (M1) is the zero-config baseline; the actuator
  is a layered upgrade the user opts into.

#### M3a — Live-pending notifier (SHIPPED 2026-07-09)

Read-only real-time awareness of blockers. The transcript batches interactive/approval tool
events at completion (docs/02 §4.6), so a _pending_ blocker is invisible on disk; a
**non-intrusive** `cloakcode` hook (emits **no** `permissionDecision`, so native VS Code
approvals are untouched) records blockers to a local spool. The extension merges them into a
separate `{kind:"pending"}` snapshot channel (deduped against the transcript by base
`toolCallId`) and the PWA renders a **"Needs your input"** overlay. Proven live for both
questions and tool approvals. `session.respond` is **not** yet wired — answering is M3b.

Hardened for real deployment (see docs/03 "Deployment & concurrency"): the extension
**self-installs** the hook (`~/.copilot/hooks/cloakcode.json`) from `context` paths (bundled
`hook.cjs` + `process.execPath`), gated by the `machine`-scoped `cloakcode.installHook`. The
spool is a **fixed per-environment directory** (`~/.cloakcode/spool`, computed by both sides —
no env handoff), **one file per blocker** (write on `PreToolUse`, delete on `PostToolUse`) so
concurrent windows never race. Only **interactive** tools are spooled; routing is by
`session_id`; a **late subscriber gets the current snapshot on subscribe** (phone need not be
open when the question fires); and the follower **self-heals** stale files via the shared
`isRetired` predicate, with a fast path that skips the transcript parse when nothing is pending.

- _Residual edge:_ a session that **crashes mid-question** — before the interactive event ever
  flushes to the transcript — leaves a spool file that neither `PostToolUse` nor the
  transcript-subtraction/`isRetired` self-heal can retire. Mitigated by mtime session liveness
  dropping dead sessions from the list; a spool TTL/GC is a later option if it bites.

#### M3b — Remote answering (SHIPPED 2026-07-10)

**Built** — both answer channels now work: **questions** via `session.answer` →
`_chat.notifyQuestionCarouselAnswer` (structured; docs/02 §4.16/§4.17) and **approvals** via
`session.decide` → `workbench.action.chat.acceptTool`/`skipTool` (docs/03 “Remote approval”,
docs/02 §4.20). The design evolved substantially during the build: the take-control blocking hook
was a stepping stone that is now **superseded**.

**The realization that reshaped it:** `acceptTool`/`skipTool` resolve VS Code’s **own** native
confirmation, targeted by session URI. So CloakCode no longer has to _block_ the tool to answer
remotely — the hook stays a pure notifier, the native prompt still shows, and the phone command and
the desktop prompt resolve the **same** pending confirmation (genuine first-responder-wins, not
mutually exclusive in time as an earlier draft argued). That removed the entire take-control /
native-suppression / permission-replication apparatus:

- **Superseded — block-and-suppress.** The earlier build blocked the `PreToolUse` hook to suppress
  the native prompt while the phone decided, which forced an opt-in “take control” toggle and a live
  read of the session’s `permissionLevel` to “only block if VS Code would have blocked.” Because
  approvals now resolve VS Code’s own prompt by command, none of that is needed: no blocking, no
  take-control, no permission replication (docs/02 §4.15/§4.16 → §4.20).
- **Surface + debounce.** The hook surfaces **every** call and defers; the observer debounces
  surfacing (`cloakcode.surfaceDebounceMs`, default 3 s) so an auto-approved call is retired before
  it flickers a card (docs/02 §4.20). Orphaned cards clear causally via a later turn (docs/02 §4.19).
- **Two answer channels (docs/02 §4.7):** approvals → `session.decide` → `acceptTool`/`skipTool`
  (deterministic, resolves the native confirmation); questions → `session.answer` →
  `_chat.notifyQuestionCarouselAnswer` (structured, resolves the carousel). Token streaming still
  needs **owning the loop** (`@cloakcode/agent` via `vscode.lm`) — a later “live” mode.

### M4 — Secure tunnel + hardening

- mTLS/token auth, provenance tagging (see security doc), redaction gate, audit log,
  tunnel to your infra.
- **Rendezvous relay** (Q6): each environment's leader registers outbound; the relay serves
  the union of all instances to the phone, keyed by `instanceId`. This is where multi-instance
  discovery across dev containers / WSL distros / host is actually stitched together.

### M5 — Packaging

- Private `.vsix` via `@vscode/vsce`; PWA deploy behind the tunnel.

## Future / post-MVP capabilities

Not needed for MVP, but planned — grouped here so the design accounts for them early. All are
unlocked by the debug-log + client-store richness we mapped (docs/02 §4.11, §4.14); none is on
the critical path.

- **Session telemetry (was "Slice 2").** Surface per-turn `model`, input/output/**cached**
  tokens, `ttft`, request duration, and cost (`copilotUsageNanoAiu` / `copilotCredits`) from the
  debug-log `llm_request` spans — a session-total header plus a small per-turn badge. Read-only,
  so it can ship any time.
- **Per-session allow-list (“Allow for session”) from the phone.** A third option on the approve
  card that stops CloakCode re-surfacing a tool for the rest of the session. CloakCode no longer
  keeps its own allow-list (it does not replicate permissions — docs/02 §4.20); this would instead
  fire VS Code’s **own** “Allow in this Session” action remotely (command TBD), letting VS Code
  auto-approve subsequent calls (which the debounce then suppresses). **Deferred from MVP.**

- **Remote session controls.** Let the phone read _and_ change the session's input state, which
  the client store exposes under `inputState` (`selectedModel` / `mode` / `modelConfiguration`):
  - **Agent selection** — e.g. `github.copilot.editsAgent`, ask, or custom agents.
  - **Model selection** — e.g. `claude-opus-4.8` (with vendor / family / pricing).
  - **Context size** — the model's `contextSize` option (e.g. 1M).
  - **Thinking depth** — `reasoningEffort`: `low` / `medium` / `high` / `xhigh` / `max`.
  - _Reading these is straightforward; **setting** them remotely is a write action that needs
    the actuator (owned loop or a config/command path) — sequenced after M3b answering._

## Explicitly deferred

- **One-question-at-a-time blocker UI (polish).** `vscode_askQuestions` can carry multiple
  questions in one tool call (e.g. file name + write mode). The overlay currently shows them
  stacked; a nicer UX steps through them one by one with "1/2" progress (mirroring the VS Code
  picker). Polish, not feature completeness — revisit after the actuator.
- Native VS Code chat-UI mirroring via proposed `chatSessionsProvider` (sideload-only).
- Multi-remote "command centre" for non-Copilot tools (the extensibility groundwork exists
  in the bridge, but no second controller is built yet).

## Known issues (to fix)

- **Web client does not auto-reconnect (2026-07-10).** `subscribeSession` (web `bridge.ts`) opens
  the WebSocket with an `error` handler but **no reconnect/backoff**, and the header only offers a
  **manual** "reconnect" button (`App.tsx`). So when the bridge restarts (extension reload / F5 dev
  host, or the machine waking), the phone stays disconnected until the user taps reconnect or
  reloads the PWA. This is **expected** with the current code, not a regression. Fix: auto-reconnect
  the subscribe socket with capped exponential backoff and re-subscribe from the last `seq`, driven
  off the socket `close`/`error`. Queued for the next session.
- **Disconnected state is not reflected in the UI (2026-07-10).** The header's connection dot is
  derived as `connected = state.kind === "ready"` (`App.tsx`) — it tracks whether the last
  `sessions.list` fetch succeeded, not the live socket, and nothing re-checks it, so after a
  mid-session drop it can keep showing **connected** (green) while the bridge is gone. In a session
  view a dropped subscribe socket surfaces only a transient "stream: connection lost" hint and the
  cards keep their last (stale) state. Fix alongside auto-reconnect: derive one connection state
  from the socket `open`/`close`/`error` (+ a heartbeat/ping) and show a clear disconnected banner.
- **Session status over-reports "blocked" (server-side, 2026-07-11).** `classifyStatus`
  (`scanner.ts`) treats **any** open interactive `tool.execution_start` as blocked, but orphaned
  starts (cancelled / abandoned / lagging turns — §4.6 never flushes their `complete`) **accumulate**
  on disk, so a long-lived session reads "blocked" while live and "idle" once stale, and **never
  flips to "active" after a question is answered**. Confirmed on a real transcript (11 unmatched
  starts, incl. 3+ `vscode_askQuestions` from the prior day). A client refresh can't fix it — it's
  the scan. Fix (mirrors the spool's `isSuperseded`): (a) an open interactive start counts only if
  **no later turn** (`user.message` / `assistant.turn_start`) supersedes it; (b) drive live "blocked"
  from the **spool** (real-time) rather than the lagging transcript; (c) make the list + header
  status **live** (poll or push). Related to the two stale-snapshot issues above.
- **Transcript jump-to-bottom fails on initial load (2026-07-11).** The session view doesn't scroll
  to the latest message when a session first opens (it works after). The ResizeObserver
  stick-to-bottom misses the initial markdown/table reflow; force a scroll-to-bottom once the first
  parts have rendered.
- **Session identity is under-surfaced (2026-07-11).** The list row shows only the workspace — and it
  is the 8-char **hash** prefix (because `readWorkspaceName` falls back to `hashDir.slice(0,8)` when
  `workspace.json` is unreadable) — and nothing shows the actual **session id**. Surface both the
  workspace id and the session id, clearly **labeled**, in the list rows and the session header.
- **List grouping + instance label (2026-07-11).** The list groups by `instanceId` (the `EXT-DEV`
  header = `CLOAKCODE_INSTANCE_ID` from `.vscode/launch.json`, else `os.hostname()`). Group/sub-group
  by **workspace** within the instance to keep it clean, and label the instance header so a bare tag
  like `ext-dev` reads clearly.
