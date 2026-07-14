# @cloakcode/gateway

The **standalone CloakCode gateway** — a run-it-yourself hub (host binary / Docker image) that
serves the PWA and multiplexes phone (**operator**) and extension (**provider**) connections on
one `/bridge` endpoint, so the **leader is explicit**. See
[docs/03 → Explicit gateway](../../docs/03-architecture.md#explicit-gateway-mvp-the-hub-you-run).

Holds **no `vscode`** — it's the `vscode`-free server core (it also owns `tunnel.ts` +
`static-files.ts`; the extension's embedded mode imports them back).

## Run it standalone

**Quickest — assemble a copy-ready folder, then run it:**

```bash
# from the repo root: builds protocol + gateway + PWA and stages dist/gateway/
pnpm --filter @cloakcode/gateway assemble

# run it — serves the PWA + hub; --tunnel prints a phone URL
cd dist/gateway
./run.sh --tunnel
```

`dist/gateway/` (`main.mjs` + `web/` + `run.sh`) is self-contained: copy it to any host with
Node ≥ 20 and run `./run.sh` there.

### `run.sh` options

| flag                 | default        | meaning                                                               |
| -------------------- | -------------- | --------------------------------------------------------------------- |
| `--host <addr>`      | `127.0.0.1`    | bind address; use `0.0.0.0` to accept LAN / container / WSL clients   |
| `--port <n>`         | `7900`         | listen port (also the port segment of the Dev Tunnel URL)             |
| `--web-dir <path>`   | bundled `web/` | directory of the built PWA to serve                                   |
| `--instance-id <id>` | `gateway`      | tunnel-name seed → a **stable** phone URL, distinct per machine       |
| `--tunnel`           | off            | expose via a **private** Microsoft Dev Tunnel and print the phone URL |
| `--no-tunnel`        | _(default)_    | local only                                                            |
| `--verbose`          | off            | also log per-RPC detail (relay routing, `sessions.list` counts)       |
| `-h`, `--help`       |                | print usage and exit                                                  |

Each flag maps to a `CLOAKCODE_*` [environment variable](#environment-variables) (the flag wins when
both are set). `run.sh` also preflights Node ≥ 20 and, for `--tunnel`, that `devtunnel` is installed
and signed in — degrading to local-only with the exact fix if not.

The gateway logs **provider / operator connect + disconnect** by default (so you can watch extensions
and phones attach and drop); `--verbose` adds per-RPC detail (relay routing + `sessions.list` counts).

**Reachable from another machine or container?** Bind all interfaces — loopback (`127.0.0.1`)
only accepts same-host clients, so a separate container/VM connecting to the host IP is refused:

```bash
./run.sh --host 0.0.0.0 --tunnel      # clients use ws://<this-host-ip>:7900
```

There is no app-layer auth yet, so only bind `0.0.0.0` on a trusted network (otherwise keep it
on loopback + a private tunnel).

**Or run straight from the workspace, without assembling:**

```bash
pnpm --filter @cloakcode/protocol build
pnpm --filter @cloakcode/web build
pnpm --filter @cloakcode/gateway build

CLOAKCODE_WEB_DIR=packages/web/dist \
CLOAKCODE_TUNNEL=devtunnel \
  pnpm --filter @cloakcode/gateway start
```

### Environment variables

These drive the runner directly (`pnpm start`, Docker, or `main.mjs`); `run.sh` sets them from its
flags.

| var                      | default     | meaning                                                          |
| ------------------------ | ----------- | ---------------------------------------------------------------- |
| `CLOAKCODE_GATEWAY_HOST` | `127.0.0.1` | bind address (`0.0.0.0` in Docker)                               |
| `CLOAKCODE_GATEWAY_PORT` | `7900`      | port                                                             |
| `CLOAKCODE_WEB_DIR`      | _(unset)_   | directory of the built PWA to serve (WS-only if unset)           |
| `CLOAKCODE_TUNNEL`       | _(unset)_   | `devtunnel` → auto-host a private tunnel and print the phone URL |
| `CLOAKCODE_INSTANCE_ID`  | `gateway`   | tunnel-name seed                                                 |

## Docker

```bash
# build context is the repo ROOT:
docker build -f packages/gateway/Dockerfile -t cloakcode-gateway .
docker run --rm -p 7900:7900 cloakcode-gateway
```

The image serves the PWA + hub on `0.0.0.0:7900`. It does **not** bundle the `devtunnel` CLI —
front it with your own private tunnel/ingress (there's no app-layer auth yet).

## Status

- ✅ `ProviderRegistry` + `mergeSessions` — aggregate + de-dupe `sessions.list` across providers by
  `(instanceId, sessionId)`, owned-preferred.
- ✅ `startGateway` — serves the PWA + WS hub; `provider.hello` role split; operator `sessions.list`
  relay. Integration-tested with real WebSockets.
- ✅ `cloakcode-gateway` runner (`main.ts`) that owns the Dev Tunnel; ESM bundle + Dockerfile.

**Next:** the streaming `session.subscribe` + actuator (`respond`/`decide`/`answer`) relay, and the
extension **client mode** (`cloakcode.gatewayUrl`) that makes an extension connect in as a provider.
