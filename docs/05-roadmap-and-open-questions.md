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

**Built** — both answer channels now work: **questions** via targeted chat-submit
(`session.respond {text}` → two-step `vscode.open` + `chat.open`, docs/02 §4.12) and **approvals**
via the opt-in **take-control blocking hook** (`session.control` + `session.decide`, docs/03
"blocking-hook handoff", docs/02 §4.15). The design rationale below held up in the build.

The crux is the hook-block mechanism and its **native-prompt suppression** property:

- A `PreToolUse` hook runs **synchronously**: while it blocks, Copilot **waits on the hook** —
  the tool has not run **and the native VS Code approval prompt has not appeared yet**. Only
  when the hook exits does Copilot act: `allow`/`deny` → bypass native and proceed/block; empty
  `{}`/`ask` → the native prompt appears **now** for the local user.
- **Therefore native-local and phone-remote are mutually exclusive _in time_.** If the hook
  blocks to wait for the phone, the desktop shows only a spinner (no native prompt) during the
  wait; if it returns immediately to show the native prompt, the phone can no longer resolve it.
  "First-responder-wins across both surfaces" only holds when **CloakCode's own card is the
  surface on the desktop too** — which conflicts with "keep answering natively at my desk".
- **Reconciliation (built): an opt-in "take control" toggle.** Default = the shipped
  non-intrusive notifier (native local, zero blocking). The operator flips **remote control ON**
  (per session) from the phone (`session.control`); the extension writes a per-session policy
  `~/.cloakcode/control/<sessionId>.json` the hook reads at runtime, and only then does the hook
  **block + poll the spool for a decision** and return `allow`/`deny`. It defers (emits `{}`) when
  VS Code would auto-approve by a reachable signal (global auto-approve / the operator's allow-list),
  so it **only blocks if VS Code would have blocked** (docs/02 §4.15). Bounded by the hook `timeout`
  (raised to 120 s for PreToolUse) with a safe fallback (fall through to native) on expiry.
- **Scope of M3b — two complementary answer channels (docs/02 §4.7):**
  - **Approvals → hook `allow`/`deny`.** Deterministic. `session.decide {sessionId,
toolCallId, decision}` (tagged `remote-operator`) writes the hook's on-disk decision file; the
    held hook reads it and emits `hookSpecificOutput.permissionDecision`. Text/prompt does **not**
    approve a native modal.
  - **Questions → injected text.** A submitted chat message _is_ interpreted as the answer
    (verified), so a question needs a **chat-submit** path, not the hook. This requires the
    extension host to call a chat-input/submit command (Q1) with the answer text — lighter than
    owning the loop. `session.respond {sessionId, toolCallId, text}` routes the answer.
  - Token streaming still needs **owning the loop** (`@cloakcode/agent` via `vscode.lm`) — a
    later, user-selectable "live" mode.
- **Confirmed:** a blocking hook holds synchronously for its full runtime (15s + 90s probed,
  under `timeout: 300`); over-`timeout` kill behaviour is still unprobed (not a blocker — local
  is the fallback).
- Q1 (chat-submit command IDs) is now **on the critical path** for the question channel; Q2/Q5
  (agent-host SDK / steer) remain superseded for approvals by the hook path.

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
- **Per-session allow-list ("Allow for session").** A third option on the take-control approve card
  — beyond one-off Allow/Deny — that appends the tool to the session's `allow[]` policy so future
  calls of that tool **defer** instead of re-prompting. The operator-driven analog of VS Code's
  "Allow in this Session", and the reachable substitute for the read/write-path + shell rules we do
  not replicate (docs/02 §4.15). The hook already respects `policy.allow`; this is just the write
  path (extend `session.decide` with `scope: "once" | "session"` + the button). **Deferred from
  MVP.** Only relevant to Default-mode take-control; without it, take-control re-prompts every
  non-auto-approved tool. (Not needed for the common "bypass + drive the questions myself" flow.)
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
