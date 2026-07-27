# 06 — Field notes (preserved working memory)

> Raw, terse working notes from the 2026-07-08 investigation, preserved verbatim-ish so
> nothing is lost if the assistant's memory store does not travel between machines/containers.
> The narrative versions live in [02-research-findings.md](02-research-findings.md) and its topic
> files ([02.1 messaging](02.1-messaging.md) · [02.2 turn tracking](02.2-turn-tracking.md) ·
> [02.3 tool call handling](02.3-tool-call-handling.md) · [02.4 storage](02.4-storage-and-logs.md) ·
> [02.5 session state](02.5-session-state.md)); this is the
> compressed field log. Environment when captured: `copilot-agent` 0.56.0, VS Code 1.128.0,
> remote server (`~/.vscode-server`).
>
> It **also** holds the ongoing **"Build, tooling & agent gotchas"** section at the bottom — the
> **committed** home for the traps the assistant used to keep in its ephemeral `/memories/` store
> (which a rebuild wipes). Add gotchas there so nobody rediscovers them.

## Goal & requirements (evolved)

- Local-to-remote bridge to drive Copilot from a phone/desktop with **ZERO code-sync to GitHub**.
- Main client = phone (React PWA), sometimes another desktop. Terminal client rejected.
- Not just send prompts: **mirror the whole chat session live**, rich rendering like Copilot Chat
  (expandable sections, tool cards, multiple-choice confirmation prompts).
- Core pain: a long agent flow stalls on an unexpected blocker/confirmation; user must **see it
  and answer it remotely**.

## Where Copilot chat lives on disk (VERIFIED)

Base: `~/.vscode-server/data/User/`

- `workspaceStorage/<hash>/GitHub.copilot-chat/`
  - `transcripts/<sessionId>.jsonl` — **LIVE** event-sourced transcript (written ~1s realtime).
    Events: `session.start`, `user.message`, `assistant.turn_start/message/turn_end` (threaded by
    `turnId`), `tool.execution_start{toolCallId,toolName,arguments}`,
    `tool.execution_complete{toolCallId,success}`.
  - `debug-logs/<sessionId>/main.jsonl` — richer: `llm_request`, `agent_response`, `tool_call`,
    `turn_start/end`, `child_session_ref`, + `models.json`, `system_prompt_0.json`, `tools_0.json`.
  - `chat-session-resources/<sessionId>/<toolCallId>/content.txt` — tool output blobs.
- `globalStorage/github.copilot-chat/session-store.db` — SQLite "chronicle" index (tables
  `sessions/turns/session_files/session_refs/checkpoints/search_index` fts5). FLATTENED text, lags
  (reindexed from debug logs), **NOT live**. `turns.assistant_response` is plain text (loses
  structured parts).

## Key conclusions

- **READ/mirror:** strongly feasible + universal. Tail `transcripts/*.jsonl` in the devcontainer →
  normalize → stream to phone. Works even for **stock** Copilot sessions. No proposed API needed.
- Correction to earlier wrong assumption: transcript **IS** on the server/remote side and IS
  live + structured.
- **ANSWER the blocker:** not possible via files (append-only sink). Needs a live input hook: own
  the agent loop (`vscode.lm`) OR command injection OR the agent-host input channel
  (`globalStorage/agent-host-config.json`, producer `copilot-agent`).

## Experiments run (2026-07-08)

1. **Command injection (actuator) — partially viable (revised twice):**
   - `workbench.action.chat.open "text"`: ungated. If loop is **BUSY** → message is **QUEUED** and
     **auto-submitted** when the loop finishes (PROVEN: injected marker dispatched ~4 min later as a
     normal `user.message` with no user action; user confirmed it queued). If idle → prefill sits in
     the input box.
   - The "submit" gap is filled by the **runtime queue**, not a submit command.
   - `workbench.action.chat.newChat`: exists but "preconditions not met" (when-clause gated).
   - `workbench.action.chat.submit` AND `.acceptInput`: "Failed to find command" — but that was the
     **string-only** `run_vscode_command` probe's limit, NOT the command's absence. `chat.submit` IS
     reachable from an **extension** `executeCommand` with an OBJECT context (`{ inputValue,
     acceptInputOptions }`) and is now the actuator's clean composer-free payload path (docs/02.1 M3c).
   - 3 native SEND MODES: **Stop and Send** (interrupt now), **Add to Queue** (Alt+Enter, after
     loop), **Steer with Message** (Enter, inject INTO running loop / redirect). "Steer with Message"
     is the ideal remote blocker-answer / redirect primitive. Command IDs client-side, unverified.
   - CONFOUND WARNING: queue/steer/interrupt keyword hits in logs are mostly meta-conversation +
     system-prompt text, NOT structural events. No distinct `queued`/`steer` event type.

2. **Blocker tracking — CORRECTED: blockers ARE trackable when they go through a TOOL:**
   - Triggered `vscode_askQuestions` → `tool.execution_start {toolName, arguments:{full question +
     options + labels + descriptions + recommended}}` at T0, `tool.execution_complete` 35 s later.
   - **BLOCKER SIGNATURE:** a `tool.execution_start` whose `toolName` is interactive
     (`ask/question/confirm/input/elicit`) with no matching `tool.execution_complete` for its
     `toolCallId` yet = session AWAITING INPUT. Match by `toolCallId`.
   - SURFACE: the `arguments` payload carries the entire question + options → renders richly on phone.
   - Earlier "observer blind" was WRONG: the 22 historical files simply never invoked an interactive
     tool.
   - REMAINING GAP: a plain-prose blocker ending a turn (no tool) looks like normal
     `assistant.turn_end` — harder to distinguish. Answering still needs the actuator.

