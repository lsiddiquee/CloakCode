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
- **Remote approval is `remote-operator`, fail-safe to local.** The take-control toggle and each
  allow/deny (`session.control` / `session.decide`) are `remote-operator` actions delivered only
  via a **localhost file** (the hook's on-disk decision file) — never a network write on the
  bridge, never GitHub. Blocking is **opt-in per session** and **falls through to native VS Code**
  on timeout, so the local user is always the backstop. CloakCode only ever tightens a native
  prompt into a remote one — it defers to global auto-approve / the operator's allow-list and never
  auto-approves what VS Code would have blocked (docs/03 "blocking-hook handoff", docs/02 §4.15).

## Tunnel & transport

- Bridge ↔ extension: localhost WS / Node IPC (no network exposure).
- Remote client ↔ bridge: WireGuard / SSH reverse-forward / mTLS to your infra, with
  token/mTLS auth so only your controller can drive it.

## Threat-model quick list

| Threat                      | Mitigation                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Code exfiltration           | No sync path; localhost bridge; redaction gate; token budget.                              |
| Reflected prompt injection  | Provenance tagging; distinguish staged vs human input; confirm remote destructive actions. |
| Unauthorized remote control | mTLS/token auth on the tunnel; localhost-only bind.                                        |
| Sensitive data in prompts   | Secret/entropy scan blocks before send; audit log.                                         |
| Tool output tampering       | Treat tool/log content as untrusted input; validate at the boundary (zod).                 |
