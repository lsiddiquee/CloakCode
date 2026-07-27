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
- **Current status (drift audit B4 — honest scope).** Provenance is enforced **operationally**, not
  yet **structurally**. The operator UI and the per-session action log distinguish `remote-operator`
  / `cloakcode-staged` from human input, and the actuator only reaches VS Code through
  provenance-tagged commands — but once VS Code **persists** an injected/steered message it is an
  ordinary `user.message` on disk with **no carried tag**. So today's guarantee is "the actuator
  reaches VS Code only via provenance-tagged commands + a tagged action-log record," **not** "every
  persisted message carries a structural source label end to end." Structural per-message provenance
  (a tag that survives into the transcript so the agent loop can hard-refuse reflected text) is
  **post-MVP**.
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
  the backstop. The command is targeted by **exact** session URI, so a wrong id can never approve a
  **different session**; and within a session `decide` **fails closed** unless the requested
  `toolCallId` is still the pending call, so a **stale** approval can't resolve a newer one (drift
  audit S5; docs/03 “Remote approval”, docs/02 §4.20).
- **Steer / stop / stop-and-send are `remote-operator`, command-only.** The mid-turn actions
  (`session.steer`, `session.stop`) and the queued send (`session.respond`) all reach VS Code only
  through public `workbench.action.chat.*` commands after focusing the session URI — never a network
  write, never GitHub. Each is tagged `remote-operator`; a steered redirect is recorded on disk as an
  ordinary `user.message` (docs/02 §4.28), so the loop/UI must keep treating it as operator-origin,
  not reflected human intent. `chat.cancel` only halts the runner's own turn.

## Tunnel & transport

- Bridge ↔ extension (embedded): localhost WS / Node IPC (no network exposure).
- Remote client ↔ gateway: a private **Dev Tunnel** you own, or WireGuard / SSH reverse-forward /
  reverse proxy to your infra — never GitHub.

### Transport confidentiality (authentication ≠ encryption)

