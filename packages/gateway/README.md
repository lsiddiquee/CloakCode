# @cloakcode/gateway

The **standalone CloakCode gateway** — a run-it-yourself hub that serves the CloakCode phone app
(PWA) and multiplexes your **phone** (operator) and your **VS Code extensions** (providers) onto one
endpoint. Run it when you want several VS Code windows or machines to share **one** phone endpoint,
or to keep the hub outside the editor.

Pairs with the **[CloakCode VS Code extension](https://marketplace.visualstudio.com/items?itemName=rexwel.cloakcode)**:
the extension observes and steers your Copilot sessions; the gateway is the shared hub your phone
connects to.

> Needs **Node ≥ 20**. When the gateway is **exposed** (a wide `0.0.0.0` bind or a live tunnel) it
> requires **operator TOTP** by default (secure-by-exposure — see [Operator auth](#operator-auth-totp)
> and the [step-by-step setup](#full-setup--exposed-gateway-with-mfa-step-by-step)); still prefer a
> **private tunnel** over a wide bind on an untrusted network (see [Security](#security)).

## Run it — `npx` (no install)

```bash
npx @cloakcode/gateway
```

Serves the PWA + hub on `ws://127.0.0.1:3543` and prints the URLs to point your extension at.

There are no CLI flags — the published bin (`cloakcode-gateway`) is configured entirely by
**environment variables** set on the command line. The common ones:

```bash
# phone access via a private Dev Tunnel (needs the devtunnel CLI, signed in) — prints a phone URL
CLOAKCODE_TUNNEL=devtunnel npx @cloakcode/gateway

# pick a fixed port (default 3543; a fixed value keeps the phone/tunnel URL stable)
CLOAKCODE_GATEWAY_PORT=8080 npx @cloakcode/gateway

# accept LAN / container clients, require a provider token, and tunnel — all at once
CLOAKCODE_GATEWAY_HOST=0.0.0.0 \
CLOAKCODE_GATEWAY_PORT=8080 \
CLOAKCODE_GATEWAY_TOKEN=<shared-secret> \
CLOAKCODE_TUNNEL=devtunnel \
  npx @cloakcode/gateway
```

See [all options](#configuration-environment-variables) below.

## Run it — Docker

```bash
docker run --rm -p 3543:3543 ghcr.io/lsiddiquee/cloakcode-gateway:latest
# pin a version:  ...cloakcode-gateway:v0.1.2
```

The image serves the PWA + hub on `0.0.0.0:3543`. Configure with the same environment variables via
`-e`, and map the port with `-p`:

```bash
docker run --rm -p 8080:8080 \
  -e CLOAKCODE_GATEWAY_PORT=8080 \
  -e CLOAKCODE_GATEWAY_TOKEN=<shared-secret> \
  ghcr.io/lsiddiquee/cloakcode-gateway:latest
```

### Phone tunnel from the container

The image **bundles the `devtunnel` CLI** (inert unless you enable it). To host a private Dev Tunnel
straight from the container, enable it and mount a volume for the token so you only sign in once:

```bash
docker run -p 3543:3543 \
  -e CLOAKCODE_TUNNEL=devtunnel \
  -v cloakcode-devtunnel:/home/app/.local/share/DevTunnels \
  ghcr.io/lsiddiquee/cloakcode-gateway:latest
```

On first run it prints a **device code + URL** to the console (`docker logs`) — open the URL in any
browser and enter the code. The sign-in is **device-code, so `-it` is not needed** (it runs fully
detached); it blocks until you finish, and if the code expires the container exits — just restart. The
token lives in the mounted volume, so later runs sign in silently. Sign-in defaults to **GitHub**; set
`-e CLOAKCODE_TUNNEL_PROVIDER=microsoft` for a Microsoft account. The container runs as a non-root user
(`app`). Prefer your own ingress instead? Leave the tunnel off and front the published port with
Cloudflare Tunnel / Tailscale / a reverse proxy.

### Persisting state across container upgrades (volumes)

A container is **ephemeral** — without volumes, replacing it (an image upgrade, `docker rm`, a
recreate) **regenerates the operator TOTP secret** (so every paired phone must re-enrol), **drops the
Dev Tunnel sign-in**, and **discards the action log**. Mount a volume for each piece of state you want
to keep — and you can **relocate** the files with env vars if you'd rather point them at one shared
volume:

| State                                  | Default path in the container         | Relocate with                       | Keep it with                                                                            |
| -------------------------------------- | ------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| **Operator TOTP secret** (+ confirmed) | `/home/app/.cloakcode/operator-totp.secret` | `CLOAKCODE_MFA_SECRET_FILE`         | `-v cloakcode-mfa:/home/app/.cloakcode`                                                  |
| **Dev Tunnel sign-in token**           | `/home/app/.local/share/DevTunnels`   | _(fixed — mount the path)_          | `-v cloakcode-devtunnel:/home/app/.local/share/DevTunnels`                               |
| **Action log** (JSONL)                 | `/app/cloakcode-gateway.jsonl`        | `CLOAKCODE_GATEWAY_LOG_FILE` (`""` = off) | point it into a mounted dir (see below)                                             |

All three at once — TOTP secret survives upgrades, tunnel signs in once, and the action log lands on a
named volume:

```bash
docker run -p 3543:3543 \
  -v cloakcode-mfa:/home/app/.cloakcode \
  -v cloakcode-devtunnel:/home/app/.local/share/DevTunnels \
  -v cloakcode-logs:/data \
  -e CLOAKCODE_GATEWAY_LOG_FILE=/data/gateway.jsonl \
  -e CLOAKCODE_TUNNEL=devtunnel \
  ghcr.io/lsiddiquee/cloakcode-gateway:latest
```

Prefer **one** volume for everything? Relocate the secret + log into it and mount it once:
`-e CLOAKCODE_MFA_SECRET_FILE=/data/totp.secret -e CLOAKCODE_GATEWAY_LOG_FILE=/data/gateway.jsonl -v cloakcode-data:/data`
(the Dev Tunnel token dir is fixed, so mount it separately if you use the built-in tunnel).

## Full setup — exposed gateway with MFA (step by step)

When the gateway is **exposed** (a wide `0.0.0.0` bind — the Docker default — or a live tunnel),
operator **TOTP is on automatically** (secure-by-exposure). Here's the whole flow: gateway → phone →
extension. Force it on/off with `CLOAKCODE_MFA=required` / `CLOAKCODE_MFA=off`.

### 1. Start the gateway

```bash
# Docker binds 0.0.0.0 by default, so MFA turns on. Mount a volume so the TOTP
# secret survives container replacement.
docker run -p 3543:3543 \
  -v cloakcode-mfa:/home/app/.cloakcode \
  ghcr.io/lsiddiquee/cloakcode-gateway:latest
```

On first run the console prints the instance name + the connect URLs and reports that **enrolment is
required** — until you pair an authenticator the hub serves **only** the pairing screen, no session
data. (Add `-e CLOAKCODE_TUNNEL=devtunnel` for a phone URL — a headless GitHub device-code sign-in, or
front the port with your own private tunnel.)

### 2. Enrol an authenticator (operator — one time)

Open the gateway app — **easiest on a desktop browser** so you can scan the on-screen QR with your
phone's authenticator app:

- **Local / LAN:** `http://<gateway-host>:<gateway-port>`
- **Tunnel:** the phone URL printed in the console (`docker logs`).

The app shows a **QR code**. Scan it into an authenticator app (Google Authenticator, 1Password, …),
then **enter the current 6-digit code** to confirm. The secret is generated once and stored `0600`
(in the mounted volume). Once confirmed, the gateway is **active** and serves normally.

> **Desktop vs phone.** Opening the page on a **desktop** lets you scan the QR with your phone's
> authenticator. If you open it **on the phone itself**, you can't scan a QR on the same screen —
> tap/copy the shown secret into your authenticator instead.
>
> **Lock it down with strict enrolment.** By **default** (`CLOAKCODE_MFA_ENROL=browser`) the QR +
> secret are served to whoever opens the gateway during enrolment — convenient, but it means **anyone
> who reaches the gateway before you've paired could enrol their own authenticator and take over**.
> Set `CLOAKCODE_MFA_ENROL=strict` so the secret is **never sent over the wire** — the QR + otpauth
> URI are printed **only to the console** (`docker logs`), so only someone with console/log access can
> pair. Scan from the console, then enter a code in the app.

Every later phone/browser logs in with the current 6-digit code and gets a **session token** (12 h,
or 30 days with "remember this device"), so reconnects don't re-prompt. Replayed and repeatedly wrong
codes are rejected.

### 3. Connect your VS Code extension (provider)

In each VS Code window point the extension at the gateway:

```json
"cloakcode.gatewayUrl": "ws://<gateway-host>:<gateway-port>"
```

The extension connects, and because the gateway requires auth it asks the extension to **sign in** (it
does **not** fall back to an embedded bridge). Click the **Sign In** prompt, or run **CloakCode: Sign
in to Gateway** from the Command Palette, and enter a current 6-digit code from the **same**
authenticator you enrolled in step 2. The extension stores the issued provider token (per gateway URL)
and reconnects. _(Set the URL after activation? Run **CloakCode: Reconnect** or reload the window.)_

> Headless/automation instead of interactive sign-in? Present a static machine-to-machine secret:
> `CLOAKCODE_GATEWAY_TOKEN` on the gateway + `cloakcode.gatewayToken` on the extension
> ([Provider token](#provider-token-shared-secret)).

### 4. Validate

Refresh the gateway in your browser/phone — the Copilot **sessions from that VS Code window now
appear**. Open one to see the live transcript; a blocked session shows a **"Needs your input"** card
you can answer remotely.

## Connect your VS Code extension

In VS Code settings, point the extension at the gateway (several windows can share one):

```json
"cloakcode.gatewayUrl": "ws://<gateway-host>:<gateway-port>"
```

If you started the gateway with a token, set the **same** value on the extension so it can register
as a provider — see [Provider token](#provider-token-shared-secret) below.

If the gateway requires **operator TOTP** (the default when exposed), the extension connects but the
gateway asks it to **sign in** — it does **not** fall back to an embedded bridge. Click the **Sign
In** prompt (or run **CloakCode: Sign in to Gateway**) and enter a current 6-digit code from the
authenticator you enrolled on the gateway; the extension stores the issued provider token per URL and
reconnects. Full walkthrough: [Full setup](#full-setup--exposed-gateway-with-mfa-step-by-step).

For a gateway on **another machine or container**, run it with `CLOAKCODE_GATEWAY_HOST=0.0.0.0` and
use that host's IP in `gatewayUrl` (loopback only accepts same-host clients).

## Provider token (shared secret)

The gateway and every extension that connects to it authenticate the **provider↔gateway** link with
one shared secret. **When you run the gateway separately, the token must be identical on both sides**
and configured in both places — otherwise the gateway rejects the extension and its sessions never
reach your phone.

Set the **same** value on the gateway and on every VS Code window that connects:

```bash
# gateway (env) — npx
CLOAKCODE_GATEWAY_TOKEN=<shared-secret> npx @cloakcode/gateway
# gateway (env) — Docker
docker run --rm -p 3543:3543 -e CLOAKCODE_GATEWAY_TOKEN=<shared-secret> ghcr.io/lsiddiquee/cloakcode-gateway:latest
```

```json
// VS Code settings — must match the gateway's token exactly
"cloakcode.gatewayToken": "<shared-secret>"
```

- **Machine-to-machine only.** The token is never sent to or shown on the phone (operator auth is
  separate).
- **Both unset = no auth** (fine for loopback dev). If the gateway has a token and the extension
  doesn't — or they differ — the gateway logs `provider.auth_reject` and closes the connection.
- Use any hard-to-guess value; e.g. `openssl rand -hex 32`. The `CLOAKCODE_GATEWAY_TOKEN` env var
  overrides the `cloakcode.gatewayToken` setting on the extension side.

## Operator auth (TOTP)

The **phone → gateway** boundary is gated by a time-based one-time code (RFC 6238 TOTP) whenever the
hub is **exposed** — a wide bind or a live tunnel. Force it with `CLOAKCODE_MFA=required`, turn it
off with `CLOAKCODE_MFA=off`; unset means secure-by-exposure (off for pure loopback dev). For the
end-to-end walkthrough see [Full setup](#full-setup--exposed-gateway-with-mfa-step-by-step).

**Pair once (enrolment).** On first run the gateway generates a secret and persists it `0600` to
`CLOAKCODE_MFA_SECRET_FILE` (default `~/.cloakcode/operator-totp.secret`). A fresh secret is
**unconfirmed** — the hub runs in **enrolment mode**, serving only the pairing screen until you verify
a code. **Default (browser):** open the gateway URL and the app shows the **QR** — scan it into an
authenticator app, then enter a code to confirm. **Strict** (`CLOAKCODE_MFA_ENROL=strict`): the
secret is never sent over the wire — the QR + otpauth URI are printed to the **console** instead; scan
there and verify in the app. Either way the secret is shown **once**; later runs reuse the file.

**Each phone logs in** with the current 6-digit code; the gateway returns a signed **session token**
(12h, or 30d with “remember this device”) so reconnects don't re-prompt until it expires. A reused
code (replay) and repeated bad codes (lockout) are rejected. The secret is never sent to the phone
or written to the action log.

**Identifying a gateway (`CLOAKCODE_INSTANCE_ID`).** Each gateway has an **instance id** used as
its authenticator label (the `otpauth` account — so the app shows `CloakCode: <id>`), its Dev-Tunnel
name seed, and the **name shown to the phone** (in the app header). It defaults to the **machine
hostname** (the Windows computer/NetBIOS name, or the Unix hostname) — printed at startup as
`[cloakcode-gateway] instance: <id>` — so gateways on different machines are already distinguishable
with no configuration.

**Running more than one gateway on one machine** (e.g. office + home)? Set a distinct
`CLOAKCODE_INSTANCE_ID` on each (`office`, `home`, …) so the authenticator entries read
`CloakCode: office` / `CloakCode: home` and the phone shows which one you're connected to, instead of
two identical hostnames. The VS Code extension stores each gateway's issued token separately (per
URL), so switching `cloakcode.gatewayUrl` between them never re-pairs.

In **Docker**, mount `-v cloakcode-mfa:/home/app/.cloakcode` so the TOTP secret survives container
replacement (the image runs as `app`, so its home is `/home/app`), or relocate it with
`CLOAKCODE_MFA_SECRET_FILE` — see
[Persisting state across container upgrades](#persisting-state-across-container-upgrades-volumes) for
all the volumes (secret, tunnel token, action log).

## Configuration (environment variables)

| var                         | default                     | meaning                                                                 |
| --------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `CLOAKCODE_GATEWAY_HOST`    | `127.0.0.1` (`0.0.0.0` image) | bind address; `0.0.0.0` to accept LAN / container / WSL clients          |
| `CLOAKCODE_GATEWAY_PORT`    | `3543`                      | listen port — also the port segment of the Dev Tunnel URL; `0` = ephemeral |
| `CLOAKCODE_TUNNEL`          | _(off)_                     | `devtunnel` → auto-host a **private** tunnel and print the phone URL     |
| `CLOAKCODE_TUNNEL_PROVIDER` | `github`                    | Docker only: `github` or `microsoft` for the container's device-code sign-in; defaults to GitHub |
| `CLOAKCODE_INSTANCE_ID`     | `gateway`                   | tunnel-name seed **and** authenticator label (e.g. `office`/`home`, so multiple gateways are distinguishable in your app) |
| `CLOAKCODE_GATEWAY_TOKEN`   | _(off)_                     | provider↔gateway shared secret; extensions must present the same value  |
| `CLOAKCODE_MFA`             | _(secure by exposure)_      | operator TOTP: `required` to force it, `off` to disable; unset ⇒ **on when the hub is exposed** (wide bind / live tunnel), off for pure loopback |
| `CLOAKCODE_MFA_SECRET_FILE` | `~/.cloakcode/operator-totp.secret` | where the base32 TOTP secret persists (`0600`); mount it as a volume in Docker |
| `CLOAKCODE_MFA_ENROL`       | `browser`                   | `strict` never sends the pairing secret over the wire (console QR only)  |
| `CLOAKCODE_MFA_RESET`       | _(off)_                     | `1` regenerates the secret (lockout recovery) and re-enters enrolment    |
| `CLOAKCODE_GATEWAY_LOG_FILE`| `./cloakcode-gateway.jsonl` | on-disk action log (JSONL); set empty to disable                        |
| `CLOAKCODE_WEB_DIR`         | bundled `web/`              | PWA directory to serve (defaults to the bundled app)                    |
| `CLOAKCODE_LOG_LEVEL`       | `info`                      | `trace`/`debug`/`info`/`warn`/`error` (`CLOAKCODE_VERBOSE=1` ⇒ `debug`) |

The gateway logs **provider / operator connect + disconnect** by default; raise the level (or
`CLOAKCODE_VERBOSE=1`) for per-RPC detail.

## Security

The two trust boundaries are authenticated separately:

- **Operator (phone) → gateway: TOTP (F2a).** On by default whenever the hub is **exposed** (wide
  bind or a live tunnel); force it with `CLOAKCODE_MFA=required`, disable with `CLOAKCODE_MFA=off`.
  See [Operator auth (TOTP)](#operator-auth-totp) — pair once, then each phone logs in with a
  6-digit code and resumes with a 12h/30d session token.
- **Provider (extension) → gateway: shared token.** Set `CLOAKCODE_GATEWAY_TOKEN` so only
  extensions holding the secret can register (machine-to-machine; never shown to the phone).

**Both set together?** The two hops authenticate **independently** — enabling one never disables the
other:

- **Phone (operator) → gateway:** always **TOTP** when MFA is on. The static token is **never** used
  on this hop.
- **Extension (provider) → gateway:** `verifyProviderCredential` accepts **either** a TOTP-issued
  token **or** the static token — an **OR**, not a priority or override. With **MFA only**, the
  extension must sign in with a code to obtain a token, so **TOTP gates this hop too**; adding a
  static token just supplies a **second accepted credential** (the headless escape hatch). On its
  side, the extension prefers its stored sign-in token and falls back to the static one.

Still prefer **loopback + a private tunnel** (default host `127.0.0.1`; the Dev Tunnel is private,
sign-in required) over a wide `0.0.0.0` bind on an untrusted network — TOTP gates control, but a
private tunnel keeps the surface off the open internet.

## Build from source

Requires the monorepo checkout ([lsiddiquee/CloakCode](https://github.com/lsiddiquee/CloakCode)):

```bash
# assemble a copy-ready folder (main.mjs + web/ + run.sh) into dist/gateway/
pnpm --filter @cloakcode/gateway assemble
cd dist/gateway && ./run.sh --tunnel      # run.sh is a flag-driven launcher (--host/--port/--tunnel…)
```

`dist/gateway/` is self-contained — copy it to any host with Node ≥ 20 and run `./run.sh` there.
`run.sh --help` lists the flags (each maps to a `CLOAKCODE_*` env var above).