3. **Remote session list — WORKS (pure read, no proposed API, stock sessions):**
   - Enumerate `workspaceStorage/*/GitHub.copilot-chat/transcripts/*.jsonl` across ALL workspaces.
   - Per session: `sessionId`, workspace, title (first `user.message`), turns, status, age.
   - STATUS must use **liveness = file mtime** (NOT last event type — transcripts often end on
     `assistant.turn_start` giving a false RUNNING). `live = mtime < 120s` → active; live + open
     interactive tool → blocked; else idle.
   - Demo: 11 sessions found; only the current one active, rest idle 22–52 d.
   - Opening/viewing remotely = stream its JSONL (read-only). Resuming/sending to an IDLE session
     needs it loaded in a live VS Code window + the actuator; can't resume a dormant agent from files.

## Net architecture conclusion

- **ACTUATOR:** command injection is more viable than first thought — `chat.open` during a busy loop
  queues + submits; "Steer with Message" could answer/redirect a running flow. Send-mode control
  unverified. Owning the loop stays the most robust/deterministic path; injection + queue + steer is
  a promising lighter-weight alternative.
- **OBSERVER:** file-tailing gives a read mirror but cannot see/relay confirmations directly beyond
  the tool-based blocker signature. Reading and answering are separate problems.
- No public API to read Copilot's own in-memory chat session (`vscode.lm` is stable model access).

## Open follow-ups (see 05 for Q1–Q5)

- Steer / Stop-and-Send command IDs (client-side `workbench.desktop.main.js`).
- The `@github/copilot` agent-host SDK input/steer channel.
- Prose-only blocker detection; whether UI tool-approval confirmations log like `vscode_askQuestions`.

## Build, tooling & agent gotchas (durable — the committed home; `/memories/` is ephemeral)

> Non-obvious traps that cost real time. This is the **committed** replacement for the assistant's
> ephemeral `/memories/` store (a container rebuild wipes that). Add a bullet here whenever a
> rediscovery would waste someone's time.

- **A resumed TLS session presents NO certificate — cert pinning must disable resumption
  (2026-07-27).** Symptom: over `wss://` with `cloakcode.gatewayCertFingerprint`, the **first**
  connect worked (gateway logged `provider.auth_required`) and the very next reconnect died with
  "certificate fingerprint does not match the configured pin" — then the extension silently started
  a local bridge. Not a bad pin, not routing: `getPeerCertificate()` returns `{}` on a **resumed**
  session, so the guard saw an empty fingerprint. Proven with a shared `https.Agent` against the live
  gateway: `#1 reused=false certKeys=19` → `#2+ reused=true certKeys=0`. Fix: whenever a pin is
  configured, `gatewayTlsOptions` supplies its own `https.Agent({ maxCachedSessions: 0 })`.
  - **Why it never reproduced in tests or under `tsx`:** `ws` only resumes when an **explicit** agent
    is passed — replacing `https.globalAgent` does nothing. The VS Code extension host _does_ inject
    one (`http.proxySupport: "override"`), so **only the packaged/installed extension fails**. Four
    sequential `connectGateway` calls (incl. the MFA sign-in + token reconnect) pass under `tsx`.
    Reproduce this class of bug with a shared agent, not by repeating the call.
  - **The test gap that let it ship: every e2e exercised only the FIRST connect** (all 9
    `connectGateway` call sites). A reconnect-only defect was therefore invisible to 773 tests.
    `e2e-gateway.test.ts` now has a **reconnect leg** — one test patches `https.request` to inject a
    pooling agent exactly as the host does (a frozen ESM namespace can't be patched, so import
    `https` as **default/CJS**), and asserts both connections brought their own agent — a
    timing-independent assertion that fails without the fix. When a bug is only reachable on the
    _second_ call, add the second call to the suite.
  - **Corollary (worse):** in CA-pin mode `checkServerIdentity` is _not called_ on a resumed session,
    so the fingerprint check was being **silently skipped**. A pin a transport optimisation can skip
    is not a pin.
  - When a pin/auth check fails, **fail closed** — do not fall back to the embedded bridge (a
    working-looking local bridge masks "something else answered"). And always name **both** the
    presented and expected fingerprints: they are public, and without them "a different cert" and
    "no cert at all" produce byte-identical logs.

- **VS Code DISCARDS an extension's `https.Agent` for every host but `localhost`/`127.0.0.1`
  (2026-07-27).** The follow-up to the bullet above: the "own agent" fix worked on loopback and did
  nothing for `wss://host.docker.internal:7901`. Cause, in the server's own
  `@vscode/proxy-agent/out/index.js` (~line 460):
  `const isLocalhost = !host || host === 'localhost' || host === '127.0.0.1';` and then
  `originalAgent: (!useProxySettings || isLocalhost || config === 'fallback') ? originalAgent : undefined`
  — a carve-out for microsoft/vscode#120354 (don't proxy loopback dev servers), so preserving our
  agent there is an accident. Only the **default** `"override"` drops it; `"on"`, `"off"` and
  `"fallback"` keep it. **Rule: an extension cannot rely on its own agent surviving. Anything you
  must guarantee has to live on the request `options` (`ca`, `checkServerIdentity`,
  `rejectUnauthorized`) — those are preserved (`options.ca = originalCa` is re-applied explicitly).**
  - The user-visible deadlock this caused: connect #1 (full handshake) → the gateway asks for
    sign-in → entering the code triggers a **reconnect** → that reconnect resumes → "presented no
    certificate" → the code is never delivered. Sign-in was unreachable, and restarting the gateway
    only bought one more connection. **When a feature's happy path needs a reconnect, a
    reconnect-only defect is a total outage, not a degradation.**
  - Fix (no new setting, `selfProvisionedPin`): fetch the gateway's cert over a direct `tls.connect`
    (agent-less, never resumed, and only `addCertificatesV2` patches it), verify the fingerprint
    against it, then pass it as `ca`. That converts fingerprint-only into the already-tested CA-pin
    path — same trust decision, enforced by the TLS stack, which handles resumption correctly.
    Reaching for options the host preserves beat fighting it for the agent.
  - Test that proves it: patch `https.request` to **overwrite** `options.agent` (discard, not
    default) and connect three times in a row. Distinct from the earlier test that only injects an
    agent when none is supplied — that one passes with a fix that the real host would have thrown
    away. **Simulate the hostile host, not the polite one.**

