# 04 — Security & compliance

The defining constraint (R1) is **your code never syncs to GitHub or a third party**. CloakCode
adds no new path that sends your code anywhere Copilot doesn't already; the session mirror is
deliberately viewed on _your_ devices over _your_ tunnel. This document records how that is
enforced and the security lessons the investigation surfaced.

## Zero code-sync — enforced by architecture, not policy

- **No git-remote path exists in CloakCode.** The extension has no code that runs
  `git push`, calls the GitHub REST API, or syncs a repo. The guarantee is structural.
- **The bridge binds to `127.0.0.1` only.** Nothing is network-listening beyond localhost;
  remote access is exclusively via an explicit tunnel to _your_ infrastructure.
- **Egress allowlist.** Any future remote-ops destinations are explicitly allowlisted;
  GitHub domains are simply never on it.
- **No new egress path by construction.** CloakCode **mirrors** Copilot's own transcript and
  **relays** your prompts into Copilot; it does not assemble or upload workspace context of its
  own. Whatever reaches the phone is what you already gave Copilot — there is no API surface that
  serializes the workspace to a model or a third party.

## Bounded, self-owned egress

The mirror + relay architecture means there is **no new code→model path to gate**: CloakCode shows
you Copilot's own transcript and relays your prompts into Copilot, which sends context to the model
exactly as it would if you typed locally. The controls that matter are about **where the mirror
goes**, not scrubbing content:

- **No auto-harvest.** CloakCode never auto-attaches files/selection/context the operator didn't
  choose; it forwards only the operator's message.
- **Your own agent/entitlement.** If CloakCode ever runs its own model loop (post-MVP owned loop),
  it does so through your own consented entitlement — Copilot via `vscode.lm` / the `@github/copilot`
  SDK / Copilot CLI over ACP, or your own agent — never a third party you didn't choose.
- **Your bridge + tunnel only.** The mirror binds `127.0.0.1` and reaches the phone only over your
  authenticated tunnel (below); it never touches GitHub.

## Model-side data handling

`vscode.lm` routes through the user's Copilot entitlement and shows a **native consent
dialog** on first use — an auditable checkpoint. Check that your Copilot plan
(Business/Enterprise) puts the redacted snippets that _are_ sent under the
no-training-on-prompt guarantees.

## Prompt-injection provenance (a lesson learned the hard way)

During testing, a marker prompt that CloakCode **injected** into the chat input was later
**queued and auto-submitted**, arriving back as a genuine `user.message` — a benign
**prompt-injection loop** (reflected text became an instruction the agent then followed).

Design implications for an actuator that can stage/inject prompts:

- **Tag provenance.** Every message must carry a source label — `genuine-local-user`,
  `remote-operator`, `cloakcode-staged` — end to end.
- **Never let reflected/staged text be treated as trusted user intent.** The agent loop and
  the operator UI must both distinguish injected content from human input.
- **Destructive actions are Copilot's, gated by Copilot.** CloakCode inserts no processing layer;
  a destructive **tool** call is gated by VS Code's own native approval, which the operator
  allows/denies remotely (`session.decide`) — so there is no extra CloakCode confirm layer to add.
- **Session action log.** The bridge records each remote action per `sessionId` (redacted:
  event + provenance + token _counts_ / booleans, hashed body — never the body) so what left,
  and why, is reviewable. Best-effort local, like Copilot's transcripts — not a hard audit
  trail; see docs/03 "Session action logs".
- **Remote approval is `remote-operator`, fail-safe to local.** Each allow/deny (`session.decide`)
  and structured answer (`session.answer`) is a `remote-operator` action carried only over the
  **localhost** bridge to the extension host, which relays it to VS Code’s **own** confirmation via
  a command (`workbench.action.chat.acceptTool`/`skipTool`, `_chat.notifyQuestionCarouselAnswer`) —
  never a network write, never GitHub. CloakCode **never blocks or auto-approves** on its own: VS
  Code’s native prompt still appears and whoever answers first wins, so the local user is always
  the backstop. The command is targeted by **exact** session URI, so a stale/wrong id is a safe
  no-op and can never approve a different session (docs/03 “Remote approval”, docs/02 §4.20).
- **Steer / stop / stop-and-send are `remote-operator`, command-only.** The mid-turn actions
  (`session.steer`, `session.stop`) and the queued send (`session.respond`) all reach VS Code only
  through public `workbench.action.chat.*` commands after focusing the session URI — never a network
  write, never GitHub. Each is tagged `remote-operator`; a steered redirect is recorded on disk as an
  ordinary `user.message` (docs/02 §4.28), so the loop/UI must keep treating it as operator-origin,
  not reflected human intent. `chat.cancel` only halts the runner's own turn.

