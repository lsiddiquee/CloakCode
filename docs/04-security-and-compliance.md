# 04 — Security & compliance

The defining constraint (R1) is **the codebase never leaves the local machine**. This
document records how that is enforced and the security lessons the investigation surfaced.

## Zero code-sync — enforced by architecture, not policy

- **No git-remote path exists in CloakCode.** The extension has no code that runs
  `git push`, calls the GitHub REST API, or syncs a repo. Compliance is structural.
- **The bridge binds to `127.0.0.1` only.** Nothing is network-listening beyond localhost;
  remote access is exclusively via an explicit tunnel to _your_ infrastructure.
- **Egress allowlist.** Any future remote-ops destinations are explicitly allowlisted;
  GitHub domains are simply never on it.
- **Context minimization by construction.** The only outbound payload is what the Context
  Redactor assembles (active selection, symbol _signatures_, nearby diagnostics) — there
  is no API surface that can serialize the workspace.

## Context redaction gate

Before any prompt/context is sent to a model or across the bridge:

1. Start from the selection (or a small radius around the cursor), not whole files.
2. Prefer **symbol signatures** (via the document-symbol provider) over full bodies.
3. Run a **secret/entropy scan** (AWS keys, PATs, `.env` values, private keys) and block on match.
4. Enforce a hard **token budget** (`model.countTokens`) — a mechanical cap on egress.

## Model-side data handling

`vscode.lm` routes through the user's Copilot entitlement and shows a **native consent
dialog** on first use — an auditable checkpoint. Verify the tenant is on Copilot
Business/Enterprise so the redacted snippets that _are_ sent fall under the
no-training-on-prompt contractual guarantees.

## Prompt-injection provenance (a lesson learned the hard way)

During testing, a marker prompt that CloakCode **injected** into the chat input was later
**queued and auto-submitted**, arriving back as a genuine `user.message` — a benign
**prompt-injection loop** (reflected text became an instruction the agent then followed).

Design implications for an actuator that can stage/inject prompts:

- **Tag provenance.** Every message must carry a source label — `genuine-local-user`,
  `remote-operator`, `cloakcode-staged` — end to end.
- **Never let reflected/staged text be treated as trusted user intent.** The agent loop and
  the operator UI must both distinguish injected content from human input.
- **Confirm remote-origin actions.** Remote-submitted prompts that trigger
  irreversible/destructive actions should require an explicit confirmation surfaced back to
  the operator.
- **Audit log.** The bridge records every prompt (redacted/hashed body + token count + model
  - provenance) so exactly what left — and why — is reviewable.
- **Remote approval is `remote-operator`, fail-safe to local.** Each allow/deny (`session.decide`)
  and structured answer (`session.answer`) is a `remote-operator` action carried only over the
  **localhost** bridge to the extension host, which relays it to VS Code’s **own** confirmation via
  a command (`workbench.action.chat.acceptTool`/`skipTool`, `_chat.notifyQuestionCarouselAnswer`) —
  never a network write, never GitHub. CloakCode **never blocks or auto-approves** on its own: VS
  Code’s native prompt still appears and whoever answers first wins, so the local user is always
  the backstop. The command is targeted by **exact** session URI, so a stale/wrong id is a safe
  no-op and can never approve a different session (docs/03 “Remote approval”, docs/02 §4.20).

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

## Threat-model quick list

| Threat                      | Mitigation                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Code exfiltration           | No sync path; localhost bridge; redaction gate; token budget.                              |
| Reflected prompt injection  | Provenance tagging; distinguish staged vs human input; confirm remote destructive actions. |
| Unauthorized remote control | mTLS/token auth on the tunnel; localhost-only bind.                                        |
| Sensitive data in prompts   | Secret/entropy scan blocks before send; audit log.                                         |
| Tool output tampering       | Treat tool/log content as untrusted input; validate at the boundary (zod).                 |