- **One upstream pnpm deprecation warning remains by design (2026-07-17).** Vitest/coverage 4.1.10
  removes the old `glob@10` path; jsdom 28 removes its `whatwg-encoding` path; and
  `ignoredOptionalDependencies: [keytar]` skips VSCE's unused credential-store integration plus its
  deprecated `prebuild-install`. The sole remaining warning is `whatwg-encoding@3.1.1` through
  latest `@vscode/vsce@3.9.2 → cheerio → encoding-sniffer`; it is a required parser path, not a
  vulnerability (`pnpm audit` is clean). Do not silence it with `allowedDeprecatedVersions` or
  override the required transitive dependency; wait for VSCE/Cheerio upstream.

- **Major dep bump that changes generated `.d.ts` → `pnpm -r build` BEFORE `pnpm -r typecheck`
  (2026-07-22).** After bumping zod 3→4, `pnpm -r typecheck` failed only in `@cloakcode/gateway`
  with `z.infer` collapsing to `unknown` (`req.data`/`parsed.data` typed `unknown`). Cause: the
  gateway consumes `@cloakcode/protocol`'s **built `dist/*.d.ts`**, which was still generated
  against zod 3 — typecheck does not rebuild dependencies. `pnpm -r build` regenerates protocol's
  emitted types against the new zod, after which typecheck/lint/test are clean with **no source
  changes**. Rule: when a bump changes a library's generated types (zod is the classic), rebuild the
  workspace before trusting a typecheck. Not a code bug — a stale-artifact ordering trap.

