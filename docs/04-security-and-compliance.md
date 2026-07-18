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

- **Enforced today (format + bounds + ownership).** Each frame is `JSON.parse`d then validated with
  `rpcRequestSchema.parse` in `handleMessage` (`bridge.ts`): anything that is not exactly a known
  `op` with correctly-typed `params` is rejected with `{ ok:false, error:"invalid request" }` and
  never reaches an actuator. On top of the format check:
  - **Input bounds.** WebSocket frames are capped at `MAX_WS_PAYLOAD_BYTES` (4 MiB, via `ws`
    `maxPayload`) on **both** the bridge and gateway; operator free-text (answers / prompts /
    steer / stop) is bounded by `MAX_RPC_TEXT_LEN` (100k chars) in the schemas; and each operator
    connection is **rate-limited** (token bucket, burst 40 / 20 msg·s⁻¹) at both ingresses.
  - **Ownership re-check.** Every actuator (`respond` / `decide` / `answer` / `steer` / `stop`)
    re-verifies the target session is **owned** by this window (`BridgeDeps.isOwned`) — the UI hides
    controls for foreign sessions, but a direct RPC is rejected here too, so a `remote-operator`
    action can never land in a window that doesn't own the session.

  This is **regression-tested** (`bridge.test.ts`: non-JSON, unknown op, and a valid op with invalid
  params are all rejected; a well-formed answer full of shell metacharacters + emoji is passed through
  **verbatim as opaque data**; over-length text is rejected; an actuator on a non-owned session is
  refused), so a refactor cannot silently drop the checks.
- **Required PRE-MVP (content cleaning + auth — NOT yet built).**
  1. **Content normalization.** The bounds above cap _size_ and structural validation checks _type_,
     but neither normalizes _content_: control-character normalization is still TODO before the
     bridge is reachable beyond localhost.
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

CloakCode has two trust boundaries. They stay **separate blast radii**, but the standalone gateway
now authenticates **both** against the **same operator TOTP secret** (F2a slice 2) — the operator
enters a code on their phone, a provider enters one once in VS Code; neither ever holds the secret,
only a derived token.

