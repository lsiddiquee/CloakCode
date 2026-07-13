# @cloakcode/gateway

The **standalone CloakCode gateway** — a run-it-yourself hub (host binary / Docker image) that
serves the PWA and multiplexes phone (**operator**) and extension (**provider**) connections on
one `/bridge` endpoint, so the **leader is explicit**. See
[docs/03 → Explicit gateway](../../docs/03-architecture.md#explicit-gateway-mvp-the-hub-you-run).

Holds **no `vscode`** — it's the `vscode`-free server core (it also owns `tunnel.ts` +
`static-files.ts`; the extension's embedded mode imports them back).

## Run it standalone

```bash
# from the repo root — build the pieces, then run:
pnpm --filter @cloakcode/protocol build
pnpm --filter @cloakcode/web build
pnpm --filter @cloakcode/gateway build

CLOAKCODE_WEB_DIR=packages/web/dist \
CLOAKCODE_TUNNEL=devtunnel \
  pnpm --filter @cloakcode/gateway start
```

Environment:

| var | default | meaning |
| --- | --- | --- |
| `CLOAKCODE_GATEWAY_HOST` | `127.0.0.1` | bind address (`0.0.0.0` in Docker) |
| `CLOAKCODE_GATEWAY_PORT` | `7900` | port |
| `CLOAKCODE_WEB_DIR` | _(unset)_ | directory of the built PWA to serve (WS-only if unset) |
| `CLOAKCODE_TUNNEL` | _(unset)_ | `devtunnel` → auto-host a private tunnel and print the phone URL |
| `CLOAKCODE_INSTANCE_ID` | `gateway` | tunnel-name seed |

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