- **A major dep bump can emit NEW deprecation/peer warnings — fix them in the same change, never
  wave off with YAGNI (2026-07-22).** Bumping vite 6→8 introduced two warnings where there were
  none: (1) build-time deprecation spam from the still-babel `@vitejs/plugin-react@4`
  (`esbuild` option deprecated → use `oxc`; `optimizeDeps.rollupOptions` → `rolldownOptions`; "switch
  to `@vitejs/plugin-react-oxc`") — the fix is the **vite-8-native major `@vitejs/plugin-react@6`**
  (its extra peers `@rolldown/plugin-babel` + `babel-plugin-react-compiler` are `optional`), NOT the
  suggested `plugin-react-oxc` (still peers vite ^6/^7 — stale advice). (2) an unmet-peer warning:
  vite 8 wants `esbuild ^0.27||^0.28` but extension+gateway pinned `esbuild 0.25.12` → bump both to
  `0.28.1` (our bundlers call esbuild's **JS API** in `scripts/bundle.mjs`, so the CLI-shim gotcha
  below doesn't apply; verify both bundles + `pnpm peers check` after). Rule: `pnpm peers check` and
  scan build output for `deprecat`/`warning` after any bundler/framework major, and clear anything
  new in the same PR (see the no-regression discipline in `.github/copilot-instructions.md`).

- **Lockfile-sharing Dependabot PRs pile up — combine, don't rebase-loop (2026-07-22).** N npm PRs
  that each rewrite `pnpm-lock.yaml` conflict with _each other_, not just with `main`: merging one
  re-conflicts the rest, so they can only land sequentially with a rebase between each (`@dependabot
  rebase` auto-reapplies but can't dodge the sequence). Fast clear = one local combined-update PR
  (bump all the manifests, one regenerated lockfile, `Closes #a #b #c`, then close the originals as
  superseded). Prevention = a Dependabot `group` per ecosystem (see `.github/dependabot.yml`
  `production-dependencies`/`development-dependencies`, minor+patch) so weekly bumps arrive as one
  PR; majors stay ungrouped for review and are the rare case that still needs the combined-PR trick.
  **Exception — coupled families that must version in lockstep** (react + react-dom + their `@types`)
  get a dedicated `patterns` group covering **all** update-types, so a React major lands as ONE
  reviewable PR instead of separate PRs that each fail CI alone (react without react-dom = mismatched
  runtime). Whenever you clear such a pileup by hand, add/extend the matching group in the SAME change
  so it can't recur. Dependabot assigns a dep to the FIRST matching group — list coupled pattern
  groups before the broad type groups.

- **`pnpm update <pkg>` at root is a silent no-op for workspace-package deps — use `pnpm -r update`
  (2026-07-22).** Bumping a lockfile pin only works if the manifest that declares the dep is in
  scope. Deps declared in the workspace packages (e.g. `ws` in `packages/extension` +
  `packages/gateway`, not root) are invisible to a plain `pnpm update ws@x` run at the repo root — it
  prints "Already up to date" and changes nothing (`pnpm why ws` at root is also empty). Use
  `pnpm -r update ws@8.21.1` (recursive), which also bumps the manifest ranges. This — not any
  proxy/cooldown gap — was the real cause of a long "can't bump ws locally" rabbit hole. (Editing
  `package.json` + `pnpm install` also works and is what a manifest-first flow does.)
- **`minimumReleaseAge` cooldown is measured against the proxy's MIRROR time, and its cache lags
  (2026-07-22).** pnpm reads publish dates from the registry `time` field; the Microsoft package-feed
  proxy **rewrites `time` to when _it_ mirrored** the version (e.g. `ws@8.21.1` = `2026-07-14T17:12Z`
  on the proxy, days after npm's real publish). So our 7-day (`minimumReleaseAge: 10080`) local
  cooldown starts at mirror time, i.e. lags npm by the proxy's mirror delay — whereas Dependabot's
  own 7-day cooldown uses npm's real publish time. A version can therefore be green in CI (real npm)
  yet briefly not-yet-cooldown-cleared locally. Two more traps: pnpm caches the time-bearing packument
  separately in `~/.cache/pnpm/v11/metadata-full/…/<pkg>.jsonl` (distinct from the abbreviated
  `metadata/` cache), and that full cache can be **stale** (missing a just-mirrored version) even when
  the abbreviated one is fresh — delete the stale `metadata-full/<pkg>.jsonl` to force a refetch. No
  cooldown change is warranted (the proxy lag itself adds real-age protection and Dependabot's 7d
  gates the update flow); just be aware the local gate ≈ npm-publish + mirror-lag + 7d.

- **A security override only helps if a PATCHED version is mirrored — and a still-vulnerable
  override actively fails `dependency-review` (2026-07-22).** `dependency-review-action`
  (`fail-on-severity: high`) reviews only the **diff**: a pre-existing vulnerable transitive left
  untouched passes (it stays a Dependabot _alert_, not a PR blocker), but the moment a PR **changes**
  that dep to another version still inside the advisory range it fails the check. Learned the hard way
  on `fast-uri`: the alert cited `<= 3.1.3` (GHSA-cq4c-9wjx-4gp7), but a newer advisory
  (GHSA-v2hh-gcrm-f6hx / CVE-2026-16221) extended the affected range to `>= 4.0.0, <= 4.1.0`, so an
  `overrides: fast-uri: ^4.1.0` resolved to the **still-vulnerable** 4.1.0 — no fix, plus a red gate.
  The only patched lines are **2.4.3 / 3.1.4 / 4.1.1**, and **none of them is mirrored on the MS feed
  proxy yet** (its fast-uri history is 3.1.3 → 4.0.0 → 4.0.1 → 4.1.0), so the lockfile **cannot** be
  regenerated with the fix locally. Correct play: **do not land a security override until a patched
  version is actually resolvable on your registry** — ship the independent fixes, leave the
  transitive unchanged (Dependabot handles it against real npm once the point-fix lands / the proxy
  mirrors it), and always **cross-check the CURRENT advisory range** (not just the version the alert
  first cited) before picking the target.
- **Correlation/frame ids must be `crypto.randomUUID()`, never `Math.random()` — CodeQL
  `js/insecure-randomness` (2026-07-22).** Any random value that flows into a request/frame id (which a
  scanner treats as a security sink) trips the High CodeQL alert even for our benign RPC-correlation
  use — and even when the flagged file is a _downstream_ sink (the alert pointed at the dev-only
  `web-playground` echo, but the tainted **source** was `web`'s `Math.random` ids). Fix at the source:
  browser + Node ≥19 both expose `crypto.randomUUID()` (web has it via the DOM lib in a secure/localhost
  context; in the extension's Node context `import { randomUUID } from "node:crypto"` — do **not** reach
  for `globalThis.crypto` there). Genuinely non-security `Math.random` is fine and should stay:
  reconnect-backoff **jitter** and the crypto-first, clearly-local-only `newTraceId` **fallback** are
  not sinks — don't cargo-cult them into UUIDs.

- **Never swallow an error that changes user-visible behaviour — surface a redaction-safe reason
  (2026-07-23).** The counter-rule to "never log secrets" (docs/04): a bare `catch {}` /
  `.on("error", () => {})` is only legitimate for a **truly ignorable best-effort** op (a close after
  we already failed, a fire-and-forget cleanup). Any failure that changes what the user sees MUST
  report **why**, via the redaction-safe error CODE (`errorCode()` in
  `packages/extension/src/errors.ts` → Node `errno`/`Error.name`, **never** `.message`, which can
  carry a path/prompt). Cost real time: the operator's wss connect logged a generic
  `gateway … unreachable` because `gateway-client.ts` did `s.on("error", () => {})`, hiding the actual
  `DEPTH_ZERO_SELF_SIGNED_CERT` (cert-not-trusted) — so a fixable trust problem looked like the
  gateway was down. Fix pattern: capture `errorCode(e)` and fold it into the surfaced message/reject
  (`connectHint()`), mapping known codes to an action ("set gatewayCertFingerprint / gatewayCaFile").
  "Never log secrets" bounds WHAT you log; it never licenses logging NOTHING.
- **Provider↔gateway handshake: log every failure branch (redaction-safe), and test it by sharing
  only the TOTP code (2026-07-24).** When a provider fails to register you must read WHY from the log,
  not guess (this cost real device-debug time). Each branch in `handleProviderConnection`
  (`packages/gateway/src/gateway.ts`) emits a distinct, primitives-only record:
  `provider.auth_required { instanceId, credentialPresented }` — a **boolean**, so a bad token reads
  differently from an absent one **without** ever logging the token; `provider.auth_failed { reason }`
  and `provider.auth_lockout { reason }` — the gate's **fixed** reason string ("invalid code" /
  "code already used", pulled with `authFailureReason()`, **never** the submitted code);
  `provider.connect { via: "credential" | "signin" }` — how it authed; and `provider.reject_unexpected`
  — a knocked provider that then sent junk. The extension mirrors the reason onto
  `GatewayAuthRequiredError.reason` → `log.warn("gateway.auth_required", { reason })`. **Test the
  handshake by simulating the real user flow — share ONLY the code.** The test's `onAuthRequired`
  returns a TOTP code derived from the shared secret (vector `"12345678901234567890"` → `287082` at
  `now:()=>59_000`); the provider token is obtained **solely** from the exchange (captured via
  `onToken`) and reused on reconnect — never inject a pre-minted provider token as the credential. To
  present a wrong-audience (operator) token as a NEGATIVE, mint it from a **throwaway** `OperatorAuth`
  (same secret) so the gateway's own replay guard (`#lastStep`) stays fresh for the real code sign-in.
  Matrix: `provider-auth.test.ts` (ws permutations) + `e2e-gateway.test.ts` (wss+MFA) +
  `gateway.test.ts` (raw-ws lockout + log assertions). Lockout (5 bad codes on **one** connection) is
  only reachable at the raw-ws level — `connectGateway` sends one code per connection, so a fresh
  connect resets the per-connection gate.
- **Parse `devtunnel` with `--json`, never scrape its human table (2026-07-24).** `devtunnel port
  list <name>` prints `Found N tunnel port(s).` as its first line; the old `parsePortList` text
  scraper matched that **count** `N` as a forwarded port and issued a spurious
  `devtunnel port delete -p N (stale)` **every run** (harmless no-op — deleting a non-existent port —
  but confusing logs, spotted during device testing: it "detected port 1 stale" whenever exactly one
  port was forwarded). Fix: `devtunnel port list <name> --json` → parse `ports[].portNumber`
  (`tunnel.ts`). `--json` is a documented flag on the port commands; note some entries omit
  `clientConnections`, so read only `portNumber`. General rule: any `devtunnel` query we parse uses
  `--json`, never the table.

- **esbuild CLI shim is broken under pnpm (persistent).** pnpm's `.bin/esbuild` cmd-shim hardcodes
  `exec node <target>`, but esbuild's postinstall overwrites its own `bin/esbuild` (a Node stub in
  the tarball) with the native Go binary → `node <ELF>` `SyntaxError`. `pnpm rebuild esbuild` does
  **not** fix it (regenerates the same node-wrapper; verified 2026-07-14) and manual shim edits are
  wiped on the next install. **Fix = invoke esbuild via its JS API** (`import { build } from
  "esbuild"`) in a `scripts/bundle.mjs`, never the `esbuild` CLI. Both bundlers do this
  (`packages/gateway/scripts/bundle.mjs`, `packages/extension/scripts/bundle.mjs`; the extension
  `bundle` script is `node scripts/bundle.mjs`). vitest/vite use esbuild's JS API internally, so
  tests were always unaffected. Do **not** re-add an `esbuild …` CLI call to any npm script.
- **Dependabot has no LTS awareness — pin the non-LTS Node majors, not "all majors" (2026-07-22).**
  Dependabot always proposes the newest tag and can't be told "LTS only"
  (dependabot/dependabot-core#2247, open since 2018). The gateway image must stay on a Node **LTS**
  line, so `.github/dependabot.yml` (docker ecosystem) has `ignore: node versions: ["25"]`. Ignore
  the **specific non-LTS version(s)**, NOT `update-types: version-update:semver-major` — under the
  new schedule (nodejs.org "Evolving the Node.js release schedule") **every major from 26 onward is
  LTS**, so a blanket major-ignore would wrongly block the next LTS bumps. 25 is the last non-LTS
  release (older odd 21/23 are EOL). When bumping the major manually, change **both** `FROM node:`
  stages in `packages/gateway/Dockerfile` (build + runtime) together.
- **TypeScript stays on 5.x — the tsgo 7.x major is gated on typescript-eslint, not us (2026-07-23).**
  `typescript@7.0.2` is now `latest` — the **Go-native ("tsgo") rewrite** with a different compiler
  API. We can't adopt it while our type-aware linter **`typescript-eslint@8`** declares peer
  `typescript: >=4.8.4 <6.1.0` (verified on the registry; `@typescript-eslint/typescript-estree`
  carries the same cap): bumping past 5.x would break type-aware lint **and** introduce a
  peer-dependency warning (a no-regression violation). So `.github/dependabot.yml` (npm ecosystem)
  ignores **only the `typescript` majors** via `update-types: [version-update:semver-major]` — 5.x
  minor/patch still auto-update. This is the **opposite** call from the Node-LTS note above (there we
  ignore a _specific_ version, not the update-type) because here the block is the ecosystem peer cap,
  not an LTS cadence: any TS major is gated until typescript-eslint widens its peer range. **Revisit
  trigger:** the day a `typescript-eslint` release lands whose `typescript` peer covers the next TS
  major — drop the ignore in that same change. Dependabot auto-closed the stale 5.9.3→7.0.2 PR once
  the ignore hit `main`.
- **No duplicate tool-version pins — run the tool from the project's dep manager (2026-07-22).**
  Dependabot has **no `pre-commit` ecosystem**, so a tool version living in a pre-commit `rev:` never
  gets a Dependabot PR. If that same tool is _also_ pinned elsewhere (e.g. ruff in both
  `.pre-commit-config.yaml` `rev:` and `pyproject.toml`), Dependabot bumps only one side and they
  **drift**. Fix = single source of truth: run the tool from the project's dependency manager via a
  `language: system` local hook — `node_modules/.bin/*` for JS (eslint/prettier already do this) and
  `.venv/bin/<tool>` for Python (ruff now does; needs `poetry install --only dev` in the CI `hooks`
  job to create the venv). Then one npm/pip Dependabot PR moves both the tool and its enforcement.
  Pre-commit-**only** hosted hooks (gitleaks, markdownlint-cli2, conventional-pre-commit,
  pre-commit-hooks) have a single pin so they don't drift, but Dependabot can't bump them either —
  they only move via `pre-commit autoupdate`.
- **Edit-tool unicode trap.** The string-replace edit tools can write `\uXXXX` escapes as **literal
  text**. Use the actual glyphs (em-dash —, middot ·, arrow →, section §) in the replacement, or a
  Python heredoc with ASCII anchors for unicode-heavy edits.
- **Prettier ≠ ESLint.** `pnpm lint` (eslint) does **not** enforce prettier's width; the pre-commit
  Prettier hook does and reformats (wraps > 80 cols). Run `node_modules/.bin/prettier --write <f>`
  before staging so the commit doesn't leave an unstaged reformat.
- **markdownlint (docs/).** Underscores for italics (MD049), `**` for bold; verify with
  `pre-commit run markdownlint-cli2 --files <f>` before committing docs.
- **A hook that rewrites a staged file + unstaged changes elsewhere = silent commit rollback
  (2026-07-23).** When `pnpm-lock.yaml` is staged (e.g. after adding a dep) the `pnpm-lock-portable`
  hook strips its tarball URLs and modifies it. pre-commit stashes your **unstaged** changes first;
  when a hook then edits a staged file, that patch can conflict with the stash, so pre-commit
  **rolls back the fix and aborts the commit** — output ends with `Restored changes from …patch`
  and **no `[main <hash>]` line**, which is easy to miss. Since `.vscode/launch.json` is usually
  dirty (user WIP we never commit), this bites most `pnpm-lock.yaml` commits. Fix: **pre-apply the
  hook** so it's a no-op — `pre-commit run pnpm-lock-portable --files pnpm-lock.yaml && git add
  pnpm-lock.yaml`, then commit. (Same idea for any auto-fixing hook: run it, re-`git add`, commit.)
  Always confirm the `[main <hash>]` line — if it's absent, the commit did **not** land.
- **`.local/` is gitignored** → `grep_search` needs `includeIgnoredFiles: true` and `file_search`
  won't find it. Vendored VS Code source anchor = `.local/research/vscode/extensions/copilot`
  (Copilot Chat is **built into core VS Code**; `microsoft/vscode-copilot-chat` was archived
  2026-05-20 — do not anchor on it).
- **Extension changes need a rebuild + reload — the PACKAGED install path bites twice.** Two
  distinct flows: (a) the **F5 Extension Dev Host** — `pnpm --filter @cloakcode/extension bundle`,
  then reload the host (packaged PWA has Vite HMR off → hard-refresh). (b) a **real install**
  (`pnpm --filter @cloakcode/extension package` → `./dist/extension/install.sh`) — you MUST
  **rebuild the VSIX _and_ reload the window**. VS Code reads `package.json` `contributes.*`
  (commands, **menus**, `when` clauses, settings) only at extension **LOAD**, so a manifest change
  needs the reload, not just a reinstall. **Symptom (cost real time twice, 2026-07-18):** a
  code/manifest fix "doesn't work" — palette commands still show/hide by the OLD rules, or old
  behaviour runs — because `install.sh` reinstalled a **STALE `dist/*.vsix`** (built before the fix)
  and/or the window wasn't reloaded. **Verify against the INSTALLED manifest, not the source:**
  `~/.vscode-server/extensions/rexwel.cloakcode-*/package.json` (e.g. `grep commandPalette`). Same
  version number ⇒ `install.sh` uses `--force`, but the RELOAD is what swaps it in. **Rule:** after
  any extension change → rebuild the VSIX → reinstall → **reload the window** → confirm the installed
  manifest/behaviour, before concluding anything is broken. TDD the pure layers (protocol/gateway)
  with a failing test first.
- **Storage is EPHEMERAL here (overlay).** A container rebuild wipes `~/.vscode-server`
  workspaceStorage (transcripts + debug-logs) **and** `/memories/`. Durable records must live in
  git (`docs/`), local-only WIP in `.local/`. Transcripts GC to ~20 and rehydrate from the client
  ChatModel (docs/02); rehydrated timestamps are replay time.
- **Transcript render must stay O(n)** (docs/03 "Rendering a long backlog"): coalesce events one
  batch per animation frame + `React.memo` on Part/Markdown with hoisted plugins/components. Do not
  reintroduce per-event dispatch or a per-render markdown-components object → silently O(n²).
- **Protocol schema change ⇒ rebuild + redeploy gateway AND extension together.** Zod objects strip
  unknown keys but REQUIRE the declared ones, so a stale peer only breaks in ONE direction: a **new**
  client that OMITS a now-removed param fails a **stale** peer's schema. Symptom (2026-07-15): after
  dropping `instanceId` from the session-RPC params, a stale deployed **gateway** hit
  `if (!safeParse.success) return;` and silently dropped `session.subscribe` (no reply) → the phone
  hung on "Loading transcript…", while `sessions.list` (empty params) still worked. Two fixes: (1)
  `handleOperator` now **errors** (correlated to the request id) instead of silently dropping an
  invalid operator RPC, so a version mismatch surfaces; (2) redeploy fresh —
  `pnpm --filter @cloakcode/gateway assemble` (rebuilds protocol first, then the gateway bundle +
  web) and `pnpm --filter @cloakcode/extension package` — in the SAME change that alters the protocol.
- **`pnpm <anything>` can reach the npm registry via the `packageManager` pin — NOT vsce.** Root
  `package.json` pins `"packageManager": "pnpm@11.9.0"`; pnpm ≥9.7 (`manage-package-manager-versions`
  default on) and corepack both DOWNLOAD that exact pnpm from the npm registry when the running pnpm
  differs from the pin. Silent where the registry is reachable (this container runs pnpm 11.9.0 = the
  pin → no fetch), but BLOCKED on a restricted host with a different/uncached pnpm — which reads as
  "pnpm package reaches out to npm". It is NOT the packaging: `vsce package --no-dependencies` packages
  fine against a dead registry (verified 2026-07-15). Offline options: install pnpm 11.9.0 on the build
  host to match the pin; or `.npmrc` `manage-package-manager-versions=false` (and don't `corepack
  enable`) so the local pnpm is used; or point `COREPACK_NPM_REGISTRY` / `npm_config_registry` at an
  internal mirror; or pre-warm the corepack cache while online.
- **Registry-portable `pnpm-lock.yaml`: keep the registry out of the repo, strip tarball URLs on commit.**
  A dev machine may resolve through a non-default registry (here: the Microsoft package-feed proxy) which
  makes pnpm record ~674 absolute `tarball: https://ms-feed-{2,12,25}.pkgs.visualstudio.com/…` URLs that
  public runners / other contributors can't reach. Two facts: (1) pnpm's `lockfileIncludeTarballUrl: false`
  does **not** drop them here — the feed serves tarballs from non-standard, load-balanced `ms-feed-N` hosts
  that differ from the registry path, so pnpm records the resolved URL because it can't reconstruct it
  (regenerating even errors: "tarball URL … does not match the registry's published metadata"). (2) The fix
  is to strip only the URL fragment, keeping `integrity:` — `sed -E 's/, tarball: https:[^}]*\}/}/'
  pnpm-lock.yaml` (NOT `/tarball:/d`, which deletes the whole `resolution:` line incl. integrity; and it's
  `sed -i` on Linux, not the macOS `sed -i ''`). Result: `resolution: {integrity: sha1-…}`. pnpm accepts the
  integrity-only lockfile (validates it against the store); on public npm it reconstructs
  `<registry>/<name>/-/<name>-<ver>.tgz` and the **sha1 still matches** because the tarball bytes are
  identical to npmjs.org, so every version pin is preserved.
  **Current model (2026-07-17): the registry config is NOT committed.** The repo has **no `.npmrc`** (it's
  gitignored); the internal proxy lives only in each dev's user `~/.npmrc`, so public contributors and CI
  default to the public npm registry with zero overrides. The lockfile is kept portable automatically by the
  `pnpm-lock-portable` **pre-commit hook** (`scripts/strip-lockfile-tarballs.sh`) — so CI, `release.yml`, and
  the gateway `Dockerfile` now just run `pnpm install --frozen-lockfile` (the old `--registry=…npmjs.org/`
  flags and `printf … > .npmrc` step were removed). Do **not** re-commit an `.npmrc` or re-add a `--registry`
  override; if you resolve through a private feed, put it in `~/.npmrc` and let the hook clean the lockfile.
- **Building the gateway Docker image on a restricted network (2026-07-18).** The build container has
  **no `~/.npmrc`**, so it defaults to public `registry.npmjs.org` — which fails on a corporate network
  where only an internal feed is reachable (symptom: TLS `handshake_failure`, or the FROM/apt work but
  the pnpm step can't resolve). Two facts baked into the image build: (1) **`corepack` can't fetch pnpm
  from a mirror** — it requests `<registry>/pnpm/<version>` (a non-standard path the Microsoft
  package-feed proxy 404s), so the `build` stage installs pnpm via a **plain `npm i -g pnpm@<pin>`**
  (an ordinary package every feed serves), pinned to the root `packageManager` field. (2) An **opt-in**
  `ARG NPM_REGISTRY` (empty ⇒ public npm, so CI/contributors are unchanged) sets `npm config set
  registry` for both the pnpm bootstrap and `pnpm install`; pass it via
  `scripts/docker-gateway.sh --registry "$(npm config get registry)"` (or `--network host` for the
  common WSL2 MTU/TLS-drop case). This opt-in ARG is **not** the committed-`--registry`-default the
  lockfile note forbids — the default stays public npm; do not hardcode a non-empty default.
- **`devtunnel user show` exits 0 even when NOT signed in** (verified 2026-07-16, CLI v1.0.1972).
- **`devtunnel user show` exits 0 even when NOT signed in** (verified 2026-07-16, CLI v1.0.1972).
  It prints `Logged in as <user> using <provider>.` vs `Not logged in.` but the **exit code is 0
  either way**, so an `if devtunnel user show >/dev/null; then …signed in…` check is always-true and
  useless. Detect login state from the **output text** instead: `devtunnel user show 2>/dev/null |
  grep -q "Logged in as"`. Used by the gateway container entrypoint
  (`packages/gateway/scripts/docker-entrypoint.sh`). Other verified devtunnel facts: tokens are
  **file-based** (no keyring) under `$HOME/.local/share/DevTunnels/` (`devtunnels-tokens{,-github,-microsoft}`,
  `devtunnels.json`); the .NET single-file self-extracts to `$HOME/.net/devtunnel/`; login flags are
  `-d` device-code, `-g` GitHub, no flag = Microsoft. The Docker image downloads the binary directly
  (arch-aware, `linux-x64`/`linux-arm64` from `tunnelsassetsprod.blob.core.windows.net/cli/<t>-devtunnel`)
  rather than the `aka.ms/DevTunnelCliInstall` script (which does its own `sudo apt-get` + `~/bin` PATH
  edits); runtime needs `libsecret-1-0` **and ICU (`libicu`)**. The current devtunnel build (v1.0.x,
  .NET single-file) **aborts on startup under invariant globalization** (`Couldn't find a valid ICU
  package…` — its `LimitsCommand` reads `TimeZoneInfo`/`CurrentUICulture`) and **ignores**
  `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`, so the image now **installs the ICU runtime** instead of
  relying on the invariant flag (removed 2026-07-18). `libicu` is SO-versioned per Debian release
  (`libicu72` bookworm / `libicu76` trixie / …), so the Dockerfile resolves whichever the base image
  ships via `apt-cache search --names-only '^libicu[0-9]+$' | sort -V | tail -n1` rather than pinning.
- **UI playground = a separate dev-only package + a fake WebSocket (2026-07-21).** To design the PWA
  with no gateway, `@cloakcode/web-playground` renders the **real** `@cloakcode/web` `App` and just
  swaps `globalThis.WebSocket` for an in-browser fake that replies from fixtures. Two design points
  that keep it clean: (1) **one seam** — every bridge call funnels through `new WebSocket(url)`
  (`sessions.list`, `session.subscribe`, the actuator RPCs), so a single fake global covers the whole
  app with **zero production edits** (no `import.meta.env.MOCK` branch in `bridge.ts`). (2) **one-way
  package edge** — `playground → web` only (web exposes `App` + `styles.css` via package `exports`);
  the shipped `web` build/vsix can't reference the mock even by accident. Import the real component
  cross-package by the package name (Vite/pnpm transpile the linked TSX source; add
  `resolve.dedupe: ['react','react-dom']` so hooks don't hit a duplicate React). **Gotcha when
  driving it headless:** the transcript stream is coalesced through `requestAnimationFrame`
  ([SessionView](../packages/web/src/SessionView.tsx)) — and rAF is **paused in a hidden tab**
  (`document.visibilityState==='hidden'`), so a Playwright-driven page shows a perpetual "Loading
  transcript…" even though the fake emitted valid events. It renders fine in a real foreground
  browser; to force it under automation, enable CDP `Emulation.setFocusEmulationEnabled {enabled:true}`
  (un-throttles rAF). A session with **no fixture events** also legitimately shows "Loading
  transcript…" — give every fixture session a transcript.
- **A DESKTOP extension host ≠ a server/container host (2026-07-14, "broken fully on Windows").** Two
  assumptions that hold on server/container/WSL silently break on a **local desktop** VS Code:
  (1) **`process.execPath` is Electron, not node.** On desktop it's the `Code.exe` binary, so
  launching it as a hook runtime only behaves as node with **`ELECTRON_RUN_AS_NODE=1`** (real node
  ignores the var → safe everywhere); also clear `NODE_OPTIONS`. And VS Code runs hooks under
  **PowerShell** (default `ComSpec=cmd.exe`), which parses a leading quoted path as a string literal
  → prefix the Windows form with the call operator `&`. Ship one portable hook config via VS Code's
  OS-specific override keys (`windows`/`linux`/`osx`, selected by the extension-host platform, falling
  back to `command`) — no runtime platform branch. (2) **Storage is NOT under `~/.vscode-server`.**
  Desktop keeps it under the OS user-data dir (`%APPDATA%\Code\User` / `~/Library/Application
  Support/Code/User` / `~/.config/Code/User`), and `--user-data-dir` moves it again → a hardcoded
  path finds **0 sessions**. Derive the root from **`context.globalStorageUri`** (sibling
  `…/User/workspaceStorage`) instead. Both fixes are host-accurate with no `process.platform` check.
- **GitHub Code Quality coverage is PLAN-gated — unavailable on a public/free repo, so we do NOT
  upload (2026-07-23).** The `coverage` job in [ci.yml](../.github/workflows/ci.yml) once uploaded
  Cobertura reports via `actions/upload-code-coverage` so `github-code-quality[bot]` could post a PR
  coverage summary. On `lsiddiquee/CloakCode` (a **personal / public / free** repo) every upload
  **404s** and the setting to enable it is **nowhere in repo/profile settings** — because **GitHub
  Code Quality is only available on GitHub Enterprise Cloud and Team**, per the public-preview
  changelog's _Availability and pricing_ (2026-05-26; the product went GA 2026-07-20). It is **not** a
  rollout wait and **not** a permission problem — the `code-quality: write` permission is
  necessary-but-not-sufficient; the gate is the **account tier**. The `code-scanning` default/advanced
  setup type is **irrelevant** to it: Code Quality (coverage) and CodeQL (code scanning) are
  **separate features**, so **switching CodeQL to default setup does NOT unlock coverage** — don't do
  it hoping to (we stay on **advanced** CodeQL: [codeql.yml](../.github/workflows/codeql.yml),
  `javascript-typescript` + `security-extended`). **Decision (2026-07-23): the upload steps + the
  `code-quality: write` permission were REMOVED** rather than left masked with `fail-on-error: false`
  — a permanently-404ing step behind a silent mask is exactly the kind of hidden CI failure we don't
  carry. The **real** protection stays: the in-CI `pnpm -r test:coverage` **85% gate**
  (statements/lines/functions; 75% branches) FAILS the job on a regression, independent of any upload.
  The job was renamed `Coverage → Code Quality` → **`Coverage — 85% gate`** to match reality; that
  string is a **required status check** on `main`, so branch protection's required-checks list was
  updated in the same change (rename the job ⇒ update branch protection or PRs hang on a check that
  never reports). **Revisit trigger:** the day this repo lives under a GitHub Enterprise Cloud/Team
  org (or Code Quality reaches personal plans) — enable Code Quality in the repo's Code security
  settings, then re-add the `actions/upload-code-coverage` steps + `code-quality: write` permission
  (no `fail-on-error: false` mask — a real upload failure should fail CI).
  Details in docs/02.3 §4.27 + docs/02.4 §4.28.
- **Named Dev Tunnels are ADDITIVE — a stale forwarded port lingers and 502s (2026-07-23).** Our
  tunnel name is stable per instance (`cloakcode-<hash>`) and `ensureTunnel` only ever `port create`s
  (both `create` + `port create` are `.catch(ignoreExists)`), so a port from a **previous** run stays
  on the tunnel. Its `<name>-<port>.<region>.devtunnels.ms` URL now has **no server behind it**, so
  anyone who reaches it (a phone that cached it, or `firstTunnelUrl` picking the wrong scoped URL) gets
  a **502**. Symptom (cost real time): a run with `CLOAKCODE_GATEWAY_PORT=7990` still exposed a stale
  `-7905` from an earlier run → 502. Fix: `startDevTunnel` now **reconciles** — `reconcileStalePorts`
  lists ports and deletes every one ≠ the current, **best-effort** (list/delete failures are caught +
  logged, never block hosting; deleting a non-existent port is a harmless no-op). `parsePortList`
  matches only **standalone** integer tokens (`1–65535`) so the tunnel name/hash/region and a URL's
  embedded `-<port>` never false-match. **Caveat:** the `devtunnel port list` table format was **not**
  verifiable in this dev container (no CLI) — if a future CLI formats ports with adjacent chars the
  parse could miss one (then it is no worse than before; verify against a live `devtunnel port list`
  if cleanup ever seems to skip a stale port).
