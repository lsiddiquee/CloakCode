# CloakCode — drive GitHub Copilot from your phone

**Watch, unblock, and steer your GitHub Copilot chat sessions from a phone (or another
machine) — with _zero code-sync to GitHub_.** Your code never leaves your machine; only
prompts and minimal, redacted context ever cross the bridge.

## The problem

You kick off a long Copilot agent task in VS Code, then step away from your desk. Minutes
later Copilot is **blocked** — waiting on a question or a tool-call approval — and it just
sits idle until you're back. The existing remote options don't cover it either: the Copilot
web/CLI flows don't help when the repo **isn't on GitHub**, when you use **your own models**,
or when the session is already **running in your editor**.

## What CloakCode does

CloakCode mirrors your **existing** VS Code Copilot chat to a phone-first web app, so you can:

- **See** your live sessions and transcripts, and get notified the moment one is blocked.
- **Answer** a question or **steer** the agent with a new message.
- **Stop** a running turn, or **queue** the next instruction.
- **Approve / deny** a tool call from your phone.

…all while you keep using VS Code's own Copilot UI at your desk — pick up on the phone, drop
back to the desktop, no context lost.

### How it works

- A tiny **bridge** runs inside VS Code (bound to `127.0.0.1`) and serves a phone-friendly PWA.
- It **mirrors** your Copilot transcript and detects blockers (an interactive tool call awaiting
  input); your replies are relayed back into the session.
- Your phone reaches it over **your own private tunnel** — never through GitHub.
- **Zero code-sync:** CloakCode adds no path that uploads your workspace anywhere. The mirror and
  your replies cross only localhost and your authenticated tunnel.

## Get started — local / same machine (no tunnel)

1. Install the extension and reload VS Code.
2. Run **CloakCode: Show Phone Link** from the Command Palette.
   - In **Codespaces / a remote**, this gives a URL your phone can open directly (VS Code
     forwards it for you).
   - In **local** VS Code, the URL is loopback (`127.0.0.1`) — great on the same machine, but a
     phone can't reach it. Add a tunnel for phone access (next section).

Open the link (or scan the QR) and you'll see your live Copilot sessions.

## Get started — phone access via a private Dev Tunnel

To reach your sessions from a phone off your network, CloakCode can host a **private** Microsoft
Dev Tunnel for you — sign-in required to open the link, never anonymous:

1. Install the **devtunnel** CLI once → <https://aka.ms/DevTunnelCliInstall>
2. Enable it — either accept the one-time **"Enable Dev Tunnel?"** prompt on first activation, or
   set it yourself:

   ```json
   "cloakcode.tunnel": "devtunnel"
   ```

3. Run **CloakCode: Set Up Phone Tunnel**. If you're not signed in, CloakCode opens a terminal and
   runs `devtunnel user login` for you (choose GitHub or Microsoft — device-code is offered for
   containers/remotes). Finish in the terminal, then click **Set Up Phone Tunnel** again.
4. Run **CloakCode: Show Phone Link** and scan the QR on your phone.

Enabling the setting is all it takes — CloakCode drives the CLI-install prompt and the login for
you. Prefer your own tunnel? Set the `CLOAKCODE_PUBLIC_URL` environment variable to its URL and
CloakCode uses that instead.

## Live blocker overlay (optional)

CloakCode installs a small **Copilot notifier hook** (a single per-environment file) so your phone
sees a pending tool call the instant it appears. The hook only _notifies_ — it never approves or
denies anything. It's on by default (`cloakcode.installHook`); turn it off to manage it yourself.

## Settings