- **Provider ↔ gateway (extension → hub).** An extension registers by presenting a credential in its
  `provider` hello, verified by `verifyProviderCredential` before it can register or serve any RPC.
  Two accepted forms:
  - **TOTP→token (default, interactive).** A human runs **CloakCode: Sign in to Gateway**, enters a
    6-digit code once; the extension exchanges it (via the gateway's operator `auth` handshake) for a
    long-lived (30d) **session token**, stores it in SecretStorage (per gateway), and presents it in
    the hello. The provider **never holds the TOTP secret** — only a token the operator secret
    issued — so the secret's blast radius stays gateway+phone. On refusal the gateway sends
    `provider.auth_required`; the extension surfaces a sign-in prompt (`GatewayAuthRequiredError`)
    and **stays in gateway mode without falling back to the embedded bridge** — an unreachable hub
    falls back, but a reachable-yet-auth-blocked one must not start a competing bridge (which would
    add a second, confusing operator-MFA enrolment). It connects once the user signs in.
  - **Static shared secret (demoted escape hatch).** `CLOAKCODE_GATEWAY_TOKEN` / `cloakcode.gatewayToken`
    still works, verified **timing-safe** (`verifyGatewayToken`) — for headless / automation /
    bootstrap setups where interactive sign-in isn't practical.
  When **neither** is configured the provider link is open (loopback dev). The **embedded** bridge
  has no provider link at all — the operator TOTP is its whole story. The credential is **never**
  exchanged with, embedded in a link/QR for, or shown to the operator. **mTLS** (per-provider
  identity and revocation) remains a post-MVP hardening; because credentials ride the hello frame
  rather than the transport, swapping to it doesn't churn the app protocol.
- **Gateway ↔ operator (the human/phone).** A **separate**, user-facing auth: **operator TOTP**
  (F2a). When enabled, an operator connection starts **unauthenticated** — every session RPC is
  refused with `needsAuth` until the operator sends an `auth` op carrying a 6-digit TOTP `code` (or
  resumes with a previously-issued session `token`). A valid code issues a signed bearer **session
  token** (HMAC over the secret; **12h** default, **30d** with "remember this device") the client
  stores to resume without re-entering a code. Defense-in-depth beyond the tunnel's own sign-in: a
  **replay guard** (each 30s TOTP step is accepted at most once) and per-connection **lockout**
  (close after 5 bad codes). The gate is shared (`OperatorAuth`/`OperatorGate` in
  `@cloakcode/gateway`) and identical for the embedded bridge and the standalone hub; unset ⇒ open
  (the loopback-only default). **Enabled by exposure** (wide bind / live tunnel), off for pure
  loopback. The **stateless** bearer token means no server-side session store — each fresh socket
  re-presents the token (an `auth` prelude) and the gate re-verifies it, so reconnects/phone-sleep/
  multiple tabs need no shared state.
- **First-run enrolment (browser-driven).** A freshly generated secret is **unconfirmed**: the
  ingress enters **enrolment mode** and serves _only_ pairing — every session op is refused with
  `enrolmentRequired` until a code is verified, so **no session data is exposed before MFA is truly
  on**. The client calls `enrol.begin` to get the otpauth provisioning, renders the QR to scan into
  an authenticator app, then verifies one code (`auth`), which **confirms** enrolment (persisted) and
  logs in. This closes the "unconfirmed window" hole — nothing sensitive is served while unconfirmed.
  Rationale for revealing the secret over the bridge during enrolment: you deploy this yourself on a
  trusted network, so the brief enrolment window is not a meaningful attack surface — the point is to
  be secured _before_ the link goes onto a public network.
  - **Strict enrolment (Option B, opt-in):** `CLOAKCODE_MFA_ENROL=strict` / `cloakcode.mfaEnrolment:
    strict` never sends the secret over the wire — the QR is shown **out-of-band** (gateway console /
    VS Code webview) and the browser only submits the verify code.
- **Secret provisioning is per-host.** The **embedded** bridge keeps the base32 secret in VS Code
  **SecretStorage** (OS keychain), the confirmed flag in `globalState`. The **hosted** gateway keeps
  `{secret, confirmed}` in `CLOAKCODE_MFA_SECRET_FILE` (`~/.cloakcode/`, `0600`; a mounted volume in
  Docker), toggled by `CLOAKCODE_MFA=off|required`. The secret is **never** logged, and (outside
  first-run pairing / strict out-of-band) never re-revealed.
- **Lockout recovery.** Regenerate the secret to re-enrol from scratch: `CLOAKCODE_MFA_RESET=1` on
  the gateway (or delete the secret file); **CloakCode: Reset Operator Access (TOTP)** in VS Code. A
  running gateway can't be reset remotely (no remote admin) — only by whoever controls the process.
- **Multiple gateways (e.g. office + home).** Each gateway has its own secret and its own **instance
  id** (the otpauth `account`, so the authenticator reads `CloakCode: <id>`, and the name the phone
  shows in its header). It defaults to the **machine hostname**, so gateways on different machines are
  already distinguishable; set a distinct `CLOAKCODE_INSTANCE_ID` per gateway (`office` / `home`) when
  running several on one host. The extension stores each gateway's issued **provider token per URL**
  (`providerToken:<gatewayUrl>` in SecretStorage), so switching `cloakcode.gatewayUrl` between them
  never re-pairs, and the tokens are scoped — one gateway's token is never presented to another.

## Repository security automation

Repository controls complement the runtime architecture; they do not add a product egress path:

- Dependabot checks the pnpm workspace, Poetry tooling, gateway container, and GitHub Actions weekly.
  GitHub's separate **Dependabot security updates** setting is enabled for vulnerable dependencies.
- CodeQL analyzes JavaScript/TypeScript on pushes and pull requests to `main`, weekly, and on manual
  dispatch. The workflow grants only `contents: read`, `packages: read`, and
  `security-events: write`.
- Dependency review rejects pull requests that introduce a high- or critical-severity vulnerable
  dependency.
- `main` branch protection requires the existing build/test, pre-commit, and coverage jobs with
  strict up-to-date checks, in addition to its review and linear-history rules.
- Secret scanning and push protection are enabled in the repository. GitHub currently leaves
  non-provider pattern scanning and validity checks disabled for this repository even when requested
  through the API; re-check those options in **Settings → Code security** if the repository's feature
  availability changes. Private vulnerability reporting is enabled; disclosure instructions live in
  [`SECURITY.md`](../SECURITY.md).

**Maintainer follow-up after first deployment:** once CodeQL and dependency review have run from
`main` and GitHub exposes their check contexts, add those two jobs to the branch's required status
checks. GitHub cannot select a check context before it has been reported. Review and merge Dependabot
security updates promptly. The initial critical Vitest advisory was remediated on 2026-07-17 by
upgrading Vitest and its coverage provider, now at 4.1.10. The remaining Vite/esbuild advisories
were remediated the same day with Vite 6.4.3 and esbuild 0.25.12; `pnpm audit` reports no known
vulnerabilities.

## Threat-model quick list

| Threat                      | Mitigation                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Code exfiltration           | No sync path; no new code→model path (mirror/relay, no auto-harvest); localhost bridge + your tunnel. |
| Reflected prompt injection  | Provenance tagging; distinguish staged vs human input; native tool approval gates destructive calls. |
| Unauthorized remote control | Provider↔gateway shared-secret (in the hello, timing-safe); operator **TOTP** (F2a — `auth` op, session token 12h/30d, replay guard + lockout) enabled by exposure, over the private tunnel; localhost-only bind. |
| Rogue local gateway (discovery) | Discovery off by default; local-only candidates; no network/tunnel scan; hub auth at M4. |
| Sensitive data in prompts   | Secret/entropy scan blocks before send; session action log.                                |
| Tool output tampering       | Treat tool/log content as untrusted input; validate at the boundary (zod).                 |