Provider + operator **TOTP authenticate** the two hops (see
[Authentication](#authentication-two-separate-boundaries)); they do **not** encrypt them. The posture
is leg-by-leg:

- **Phone → gateway:** already TLS on the private **Dev Tunnel** — its ingress terminates HTTPS/WSS
  (Microsoft cert, HSTS, TLS 1.2+) and forwards over loopback; the PWA derives `wss:` from the page
  origin (`packages/web/src/bridge.ts`). Nothing crosses the wire in clear.
- **Extension → gateway (the dedicated provider listener):** `wss://` **by default** (an
  auto-generated or BYO cert), so nothing crosses the wire in clear. The **insecure opt-in**
  (`CLOAKCODE_PROVIDER_INSECURE`) serves it as plain `ws://` — then a passive sniffer on that segment
  recovers the **provider token** (sent in the hello + every reconnect → replayable) and the whole
  **mirrored transcript**, and an active MITM can modify it. TOTP does not help there — it
  authenticates, it doesn't conceal — so the insecure listener is **trusted-network-only** and is
  warned in the console + UI (below).

**Empirical (2026-07-18):** an extension cannot reach the gateway's _private_ Dev Tunnel by only
setting `cloakcode.gatewayUrl` — the Node `ws` upgrade to `/bridge` gets an `unexpected-response`
`302` to the tunnel's sign-in and closes (the extension mis-reports it as the 4 s "unreachable"
timeout → embedded fallback). Riding the tunnel needs a `devtunnel connect`-scoped token; those are
**~24 h-lived** (daily re-tokening = high friction), so it stays an explicit documented path, not a
default.

**Closing the gap — role-split listeners + safe server identity (design finalized 2026-07-20;
listener split 2026-07-23).** The gateway binds **two role-scoped listeners** so the two legs are
independently securable (docs/03):

- the **operator listener** — the PWA (HTTP) + the phone WebSocket — binds `CLOAKCODE_GATEWAY_HOST`
  (default loopback `127.0.0.1`) and is fronted by the private **Dev Tunnel** (which supplies TLS); it
  serves **operators only** (a provider that knocks here is refused);
- the **provider listener** — the dedicated endpoint extensions connect to — binds `CLOAKCODE_TLS_HOST`
  (default `127.0.0.1`; set `0.0.0.0` — as the Docker image does — so another host/container can reach
  it) on its own port (`CLOAKCODE_TLS_PORT`,
  default 3544) and serves **providers only**. It is `wss://` **by default** (an auto-generated
  self-signed cert persisted under `~/.cloakcode`, or a BYO cert/key `CLOAKCODE_TLS_CERT_FILE` /
  `_KEY_FILE`); `CLOAKCODE_PROVIDER_INSECURE` downgrades it to an insecure plain `ws://` (warned).

A provider is therefore **never served on the operator bind** (removing an earlier duplication), and
the blessed low-friction alternative to native TLS is still an **encrypted overlay or reverse proxy**
(Tailscale/WireGuard/SSH or Caddy/nginx) with both listeners on loopback. The extension verifies
**which** provider listener it reached before it sends anything, by pinning the cert's **SHA-256
fingerprint** — two ways, below.

**Two ways to trust the gateway** (`gateway-tls.ts` · drift audit S4b) — pick per what you configure:

- **Fingerprint-only (the low-friction default).** Set just `cloakcode.gatewayCertFingerprint`.
  Node's `rejectUnauthorized:true` would reject a self-signed chain _before_ any pin runs, and
  `checkServerIdentity` is _ignored_ once auth is off — so this mode turns chain auth off and verifies
  the **exact cert fingerprint by hand** the instant the socket opens, **terminating before it sends
  the knock/hello** on mismatch (`guardFingerprintPin`, fail-closed). Pinning the exact cert is as
  strong as a CA for a single known server, and it skips the hostname/SAN check a bare-IP /
  `host.docker.internal` gateway can't satisfy. (Verified secure against the live gateway;
  "Mechanism 2".)
- **CA-pin (optional, stricter).** Additionally set `cloakcode.gatewayCaFile` to the gateway's cert:
  full chain validation stays **on** (`rejectUnauthorized` never downgraded), the self-signed cert is
  trusted as a CA, and the optional `cloakcode.gatewayCertFingerprint` is verified in
  `checkServerIdentity` (which Node calls only _after_ chain validation).

A gateway fronted by a **real/BYO CA** needs neither — the system trust store validates it (plus the
fingerprint pin if provided). With **no pin and no CA** on a `wss://` URL we still fail closed
(`rejectUnauthorized:true` against the system trust store; never an unverified socket). The
`cloakcode.gatewayUrl`/`gatewayCaFile`/`gatewayCertFingerprint` settings are `machine`-scoped (S4a),
so a workspace cannot redirect or unpin the link.

**A pinned connection never resumes a TLS session** (`noResumptionAgent`, verified 2026-07-27). On a
resumed session the server presents **no certificate**: `getPeerCertificate()` returns `{}` and
`checkServerIdentity` is not called — so in fingerprint-only mode the guard rejects a _legitimate_
gateway (the first connect works, every reconnect "fails the pin") and in CA-pin mode the fingerprint
check is **silently skipped**. Whenever a fingerprint is configured the extension therefore supplies
its **own** `https.Agent({ maxCachedSessions: 0 })`, forcing a full handshake per connection. This
deliberately bypasses VS Code's `http.proxySupport` agent injection for this one socket — that
injected, session-caching agent is what triggered the bug, and a pin that can be skipped by a
transport optimisation is not a pin. The gateway is your own host (loopback / LAN / your tunnel), so
no corporate proxy is expected on this path; a proxy that _did_ intercept would fail the pin by design.