## Tunnel & transport

- Bridge ↔ extension: localhost WS / Node IPC (no network exposure).
- Remote client ↔ bridge: WireGuard / SSH reverse-forward / mTLS to your infra, with
  token/mTLS auth so only your controller can drive it.

## Bridge ingress validation (what a non-CloakCode client can send)

The bridge is a WebSocket server that **any** client on the loopback — or, once tunnelled, anything
that reaches the tunnel URL — can connect to, so every frame is treated as untrusted.

- **Enforced today (proper format).** Each frame is `JSON.parse`d then validated with
  `rpcRequestSchema.parse` in `handleMessage` (`bridge.ts`): anything that is not exactly a known
  `op` with correctly-typed `params` is rejected with `{ ok:false, error:"invalid request" }` and
  never reaches an actuator. This is **regression-tested** (`bridge.test.ts`: non-JSON, unknown op,
  and a valid op with invalid params are all rejected; a well-formed answer full of shell
  metacharacters + emoji is passed through **verbatim as opaque data**), so a refactor cannot
  silently drop the check.
- **Required PRE-MVP (content cleaning + auth — NOT yet built).**
  1. **Content limits / sanitization.** Structural validation checks _type_, not _content_:
     `text` / answers are `z.string()` with no upper bound, no control-character handling, and there
     is no max frame size or per-connection rate limit. Add length caps, a frame-size cap,
     control-char normalization, and rate limiting before the bridge is reachable beyond localhost.
  2. **Client authentication.** The bridge currently trusts any client that can reach it (no
     PIN / token / mTLS). Gate the WebSocket upgrade with an operator secret (the TaskSync
     PIN + lockout + device-approval pattern) so a non-CloakCode client — including anything that
     discovers the tunnel URL — cannot drive it. See docs/05 M4.

## Gateway selection (explicit only)

Gateway mode is entered **only** when `cloakcode.gatewayUrl` (or the `CLOAKCODE_GATEWAY_URL` env var)
explicitly names a hub. The earlier opt-in local **auto-discovery** (knock-probe) was **removed
2026-07-15**: it auto-connected the extension as a provider to whatever answered a known-local port,
which — until gateway auth (M4) — meant a hostile local process squatting on that port could pose as
the gateway and harvest session data. Requiring an explicit URL removes that trust surface entirely:
the extension never connects out unless you name the endpoint. (Provider registration binds localhost
and the tunnel goes through your own infra, never GitHub — the zero-code-sync rule is unchanged.)

When M4 lands, discovery must additionally verify the hub's identity (shared operator secret /
mTLS) before a provider hands over any session data.

## Authentication (two separate boundaries)

CloakCode has two trust boundaries, authenticated **differently** — do not conflate them:

- **Provider ↔ gateway (machine-to-machine).** An extension registers with your standalone
  gateway by presenting a **shared secret** in its `provider` hello (`CLOAKCODE_GATEWAY_TOKEN` on
  the gateway; `cloakcode.gatewayToken` / the same env on the extension). The gateway verifies it
  **timing-safe** (`verifyGatewayToken`) and closes the connection on mismatch, before the provider
  can register or serve any RPC. It is **never** exchanged with, embedded in a link/QR for, or shown
  to the operator. Off when no token is set (loopback dev). A shared token is right-sized for a
  gateway you run; **mTLS** is a post-MVP hardening (per-provider identity + revocation) and, because
  the token rides the hello frame rather than the transport, swapping to it doesn't churn the app
  protocol.
- **Gateway ↔ operator (the human/phone).** A **separate**, user-facing auth — a PIN / OTP /
  device-pairing ladder (docs/05 Q9). **Deferred**: the interim compensating control is the
  **authenticated private tunnel** (its own sign-in) plus the loopback default; do not expose a wide
  bind on an untrusted network until this lands.

## Threat-model quick list

| Threat                      | Mitigation                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Code exfiltration           | No sync path; no new code→model path (mirror/relay, no auto-harvest); localhost bridge + your tunnel. |
| Reflected prompt injection  | Provenance tagging; distinguish staged vs human input; native tool approval gates destructive calls. |
| Unauthorized remote control | Provider↔gateway shared-secret (in the hello, timing-safe); operator via the private tunnel (app-layer PIN deferred, Q9); localhost-only bind. |
| Rogue local gateway (discovery) | Discovery off by default; local-only candidates; no network/tunnel scan; hub auth at M4. |
| Sensitive data in prompts   | Secret/entropy scan blocks before send; session action log.                                |
| Tool output tampering       | Treat tool/log content as untrusted input; validate at the boundary (zod).                 |
