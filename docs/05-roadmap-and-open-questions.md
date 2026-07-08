# 05 — Roadmap & open questions

## What's proven vs. what's left

- **Proven (read half):** list sessions · view transcript · track blockers · surface
  multiple-choice richly. All server-side, no proposed API, works for stock sessions.
- **Left (write half):** answer/steer a session remotely — the actuator.

## Open questions

| # | Question | Why it matters | How to answer |
|---|---|---|---|
| Q1 | Command IDs for **Steer with Message** / **Stop and Send** / **Add to Queue**? | "Steer" is the ideal remote blocker-answer primitive. | Inspect the desktop **client's** `workbench.desktop.main.js` (not on the server); or run inside a live window and dump chat commands. |
| Q2 | Does the `@github/copilot` **agent-host SDK** expose a live input/steer channel? | Lighter-weight actuator than owning the whole loop. | Read `.../extensions/copilot/dist/extension.js` + `node_modules/@github/copilot/sdk/index.js` and `agent-host-config.json`. |
| Q3 | Can a **prose-only** blocker (question ending a turn, no tool) be detected? | The one blocker class the observer currently misses. | Compare `assistant.turn_end` patterns; possibly infer via "open turn, quiet for N s." |
| Q4 | Are UI-layer **tool-approval confirmations** (run terminal / apply edits) observable, and how? | The most common agent blocker. The current detector's interactive-hint list (`ask/question/confirm/input/elicit`) would **miss** an approval that surfaces as an unmatched **action-tool** start (e.g. `run_in_terminal`). | **Partially checked (2026-07-08).** The event vocabulary holds — no distinct approval event type; under **auto-approve**, `run_in_terminal`/edit tools log as ordinary matched `start`→`complete` (median ~2.1 s, all balanced). Still open: capture a transcript while an approval is **pending** (auto-approve off) to confirm whether it appears as an unmatched action-tool `start` vs. a separate signal — then broaden blocker detection accordingly. |
| Q5 | Do **queued/steered** messages carry any structural marker? | Cleaner provenance for the actuator. | Inspect a session where steer/queue is used with known text. |
| Q6 | How do **many concurrent instances** (dev containers, WSL distros, host) get discovered without port collision? | The extension runs in every window; `127.0.0.1` is not shared across environments, so a fixed port false-collides (WSL↔host) and can't cross namespaces (containers). | **Two-tier** (see [03 — Multi-instance topology](03-architecture.md#multi-instance-topology--discovery)): one leader observer **per environment** (lock file in `globalStorage`, since one `~/.vscode-server` User dir = all repos in that env), each leader **registers outbound** to a rendezvous relay that serves the union to the phone. Needs `instanceId` in the protocol (M1) + ephemeral bridge port. |

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

> The rendezvous **relay** that unifies *different* environments (distro↔distro, host↔WSL,
> container↔container) is **M4** (with the tunnel). M1 only bakes in the `instanceId` seam and
> the per-environment leader so no rework is needed later.

### M2 — PWA client

- `@cloakcode/web`: session list + live mirror, component-per-`SessionPart`, resumable
  stream (`lastSeq`), Web Push on `awaiting-input`, installable manifest.

### M3 — Actuator

- Resolve Q1/Q2. Implement `session.respond` for the owned loop (deterministic) and a
  best-effort queue/steer path for stock sessions.
- `@cloakcode/agent`: pausable tool-calling loop with confirmation gates via `vscode.lm`.

### M4 — Secure tunnel + hardening

- mTLS/token auth, provenance tagging (see security doc), redaction gate, audit log,
  tunnel to your infra.
- **Rendezvous relay** (Q6): each environment's leader registers outbound; the relay serves
  the union of all instances to the phone, keyed by `instanceId`. This is where multi-instance
  discovery across dev containers / WSL distros / host is actually stitched together.

### M5 — Packaging

- Private `.vsix` via `@vscode/vsce`; PWA deploy behind the tunnel.

## Explicitly deferred

- Native VS Code chat-UI mirroring via proposed `chatSessionsProvider` (sideload-only).
- Multi-remote "command centre" for non-Copilot tools (the extensibility groundwork exists
  in the bridge, but no second controller is built yet).
