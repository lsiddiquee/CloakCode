# @cloakcode/gateway

The **standalone CloakCode gateway** — a run-it-yourself hub that serves the CloakCode phone app
(PWA) and multiplexes your **phone** (operator) and your **VS Code extensions** (providers) onto one
endpoint. Run it when you want several VS Code windows or machines to share **one** phone endpoint,
or to keep the hub outside the editor.

Pairs with the **[CloakCode VS Code extension](https://marketplace.visualstudio.com/items?itemName=rexwel.cloakcode)**:
the extension observes and steers your Copilot sessions; the gateway is the shared hub your phone
connects to.

> Needs **Node ≥ 20**. There's no app-layer auth yet — keep it on loopback behind a private tunnel,
> or only bind all interfaces on a trusted network (see [Security](#security)).

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
straight from the container, enable it, pick a login provider (**required — no default**), and mount a
volume for the token so you only sign in once:

```bash
docker run -it -p 3543:3543 \
  -e CLOAKCODE_TUNNEL=devtunnel \
  -e CLOAKCODE_TUNNEL_PROVIDER=github \
  -v cloakcode-devtunnel:/home/app/.local/share/DevTunnels \
  ghcr.io/lsiddiquee/cloakcode-gateway:latest
```

On first run it prints a **device code + URL** to the console — open the URL in any browser, enter the
code, and the tunnel starts (works detached too: read the code from `docker logs`). The token lives in
the mounted volume, so later runs sign in silently. `CLOAKCODE_TUNNEL_PROVIDER` must be `github` or
`microsoft`. The container runs as a non-root user (`app`). Prefer your own ingress instead? Leave the
tunnel off and front the published port with Cloudflare Tunnel / Tailscale / a reverse proxy.

## Connect your VS Code extension

In VS Code settings, point the extension at the gateway (several windows can share one):

```json
"cloakcode.gatewayUrl": "ws://<gateway-host>:3543"
```

If you started the gateway with a token, set the **same** value on the extension so it can register
as a provider — see [Provider token](#provider-token-shared-secret) below.

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

## Configuration (environment variables)

| var                         | default                     | meaning                                                                 |
| --------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `CLOAKCODE_GATEWAY_HOST`    | `127.0.0.1` (`0.0.0.0` image) | bind address; `0.0.0.0` to accept LAN / container / WSL clients          |
| `CLOAKCODE_GATEWAY_PORT`    | `3543`                      | listen port — also the port segment of the Dev Tunnel URL; `0` = ephemeral |
| `CLOAKCODE_TUNNEL`          | _(off)_                     | `devtunnel` → auto-host a **private** tunnel and print the phone URL     |
| `CLOAKCODE_TUNNEL_PROVIDER` | _(none)_                    | Docker only: `github` or `microsoft` for the container's device-code sign-in (required when the image must log in) |
| `CLOAKCODE_INSTANCE_ID`     | `gateway`                   | tunnel-name seed → a **stable**, per-machine phone URL                   |
| `CLOAKCODE_GATEWAY_TOKEN`   | _(off)_                     | provider↔gateway shared secret; extensions must present the same value  |
| `CLOAKCODE_GATEWAY_LOG_FILE`| `./cloakcode-gateway.jsonl` | on-disk action log (JSONL); set empty to disable                        |
| `CLOAKCODE_WEB_DIR`         | bundled `web/`              | PWA directory to serve (defaults to the bundled app)                    |
| `CLOAKCODE_LOG_LEVEL`       | `info`                      | `trace`/`debug`/`info`/`warn`/`error` (`CLOAKCODE_VERBOSE=1` ⇒ `debug`) |

The gateway logs **provider / operator connect + disconnect** by default; raise the level (or
`CLOAKCODE_VERBOSE=1`) for per-RPC detail.

## Security

There is **no app-layer auth yet**. The safe postures are:

- **Loopback + a private tunnel** (default host `127.0.0.1`; the Dev Tunnel is private, sign-in
  required) — recommended.
- **`0.0.0.0` on a trusted LAN only.** Do not expose it on an untrusted network.
- Set `CLOAKCODE_GATEWAY_TOKEN` so only extensions holding the shared secret can register as
  providers (machine-to-machine; never shown to the phone).

## Build from source

Requires the monorepo checkout ([lsiddiquee/CloakCode](https://github.com/lsiddiquee/CloakCode)):

```bash
# assemble a copy-ready folder (main.mjs + web/ + run.sh) into dist/gateway/
pnpm --filter @cloakcode/gateway assemble
cd dist/gateway && ./run.sh --tunnel      # run.sh is a flag-driven launcher (--host/--port/--tunnel…)
```

`dist/gateway/` is self-contained — copy it to any host with Node ≥ 20 and run `./run.sh` there.
`run.sh --help` lists the flags (each maps to a `CLOAKCODE_*` env var above).
