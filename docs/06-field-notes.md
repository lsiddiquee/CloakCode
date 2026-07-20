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
   - `workbench.action.chat.submit` AND `.acceptInput`: "Failed to find command".
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

- **One upstream pnpm deprecation warning remains by design (2026-07-17).** Vitest/coverage 4.1.10
  removes the old `glob@10` path; jsdom 28 removes its `whatwg-encoding` path; and
  `ignoredOptionalDependencies: [keytar]` skips VSCE's unused credential-store integration plus its
  deprecated `prebuild-install`. The sole remaining warning is `whatwg-encoding@3.1.1` through
  latest `@vscode/vsce@3.9.2 → cheerio → encoding-sniffer`; it is a required parser path, not a
  vulnerability (`pnpm audit` is clean). Do not silence it with `allowedDeprecatedVersions` or
  override the required transitive dependency; wait for VSCE/Cheerio upstream.

- **esbuild CLI shim is broken under pnpm (persistent).** pnpm's `.bin/esbuild` cmd-shim hardcodes
  `exec node <target>`, but esbuild's postinstall overwrites its own `bin/esbuild` (a Node stub in
  the tarball) with the native Go binary → `node <ELF>` `SyntaxError`. `pnpm rebuild esbuild` does
  **not** fix it (regenerates the same node-wrapper; verified 2026-07-14) and manual shim edits are
  wiped on the next install. **Fix = invoke esbuild via its JS API** (`import { build } from
  "esbuild"`) in a `scripts/bundle.mjs`, never the `esbuild` CLI. Both bundlers do this
  (`packages/gateway/scripts/bundle.mjs`, `packages/extension/scripts/bundle.mjs`; the extension
  `bundle` script is `node scripts/bundle.mjs`). vitest/vite use esbuild's JS API internally, so
  tests were always unaffected. Do **not** re-add an `esbuild …` CLI call to any npm script.
- **Edit-tool unicode trap.** The string-replace edit tools can write `\uXXXX` escapes as **literal
  text**. Use the actual glyphs (em-dash —, middot ·, arrow →, section §) in the replacement, or a
  Python heredoc with ASCII anchors for unicode-heavy edits.
- **Prettier ≠ ESLint.** `pnpm lint` (eslint) does **not** enforce prettier's width; the pre-commit
  Prettier hook does and reformats (wraps > 80 cols). Run `node_modules/.bin/prettier --write <f>`
  before staging so the commit doesn't leave an unstaged reformat.
- **markdownlint (docs/).** Underscores for italics (MD049), `**` for bold; verify with
  `pre-commit run markdownlint-cli2 --files <f>` before committing docs.
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
  Details in docs/02.3 §4.27 + docs/02.4 §4.28.