**A fingerprint-only pin provisions its own CA** (verified 2026-07-27). The agent above is not always
ours to give: under the default `http.proxySupport: "override"`, `@vscode/proxy-agent` **discards an
extension-supplied agent for every host except `localhost`/`127.0.0.1`** (an explicit carve-out for
microsoft/vscode#120354) and substitutes its own session-caching one — so a `wss://` gateway reached by
any other name resumes anyway, and fingerprint-only pinning rejects it on every reconnect after the
first. That made provider **sign-in unreachable**: entering a code triggers a reconnect, and the
reconnect is precisely the connection that resumes. What the host *does* preserve is the request
`options`: `ca`, `checkServerIdentity` and `rejectUnauthorized` all survive.

So a fingerprint-only link **self-provisions its own CA** (`selfProvisionedPin`) instead of asking the
operator for a PEM: before connecting, the extension fetches the gateway's certificate over a direct
`tls.connect` (unpatched by the host, and never resumed), **verifies the configured fingerprint against
it**, and then connects with that cert as the `ca`. Fingerprint-only stays the one-value setup it was
meant to be, and the trust decision is unchanged — the fingerprint, and nothing else, is what makes the
fetched cert acceptable. Everything after that is strictly stronger: `rejectUnauthorized` back on, full
chain validation against the pinned cert on **every** connection (resumed or not), and the fingerprint
re-checked in `checkServerIdentity` on each full handshake. A probe that reaches a server presenting the
wrong cert fails closed before any frame is sent; a probe that reaches nothing is just unreachability.
An explicit `cloakcode.gatewayCaFile` still short-circuits all of this.

**A pin failure never falls back to the embedded bridge.** `connectGateway` rejects with a distinct
`GatewayCertPinError` (not the generic "unreachable"), and the extension logs
`gateway.cert_pin_mismatch`, shows an error notification and starts **no** bridge — same fail-closed
treatment as `GatewayAuthRequiredError`. Starting a local bridge instead would hide "something other
than your gateway answered" behind a working-looking setup. Only genuine unreachability (refused
connection, timeout) still falls back. The error names the **presented and expected** fingerprints —
public material, and the only way to tell a substituted cert from one that was never presented.

The cert + fingerprint are provisioned **out-of-band via the authenticated PWA** — a “Connect an
extension” action behind the Dev Tunnel sign-in + operator TOTP (the `gateway.connectInfo` operator RPC
→ the web view; the gateway also prints the `wss://` URL + fingerprint to its console as the fallback).
The PWA only _delivers_ the cert + pin — the extension still verifies it. Explicitly **rejected**:
blind first-connection **TOFU** (accepting whatever cert first appears) and advertising the pin over
the same unverified socket. Fingerprint-only _does_ set `rejectUnauthorized:false`, but **only paired
with a mandatory exact-cert fingerprint check that fails closed before any app data** — a pin, not
trust-on-first-use. The fingerprint is public (integrity matters, not secrecy); the cert private key is
a mode-`0600`, never-logged gateway secret. Full build-ready design in
[docs/05 — encrypted-link hardening](05-roadmap-and-open-questions.md).

