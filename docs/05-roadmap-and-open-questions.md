# 05 — Roadmap & open questions

## What's proven vs. what's left

- **Proven (read half):** list sessions · view transcript · track blockers · surface
  multiple-choice richly. All server-side, no proposed API, works for stock sessions.
- **Left (write half):** answer/steer a session remotely — the actuator.

## Open questions

| #   | Question                                                                                                                                                                                                                  | Why it matters                                                                                                                                                                                                                                                                                                     | How to answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Command IDs for **Steer with Message** / **Stop and Send** / **Add to Queue**?                                                                                                                                            | "Steer" is the ideal remote blocker-answer primitive.                                                                                                                                                                                                                                                              | **RESOLVED (2026-07-09).** `vscode.commands.executeCommand('workbench.action.chat.open', { query })` **submits** a message to the panel chat (verified in the copilot-chat source: `{ query }` alone sends; adding `isPartialQuery: true` only populates). This is the **question** answer channel (docs/02 §4.7) — but it needs the **extension host** (`vscode.commands`), so the actuator moves off the dev-server. v1 targets the active session; multi-session targeting is a refinement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Q2  | Does the `@github/copilot` **agent-host SDK** expose a live input/steer channel?                                                                                                                                          | Lighter-weight actuator than owning the whole loop.                                                                                                                                                                                                                                                                | **PARTIALLY RESOLVED (2026-07-11)** — see `.local/research/actuator-steer-controls-and-agenthost.md`. A live steer channel exists in **3 layers**: (A) VS Code CORE `vs/platform/agentHost/` wraps **`@github/copilot-sdk`** with `sendSteering` + a prompt queue — but **core-internal, not callable by an extension**; (B) the **Copilot CLI over ACP** (`copilot --acp --stdio`: `session/prompt` send, `session/cancel` stop/steer, `session/request_permission` approve, `session/update` stream) — **extension/process-spawnable, the deterministic own-the-loop path** (proven by `uplink`); (C) proposed `chatParticipantPrivate` Steering region (restricted). Panel actuation stays command-based.                                                                                                                                                                                                                                                                                                                      |
| Q3  | Can a **prose-only** blocker (question ending a turn, no tool) be detected?                                                                                                                                               | The one blocker class the observer currently misses.                                                                                                                                                                                                                                                               | Compare `assistant.turn_end` patterns; possibly infer via "open turn, quiet for N s."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Q4  | Are UI-layer **tool-approval confirmations** observable **and answerable**?                                                                                                                                               | The most common agent blocker.                                                                                                                                                                                                                                                                                     | **RESOLVED (2026-07-09).** Copilot Chat **hooks** fire `PreToolUse` for _every_ tool (incl. `run_in_terminal`, `vscode_askQuestions`) with `{ session_id, transcript_path, tool_name, tool_input, tool_use_id }`; returning `allow`/`deny` approves/blocks it. Observe via the transcript (zero-config); **answer via an optional hook** routed by `session_id` (= the observer's sessionId). See M3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Q5  | Do **queued/steered** messages carry any structural marker?                                                                                                                                                               | Cleaner provenance for the actuator.                                                                                                                                                                                                                                                                               | **RESOLVED (2026-07-11).** The marker is the **field**, not a text tag: agent-host state separates one `steeringMessage` (mid-turn interjection, promoted to its own turn after the in-flight turn completes) from an array `queuedMessages` (next-turn); steering carries `userSelectedModelId` + `agentIdSilent` (`copilotAgentSession.test.ts`, `claudePromptQueue.test.ts`). _Open:_ whether it surfaces in the panel transcript CloakCode observes (agent-host is a separate subsystem).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Q6  | How do **many concurrent instances** (dev containers, WSL distros, host) get discovered without port collision?                                                                                                           | The extension runs in every window; `127.0.0.1` is not shared across environments, so a fixed port false-collides (WSL↔host) and can't cross namespaces (containers).                                                                                                                                              | **Two-tier** (see [03 — Multi-instance topology](03-architecture.md#multi-instance-topology--discovery)): one leader observer **per environment** (lock file in `globalStorage`, since one `~/.vscode-server` User dir = all repos in that env), each leader **registers outbound** to a rendezvous relay that serves the union to the phone. Needs `instanceId` in the protocol (M1) + ephemeral bridge port. **MVP path (2026-07-13): make the leader EXPLICIT** — ship the relay as a standalone **gateway you run** (host binary / Docker) that serves the PWA + hub; extensions connect out as **providers** when `cloakcode.gatewayUrl` is set, and the gateway **de-dupes** by `sessionId` (globally unique; owned copy wins). **Auto** leader election deferred **post-MVP**. **Bounded auto-discovery SHIPPED (2026-07-14, opt-in `cloakcode.gatewayDiscovery`):** the extension WS-probes known-local candidates (loopback + `host.docker.internal` + configured `cloakcode.gatewayHosts`) on `cloakcode.gatewayPort` and keeps the first peer that answers the minimal `cloakcode.hello` **knock** (a scanner that stays silent, or a non-gateway server, gets nothing back — and no provider info is revealed to it) — **candidate-probing, not true discovery** (the host set + port are known inputs), so it only removes copy-paste on the same machine / container→host / host↔WSL. The **provider** knock is mandatory; extending it to **operators** (phone/web + embedded bridge) so the gateway never answers _any_ non-knocking client is a tracked hardening follow-up. **True IP+port discovery** (finding a hub you were never told about) stays open: **mDNS/DNS-SD** is the native fit, but multicast doesn't cross Docker/WSL namespaces without an avahi reflector or WSL mirrored networking, so it's deferred until a real cross-namespace-LAN need appears. See [03 — Explicit gateway](03-architecture.md#explicit-gateway-mvp-the-hub-you-run).                                                                                                                                                                          |
| Q7  | Within one environment, which **window owns** a given session (for actuation routing)?                                                                                                                                    | Actuation is window-local but scanning is env-global; the workspace hash scopes cross-_workspace_ but two windows on the **same** folder share it, and there's no API for the active session id.                                                                                                                   | **Workspace hash: RESOLVED** — the `<hash>` in `context.storageUri` (`.../workspaceStorage/<hash>/<extId>`) = `md5(folderUri)`, taken as the **first path segment under `workspaceStorage/`** (NOT `basename(dirname())`: our ext id `cloakcode.@cloakcode/extension` contains a slash, so `dirname` lands a level too deep; fixed 2026-07-12 via `storageHashFromUri`; see `.local/research/workspace-identity-and-watch-dedup.md`). **Same-folder ownership: open** — probe a **hook-stamped owner beacon** (the PreToolUse hook runs in the owning Copilot process; needs window identity passed to the user-global hook); route actuation via a per-window ownership registry. **Mechanism found (2026-07-11):** Copilot's `NodeHookExecutor` spawns hooks with `env: { ...process.env, ...hook.env }`, and CloakCode shares the window's ext-host `process.env` with Copilot — so setting `process.env.CLOAKCODE_WINDOW_ID` at activate lets the hook stamp session→window ownership; needs an empirical two-window confirm. |
| Q8  | **Observability shape (R11)** — the `Logger`/log-record + **audit-record** schemas, `traceId` correlation across extension/leader/hook/bridge/web, and where the **durable audit** lives under ephemeral overlay storage. | No structured logging / metrics / tracing / audit today; the foundation is **pre-MVP**. "Redacted by construction" makes the record **shape** the crux — get it wrong and we either leak content or lose traceability/compliance.                                                                                  | **PARTIALLY SPEC'd (2026-07-12)** — design + open items in [03 — Observability](03-architecture.md#observability-logging--traceability). Decide: (a) the typed `fields` + **audit-record** shape + redaction-pass API (in `@cloakcode/protocol`); (b) durable-audit location (persistent volume vs ship-on-write, with buffer/replay if the tunnel is down); (c) mechanical no-secrets enforcement (redaction wrapper + lint rule + entropy test over sinks); (d) home-grown logger vs **OpenTelemetry** (the Copilot debug-log we parse _is_ OTel spans); (e) trace propagation into the out-of-process hook (via its spool file).                                                                                                                                                                                                                                                                                                                                                                                               |
| Q9  | Where does the **phone-auth secret** (PIN / OTP seed / device token) live, given isolated per-environment filesystems (host / remote / WSL / devcontainer) and a **moving leader**?                                       | There is **no shared file** across those namespaces, and even within one environment the leader — hence the gateway host/window — isn't stable (election hands off), so a secret pinned to "this host" or held in leader memory is lost on handoff; get it wrong and there's either no auth or a vanishing secret. | **PARKED (2026-07-13).** Rule: the secret lives on **disk or at the relay, never in leader memory**. Lead: the **rendezvous relay (Q6)** is the one always-on network node → it holds the phone secret; environments never hold the phone PIN, each holds a per-env outbound **enrollment token** in VS Code `context.secrets` (encrypted, per-env, shared by every window, re-read on handoff). Single-env fallback = the PIN in that env's `context.secrets`. Ladder: static **PIN** → **TOTP** seed → **device-pairing** token (revocable). **Interim MVP** leans on the authenticated tunnel (VS Code **private** port-forward / Dev Tunnel GitHub auth); the app-layer PIN is deferred.                                                                                                                                                                                                                                                                                                                                      |

## Milestones

> **Cross-cutting — Observability (R11), foundation is pre-MVP.** CloakCode has **no**
> structured logging, metrics, tracing, or audit trail today (just ad-hoc `out.appendLine` +
> the diagnostics dump). Before MVP we need the **foundation**: a redaction-by-construction
> `Logger` port, `traceId` correlation across extension / leader / hook / bridge / web, and an
> **audit log for remote actions** (who actuated, what egressed). Full design — including what
> the **leader** and each **extension** log — in
> [03 — Observability](03-architecture.md#observability-logging--traceability); shipping
> logs / metrics / audit to your infra is M4.

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

- mTLS/token auth, provenance tagging (see security doc), redaction gate, tunnel to your
  infra, and the **observability backbone** — ship structured logs + metrics + the audit
  trail out; auth-stamped actor identity; tamper-evident audit; a health RPC to the phone
  (foundation is pre-MVP; full design in
  [03 — Observability](03-architecture.md#observability-logging--traceability)).
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

- **Authenticated, encrypted gateway links (security hardening).** Today the gateway trusts any
  client that can reach it; the MVP compensating controls are the **loopback default**, a
  **private** tunnel (Q9), and host-firewall scoping (README → “Deployment & security”). Post-MVP,
  gate both hops with their own credential — a shared secret/token laddering to mTLS — presented at
  the **operator→gateway** and **gateway→provider (bridge)** `hello` handshakes and the PWA's
  `/bridge` upgrade, carried in `connectionHelloSchema` (`@cloakcode/protocol`) and verified in the
  gateway + extension client. This is what makes a wide `0.0.0.0` bind safe on an untrusted network;
  until then, treat wide binds as trusted-network-only. (Extends M4's “mTLS/token auth” to the
  explicit-gateway topology; sequenced after the MVP gateway ships.)

## Explicitly deferred

- **One-question-at-a-time blocker UI — SHIPPED 2026-07-14.** A multi-question
  `vscode_askQuestions` blocker now **steps through one question at a time** with "N of M" progress +
  Back/Next (mirroring the VS Code picker), instead of stacking them. Web-only (the `PendingCard`
  stepper in `SessionView.tsx`); a single-question blocker shows no stepper chrome; answers are still
  delivered structurally via `session.answer`.
- Native VS Code chat-UI mirroring via proposed `chatSessionsProvider` (sideload-only).
- Multi-remote "command centre" for non-Copilot tools (the extensibility groundwork exists
  in the bridge, but no second controller is built yet).

## Known issues (to fix)

- **Self-review 2026-07-13 — guardrail gaps in the last 7 commits.** (1) The
  **read-position restore** (`SessionView`, `41f392b`) was **broken** — `toBottom` ran on the first
  content measurement, before the transcript streamed in, so `scrollHeight` ≈ 0 clamped the target near
  the top and `restoredRef` then blocked any re-restore. **Fixed 2026-07-13:** the restore decision is
  now a pure `nextScrollAction` (`web/scroll.ts`) that **waits** until
  `scrollHeight − clientHeight ≥ saved.top` before restoring, unit-tested in `scroll.test.ts`.
  (Persisting parts + `lastSeq` alongside scroll stays deferred as YAGNI — `sessionStorage` size risk,
  and the resume-from-`lastSeq` reconnect already refills the transcript.) (2) The **auto-reconnect**
  logic in `web/bridge.ts` (`c3420fe`) was **untested** — the RTL test only asserted the banner against
  a mocked bridge. **Fixed 2026-07-13:** `bridge.test.ts` drives a mock `WebSocket` under fake timers to
  cover the capped-exponential backoff **and** resume-from-`lastSeq`. (3) **Docs-sync was skipped** for
  the **diagnostics dump** (`0c222f4`) and the **richer session activity** (`428a3e9`).
  **Fixed 2026-07-13:** both are documented in [docs/03](03-architecture.md) (the diagnostics-dump and
  derived-session-activity subsections). (4) The stitch commit (`e5ef695`) was **non-atomic**
  (`git add -A` swept unrelated churn) — historical; the standing lesson is to stage paths explicitly,
  never `-A`. (5) `dotClass` was **duplicated** across `App.tsx` and `SessionView.tsx`.
  **Fixed 2026-07-13:** consolidated into `@cloakcode/web` `format.ts`.
- **Web client does not auto-reconnect (2026-07-10).** `subscribeSession` (web `bridge.ts`) opens
  the WebSocket with an `error` handler but **no reconnect/backoff**, and the header only offers a
  **manual** "reconnect" button (`App.tsx`). So when the bridge restarts (extension reload / F5 dev
  host, or the machine waking), the phone stays disconnected until the user taps reconnect or
  reloads the PWA. This is **expected** with the current code, not a regression. Fix: auto-reconnect
  the subscribe socket with capped exponential backoff and re-subscribe from the last `seq`, driven
  off the socket `close`/`error`. Queued for the next session. **Done 2026-07-12:** `subscribeSession` auto-reconnects with
  capped exponential backoff + jitter, re-subscribing from the last seq it saw (only missed
  events replay) and reporting a `ConnState` the UI renders.
- **Disconnected state is not reflected in the UI (2026-07-10).** The header's connection dot is
  derived as `connected = state.kind === "ready"` (`App.tsx`) — it tracks whether the last
  `sessions.list` fetch succeeded, not the live socket, and nothing re-checks it, so after a
  mid-session drop it can keep showing **connected** (green) while the bridge is gone. In a session
  view a dropped subscribe socket surfaces only a transient "stream: connection lost" hint and the
  cards keep their last (stale) state. Fix alongside auto-reconnect: derive one connection state
  from the socket `open`/`close`/`error` (+ a heartbeat/ping) and show a clear disconnected banner. **Done 2026-07-12 (session view):** `SessionView`
  derives its connection state from `subscribeSession`'s `onStatus` and shows a Connecting /
  Reconnecting / Disconnected banner. The list header dot (`App.tsx`) still tracks the last
  `sessions.list` fetch, not a live socket — folded into the future `sessions.subscribe`
  live-list work.
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
  **Done 2026-07-12 (a):** `parseTranscript` now supersedes an open interactive start when a
  later turn (`user.message` / `assistant.turn_start`) follows it, so accumulated orphaned
  starts no longer read as "blocked". (b) drive live "blocked" from the spool and (c) a live
  list/header status remain.
- **RESOLVED (2026-07-11).** Three session-list UX items are fixed in `packages/web`
  (`App.tsx`, `SessionView.tsx`): _transcript jump-to-bottom on initial load_;
  _under-surfaced session identity_ (workspace + session id are now labeled in the list rows
  and the session header); and _list grouping + instance label_ (the list now groups by
  **workspace** and labels the instance).
- **Cross-window actuation opens a NEW session by mistake (2026-07-11, deferred — not a
  blocker).** Sending an answer/decision (`session.respond` / `.decide` / `.answer`) to a
  session the bridge's window does **not** own creates a **brand-new chat** in the bridge's
  window instead of driving the intended one. **Root cause:** `scanSessions` lists **every**
  on-disk transcript across all `workspaceStorage/<hash>` and stamps them **all** with the one
  bridge `instanceId`, so it offers sessions the actuator can't reach — the actuator runs
  `vscode.open`/`chat.open` / `acceptTool`/`skipTool` only in the **single window** where the
  bridge process runs, and there is **no on-disk signal** binding a session to its owning
  window (nor any API for a window's own active session id — docs/02 §4.12). A "foreign"
  `sessionId` therefore has no editor/session to open and falls back to a new chat.
  **Repro (both observed/expected):** (1) the session is **visible but no bridge runs in its
  window** — e.g. the extension runs only in the F5 Extension Dev Host, yet the other window's
  sessions are still listed (shared workspaceStorage) and mis-fire into the Dev Host window;
  (2) **VS Code on the host with several workspaces** — the bridge window's workspace is the
  code dir, but **other workspaces' sessions are also visible** (separate `<hash>` dirs) and
  equally un-actuatable. The F5 case shares the **same** workspace hash as the build window, so
  the two are indistinguishable on disk even with workspace-scoping. **Provenance angle:** a
  remote-operator message becoming a real local turn in an **unexpected** window is exactly the
  mis-provenance the non-negotiables warn about. **Options for the picker-up (do not
  re-research):** (a) **scope the list to the bridge window's own `workspaceFolders` hash(es)**
  — kills cross-_workspace_ foreign rows (repro 2) but **not** same-folder-different-window
  (repro 1, identical hash); (b) **stamp ownership from the hook** (it runs in the owning
  Copilot process) into the spool — but the hook is user-global and doesn't know the window's
  bridge `instanceId`, so this needs a way to pass window identity to the hook (**unsolved**);
  (c) **guard the actuator** — warn/deny when ownership can't be proven, plus a UI disclaimer
  that actuation only affects the bridge's window; (d) end-state: **one bridge per window**
  (unified-gateway topology, M4) with the list scoped to that window's sessions. MVP is
  observer-first and the actuator is opt-in, so this is **not a blocker**.
  **Update (owned flag shipped):** `sessions.list` now stamps each row `owned` (true iff a
  live extension serves that session's workspace hash), and the client renders foreign
  sessions **read-only / locked** — composer and every blocker action (send / answer /
  approve) removed, owned groups labeled with their instance name — so a remote operator can
  no longer _fire_ an action at an un-owned session from the UI (option (c), UI-side). This
  is **UI gating only**; the deferred **router + receiving-side guard** (defense in depth,
  required once the bridge is a gateway/leader rather than a pure proxy) is specified in
  [docs/03 → Actuation routing & the receiving-side guard](03-architecture.md#multi-instance-topology--discovery).
  **Fixed 2026-07-12:** the first shipment mis-extracted the hash: our ext id
  `cloakcode.@cloakcode/extension` contains a slash, so `basename(dirname(storageUri))`
  returned `cloakcode.@cloakcode` and every session showed read-only. Now the hash is the
  first path segment under `workspaceStorage/` (`storageHashFromUri`), verified via the bridge
  (this window's sessions are `owned=true`). Added alongside: `workspaceHash` on
  `SessionSummary` (the client groups by it), the owned workspace's real folder name, and a
  `CloakCode: Show Diagnostics` command (+ `CLOAKCODE_DIAG_FILE`) that dumps storageUri and how
  ownership resolved.
- **Session list is not live (2026-07-11, deferred — not a blocker).** A newly-created session
  appears only after a **manual refresh**. **Root cause:** `sessions.list` is one-shot
  request/response (an I0 snapshot) with **no `sessions.subscribe` push and no server-side list
  watcher** — whereas `session.subscribe` **already pushes** per-session via
  `SessionFollower`/`SpoolFollower` **fs.watch**, so the transport is fine; only the list lacks
  a watcher. **Do NOT reach for client polling** — it would regress from the existing push
  model. **Options (direction decided, no re-research):** (a) _cheap interim_ — promote the
  header connection pill (already `onClick={load}`, `title="Refresh"` in `App.tsx`) to an
  explicit **Refresh** button; (b) _proper fix_ — a `sessions.subscribe` push RPC mirroring
  `session.subscribe`, backed by a `ListFollower` that watches the workspaceStorage **root +
  each transcripts dir** (re-arming as new `<hash>` dirs appear; Node's recursive `fs.watch` is
  **unreliable on Linux**, so watch per-dir), debounced re-scan, pushing fresh snapshots on
  change; (c) **recommendation:** build (b) **together with the "over-reports blocked"
  live-status fix** so **one** watcher drives both "new session appears" and "status flips
  (blocked/active)" — DRY, and both list + header go live at once.
- **Multi-instance identity + watch de-dup + workspace-scoping (research 2026-07-11 — see
  `.local/research/workspace-identity-and-watch-dedup.md`).** From the instance-label question
  and the cross-window bug. (1) The `instance` label adds **no value today** — every row carries
  the one scanning bridge's `instanceId` (a constant); it only discriminates under the M4 relay,
  and even then it is a **per-row** attribute shown only when it varies — so drop it from the UI,
  keep it in the data. (2) The extension **can** derive its own **`workspaceHash`** with **no new
  API**: `context.storageUri` is `.../User/workspaceStorage/<hash>/<extId>`, and that `<hash>`
  (= `md5(folderUri)`, VS Code `workspaces.ts`) is the **same** hash as Copilot's
  `.../transcripts`, so the **first path segment of `context.storageUri` under `workspaceStorage/`**
  scopes the scan to this window's workspace and removes cross-_workspace_ foreign rows
  (the common mis-target). **NB not `basename(dirname())`**: our ext id
  `cloakcode.@cloakcode/extension` has a slash, so `dirname` lands a level too deep and
  returns `cloakcode.@cloakcode` (fixed 2026-07-12 via `storageHashFromUri`). Residual: two
  windows on the **same** folder share the hash, and there is **no API for the active session
  id** (`chatSessionsProvider` is _proposed_ and only **provides** a session type) — ambiguous;
  the hook-stamped-owner beacon is the next probe (Q7). (3) **Watch de-dup:** observation is
  location-independent but **actuation is window-local**, so **one leader per environment owns
  ALL observation watches** (docs/03 election) — dedupes the list + hook watchers and caps them
  at one set per environment — while a small **ownership registry** (window → its
  `workspaceHash`(es) + liveness) routes **actuation** to the owner (preferred over a per-watch
  lease protocol). (4) **Monitors:** 1 list-watch + 1 hook/spool-watch + **K lazy transcript
  tails** (only sessions open in a client, not all N). Fold settled parts into docs/03 when chosen.
- **`workspaceStorage` hash instability in containers (2026-07-12 — documented, NOT fixing in MVP).**
  VS Code derives `workspaceStorage/<hash>` from the workspace URI, and in Dev Containers the hash can
  **change** across rebuilds / `devcontainer.json` edits / "at random" (upstream
  **microsoft/vscode#285059**, closed _not planned_; cf. 23min/agent-lens#26). On **persistent**
  storage the old sessions are then stranded under the **previous** hash dir and vanish from Copilot's
  UI (mitigation: scan sibling hash dirs by folder-name, tag "recovered"); on **ephemeral** storage
  (our overlay) a rebuild instead **deletes** them. **Accept for MVP, don't mitigate.** Implication for
  the future workspace-scoped scan (#32/Q7): scope to the **folder across all its hash dirs**, not a
  single hash, or relocated sessions get hidden. **Partial mitigation shipped (2026-07-14):** the
  session list now de-dupes by `sessionId` (prefer owned) in both the scanner and the gateway merge,
  so a session surfacing under two hash dirs shows **once** even though the underlying hash
  instability remains. Detail in
  `.local/research/workspace-identity-and-watch-dedup.md`.
- **Source strategy — debug-log primary + stitch the transcript for history (decided 2026-07-12).**
  Neither source is complete alone: the **debug-log has the latest answer** (per-turn `agent_response`)
  but truncates ~5 KB (§4.21, salvaged) and **loses history on rebuild** (§4.22); the **transcript** is
  untruncated and rehydrates history on rebuild but is **always one turn behind** (§4.23, never the
  latest). **Decision:** debug-log **primary** (carries the live/latest turn); **detect** when it is
  incomplete (its earliest turn is later than the transcript's — i.e. post-rebuild) and **stitch**
  transcript's older turns + debug-log's recent turns (boundary = the debug-log's `session_start`).
  "Best we can do." **Built 2026-07-12:** `findSessionLog` reads the transcript once and
  `stitchEvents` finds where the debug-log opens in it (its first user message) and prepends
  the earlier transcript events — the debug-log leads from there. Ids are namespaced
  (`tx-`/`dl-`) so the two logs don't collide, and the debug-log's opening turn is fixed so
  the live tail stays resume-safe.
- **Token-live monitoring needs a disclaimer (reminder, 2026-07-12).** The token-live "monitoring"
  mode (#13 — own the `vscode.lm` loop / token streaming) must carry a **disclaimer**: the observed
  view can lag or omit the newest content (transcript flush lag §4.23; debug-log truncation §4.21) and
  is a best-effort mirror, not a guaranteed-complete copy of Copilot's own session.
