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

Serves the PWA + hub on `ws://127.0.0.1:3543` and prints the URLs to point your extension at. For
phone access, add a **private** Dev Tunnel (needs the [`devtunnel`](https://aka.ms/DevTunnelCliInstall)
CLI, signed in) — it prints a phone URL:

```bash
CLOAKCODE_TUNNEL=devtunnel npx @cloakcode/gateway
```

The published bin is `cloakcode-gateway`; it's configured entirely by
[environment variables](#configuration-environment-variables).

## Run it — Docker

```bash
docker run --rm -p 3543:3543 ghcr.io/lsiddiquee/cloakcode-gateway:latest
# pin a version:  ...cloakcode-gateway:v0.1.1
```

The image serves the PWA + hub on `0.0.0.0:3543`. It does **not** bundle the `devtunnel` CLI — front
it with your own private tunnel / ingress. Configure with `-e`:

```bash
docker run --rm -p 3543:3543 \
  -e CLOAKCODE_GATEWAY_TOKEN=<shared-secret> \
  ghcr.io/lsiddiquee/cloakcode-gateway:latest
```

## Connect your VS Code extension

In VS Code settings, point the extension at the gateway (several windows can share one):

```json
"cloakcode.gatewayUrl": "ws://<gateway-host>:3543"
```

If you started the gateway with `CLOAKCODE_GATEWAY_TOKEN`, set the **same** value on the extension so
it can register as a provider:

```json
"cloakcode.gatewayToken": "<shared-secret>"
```

For a gateway on **another machine or container**, run it with `CLOAKCODE_GATEWAY_HOST=0.0.0.0` and
use that host's IP in `gatewayUrl` (loopback only accepts same-host clients).

## Configuration (environment variables)

| var                         | default                     | meaning                                                                 |
| --------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `CLOAKCODE_GATEWAY_HOST`    | `127.0.0.1` (`0.0.0.0` image) | bind address; `0.0.0.0` to accept LAN / container / WSL clients          |
| `CLOAKCODE_GATEWAY_PORT`    | `3543`                      | listen port — also the port segment of the Dev Tunnel URL; `0` = ephemeral |
| `CLOAKCODE_TUNNEL`          | _(off)_                     | `devtunnel` → auto-host a **private** tunnel and print the phone URL     |
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