**Insecure mode (opt-in, warned).** When the operator listener is bound off-loopback, or the provider
listener is the plain-`ws://` opt-in, traffic is **authenticated but not encrypted** — a sniffer on
that segment can read it. The gateway prints a consolidated **INSECURE MODE** banner to the console
**and** surfaces it to the operator UI (via `gateway.connectInfo`), worded as a **confidentiality**
loss (the transcript + token become readable), not an access-control loss (TOTP/token still gate who
may connect). It exists for least-friction deployment on a **trusted network**; the encrypted paths
above are the default and the recommendation.

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
  - **Compression (permessage-deflate).** The mirror is highly compressible JSON/markdown, so both
    servers enable `ws` permessage-deflate (shared `WS_PERMESSAGE_DEFLATE`: a `threshold` skips tiny
    frames, no-context-takeover bounds per-connection memory) — a large win over a bandwidth-capped
    tunnel. It compresses only the OUTBOUND mirror and does **not** weaken the input bounds:
    `maxPayload` is enforced by `ws` during **inflate**, so a compressed "zip-bomb" frame is aborted
    at the cap. Compression-oracle attacks (CRIME/BREACH) need an attacker mixing chosen text with a
    secret in one compression context; the stream carries neither attacker-controlled framing nor
    secrets, over your own authenticated `wss` — so the risk is low (keep secrets off the stream, as
    they already are).
  - **Ownership re-check.** Every actuator (`respond` / `decide` / `answer` / `steer` / `stop`)
    re-verifies the target session is **owned** by this window (`BridgeDeps.isOwned`) — the UI hides
    controls for foreign sessions, but a direct RPC is rejected here too, so a `remote-operator`
    action can never land in a window that doesn't own the session.
  - **Session-id path safety.** `sessionId` on every incoming session RPC is constrained by
    `sessionIdSchema` to a **safe single path segment** (allowlist charset, no `/`, `\`, or `..`), so
    an operator-supplied id can never traverse out of the storage root when the observer joins it into
    `debug-logs/<id>/` or `transcripts/<id>.jsonl`. The observer (`findSessionLog` / `findTranscript`)
    re-checks the same contract at the file boundary as a belt (drift audit S2).
  - **Upgrade origin policy.** The HTTP→WebSocket upgrade is gated by `isAllowedUpgrade` on both
    ingresses (drift audit S1): an **originless** upgrade (a Node provider — `ws` sends no `Origin`)
    is allowed, a browser upgrade only when it is **same-origin** (`Origin` host === `Host`) or its
    origin is the server's own **public/tunnel URL** (the gateway allowlists its live `phoneUrl`; the
    bridge, `CLOAKCODE_PUBLIC_URL`) — so a malicious web page can't open a cross-site WS to loopback.
    _(The auto Dev Tunnel embedded PWA relies on same-origin, i.e. the tunnel preserving `Host`; set
    `CLOAKCODE_PUBLIC_URL` if a tunnel rewrites it.)_

  This is **regression-tested** (`bridge.test.ts`: non-JSON, unknown op, and a valid op with invalid
  params are all rejected; a well-formed answer full of shell metacharacters + emoji is passed through
  **verbatim as opaque data**; over-length text is rejected; an actuator on a non-owned session is
  refused), so a refactor cannot silently drop the checks.
- **Required PRE-MVP (content cleaning + auth — NOT yet built).**
  1. **Content normalization.** The bounds above cap _size_ and structural validation checks _type_,
     but neither normalizes _content_: control-character normalization is still TODO before the
     bridge is reachable beyond localhost.
  2. **Client authentication — SHIPPED (F2a).** The exposed bridge/gateway is no longer open:
     **operator TOTP** gates the phone (code → signed session token, replay guard + lockout) and a
     **TOTP-issued provider token** gates the extension (see
     [Authentication](#authentication-two-separate-boundaries)). What remains is **transport
     confidentiality** on the extension→gateway hop — see [Tunnel & transport](#tunnel--transport).

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
    6-digit code once; the extension sends it as an `auth` op **over its existing knocked provider
    connection** — the gateway runs that code through the **same `OperatorGate`** the operator uses
    (enrolment, replay guard, lockout) to mint a long-lived (30d) **PROVIDER-scoped session token**,
    which the extension stores in SecretStorage (per gateway) and presents in the hello on later
    connects. There is **no separate sign-in socket**: the code exchange and the provider
    registration ride **one connection** (F2a slice 2). The provider **never holds the TOTP secret** —
    only a token the operator secret issued — so the secret's blast radius stays gateway+phone. The
    token is **audience-scoped** (`<audience>.<exp>.<hmac>`, the audience bound into the signature): a
    provider token presents `audience:"provider"` and is **rejected at the operator boundary**, and an
    operator token is rejected as a provider (drift audit S3), so a token captured at one boundary
    can't be replayed at the other. On refusal the gateway keeps the socket **open** and sends
    `provider.auth_required`; the extension surfaces a sign-in prompt (`GatewayAuthRequiredError`) and
    **stays in gateway mode without falling back to the embedded bridge** — an unreachable hub falls
    back, but a reachable-yet-auth-blocked one must not start a competing bridge (which would add a
    second, confusing operator-MFA enrolment). Once the user enters a code it registers **in place on
    the same socket**, no reconnect.
  - **Static shared secret (demoted escape hatch).** `CLOAKCODE_GATEWAY_TOKEN` / `cloakcode.gatewayToken`
    still works, verified **timing-safe** (`verifyGatewayToken`) — for headless / automation /
    bootstrap setups where interactive sign-in isn't practical. The `cloakcode.gatewayUrl` /
    `cloakcode.gatewayToken` settings are **`machine`-scoped, not `machine-overridable`** — a
    workspace's `.vscode/settings.json` can **not** silently redirect the extension at an attacker
    gateway or inject a token (drift audit S4); it's a user/machine-only decision. When both a setting
    and env var are present the **env var wins** (`resolveGatewayToken` / `resolveConnectionPlan` are
    env-first), matching the manifest so a deployment's env overrides a stale machine setting.
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
- **OTP-screen instance hint (display-only).** So an operator who paired **several** ingresses can
  tell WHICH 6-digit code to enter, the `needsAuth` / `enrolmentRequired` refusals **and** the
  `enrol.begin` reply carry an optional **`instanceId`** — the ingress's own label
  (`OperatorAuth.#label`, the same string the authenticator shows as the `CloakCode:<id>` account).
  The phone renders it on the OTP prompt / enrol screen (the enrol reply carries it too, so the hint
  shows even in **strict** mode where the `otpauthUri` — which encodes the label — is withheld). The
  **extension's** `Sign in to Gateway` prompt shows it too: the gateway advertises its own instance-id
  on the `provider.auth_required` frame, the extension caches it per gateway URL and names
  `CloakCode:<id>` on the code prompt (falling back to the gateway URL for the very first sign-in,
  before it has seen the frame). It is
  **pre-auth-safe** (already public in the otpauth label + the tunnel name), **never a secret**, and
  **never used for trust/routing** — the server still verifies the code against its own secret. Absent
  on an older ingress ⇒ the screen simply omits the hint.
- **Gate the bridge before it's exposed (drift audit S6).** The embedded bridge's operator gate is
  computed from the current exposure (`cloakcode.tunnel` / `CLOAKCODE_PUBLIC_URL`) at bridge start.
  A change to `cloakcode.tunnel` / `cloakcode.mfa` / `cloakcode.mfaEnrolment` now triggers a
  **reconnect** (they're in the reconnect key set — `EXPOSURE_SETTING_KEYS`), rebuilding the bridge
  with the freshly-resolved gate. And **CloakCode: Set Up Phone Tunnel** persists the opt-in and
  **awaits that rebuild before starting the tunnel**, so a tunnel never fronts a bridge whose gate was
  computed for the un-exposed (open) state.
  Rationale for revealing the secret over the bridge during enrolment: you deploy this yourself on a
  trusted network, so the brief enrolment window is not a meaningful attack surface — the point is to
  be secured _before_ the link goes onto a public network.
  - **Strict enrolment (Option B, opt-in):** `CLOAKCODE_MFA_ENROL=strict` / `cloakcode.mfaEnrolment:
    strict` never sends the secret over the wire — the QR is shown **out-of-band** on an interactive
    console (the VS Code webview, or the gateway terminal **only when attached to a TTY** — never the
    persistent `docker logs` stream; a headless run is pointed at the `0600` secret file), and the
    browser only submits the verify code (drift audit S7).
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