| Setting                       | Default   | What it does                                                                                                                        |
| ----------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `cloakcode.tunnel`            | `off`     | `off` = VS Code's automatic forwarding; `devtunnel` = host a private Dev Tunnel and get a phone URL automatically.                  |
| `cloakcode.gatewayUrl`        | _(empty)_ | Connect to a standalone [gateway](https://www.npmjs.com/package/@cloakcode/gateway) instead of hosting in-editor. Empty = embedded. |
| `cloakcode.gatewayToken`      | _(empty)_ | Shared secret to register with a gateway that requires provider auth (machine-to-machine; never shown to the phone).                |
| `cloakcode.port`              | _(auto)_  | Localhost port (bound to `127.0.0.1`). Unset → try `3543` then an ephemeral port; a fixed value keeps the phone URL stable.         |
| `cloakcode.installHook`       | `true`    | Install the Copilot notifier hook that powers the live-pending overlay.                                                             |
| `cloakcode.surfaceDebounceMs` | `3000`    | Wait this long before showing a pending tool call, so VS Code's fast auto-approvals resolve first.                                  |
| `cloakcode.logLevel`          | `info`    | Verbosity of the **CloakCode** output channel. Local only — no telemetry.                                                          |

## Commands

Run from the Command Palette (prefix **CloakCode:**):

| Command                                  | Purpose                                             |
| ---------------------------------------- | --------------------------------------------------- |
| **Show Phone Link**                      | Open the QR / phone URL for this window.             |
| **Set Up Phone Tunnel**                  | Guided Dev Tunnel setup (install + sign-in).         |
| **Reconnect**                            | Re-establish the bridge / gateway connection.        |
| **Set Instance ID**                      | Name this machine for a stable, distinct phone URL.  |
| **Pair Operator Access (TOTP)**          | Show the QR to enrol an authenticator for phone auth. _Embedded mode only._ |
| **Reset Operator Access (TOTP)**         | Regenerate the phone-auth TOTP secret (lockout recovery). _Embedded mode only._ |
| **Sign in to Gateway**                   | Enter a TOTP code to authenticate this window with a gateway. _Gateway mode only._ |
| **Install / Repair Copilot Hook**        | (Re)install the notifier hook.                       |
| **Remove Copilot Hook (all workspaces)** | Remove the per-environment hook.                     |
| **Show Diagnostics**                     | Dump current status for troubleshooting.             |

**Mode-gated commands.** The Command Palette hides commands that don't apply to the current mode
(via the `cloakcode.embedded` context key): the two **Operator Access (TOTP)** commands manage the
**embedded** bridge's own phone auth and appear **only when this window runs the embedded gateway**;
**Sign in to Gateway** appears **only in gateway mode** (`cloakcode.gatewayUrl` set). See _Sharing
one hub across windows_ below.

## Naming this instance (the instance id)

Each window has an **instance id** — a short display label that identifies it on the phone (on the
session-list group) and, when phone auth is enabled, doubles as the **authenticator label**. The
authenticator issuer is always `CloakCode`, so your app shows it as `CloakCode: <instance-id>`.

- **Default (auto):** `<env-kind>:<workspace>` — e.g. `local:cloakcode`, `wsl:my-repo`, or a
  dev-container's `name` from `devcontainer.json`. This already distinguishes one workspace/window
  from another, so you normally don't need to set anything.
- **Override:** run **CloakCode: Set Instance ID** to name it yourself (stored per-workspace). Leave
  it empty to fall back to the auto default.

> The **standalone gateway** has its own separate identity (`CLOAKCODE_INSTANCE_ID`, defaulting to
> the **machine hostname**) — see the [gateway package](https://www.npmjs.com/package/@cloakcode/gateway).
> When you connect to a gateway, the phone shows _that_ gateway's name in the app header.

## Sharing one hub across windows — the standalone gateway

By default the bridge runs inside VS Code. To let several windows or machines share **one** phone
endpoint, run the standalone **[CloakCode gateway](https://www.npmjs.com/package/@cloakcode/gateway)**
(`npx @cloakcode/gateway` or the Docker image) and point the extension at it:

```json
"cloakcode.gatewayUrl": "ws://<gateway-host>:7900"
```

If the gateway is **unreachable** at startup, the extension logs a warning and falls back to
embedded mode. If the gateway is reachable but **requires sign-in** (operator MFA is on), it does
**not** fall back — it stays in gateway mode and asks you to authenticate, so it never spins up a
second, competing bridge:

1. Run **CloakCode: Sign in to Gateway** and enter the current 6-digit code from the authenticator
   you enrolled against **the gateway** (the QR/secret it printed on first run — not the embedded
   bridge's "Pair Operator Access" code).
2. The extension stores the issued provider token (per gateway URL) and reconnects automatically.

The two **Pair / Reset Operator Access (TOTP)** commands manage the _embedded_ bridge's own phone
auth, so they're hidden in gateway mode; **Sign in to Gateway** is hidden in embedded mode. See the
gateway package for npm / Docker usage.

## Privacy & security

- **No code-sync.** CloakCode never pushes or uploads your workspace to GitHub or anywhere else.
- **Localhost + your tunnel only.** The bridge binds `127.0.0.1`; remote access is via _your_
  private Dev Tunnel (sign-in required), never a public or anonymous endpoint.
- **Local logs only** (View → Output → _CloakCode_) — no telemetry.

## Troubleshooting

- **"Phone link is loopback"** — you're in local VS Code without a tunnel. Set
  `cloakcode.tunnel: devtunnel` (and run **Set Up Phone Tunnel**), or set `CLOAKCODE_PUBLIC_URL`.
- Logs: **View → Output → CloakCode** (raise `cloakcode.logLevel` to `debug`).
- **CloakCode: Show Diagnostics** dumps the current state.

## Install from a `.vsix`

Every [GitHub Release](https://github.com/lsiddiquee/CloakCode/releases) attaches the `.vsix` plus
`install.sh` / `uninstall.sh`:

```bash
code --install-extension cloakcode-<version>.vsix
# or, from the downloaded folder:  ./install.sh   (CODE_BIN=code-insiders for another editor)
```

---

CloakCode is open source (MIT) — <https://github.com/lsiddiquee/CloakCode>.
