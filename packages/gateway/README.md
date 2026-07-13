# @cloakcode/gateway

The **standalone CloakCode gateway** — a run-it-yourself hub (host binary / Docker image) that
serves the PWA and multiplexes phone (**operator**) and extension (**provider**) connections on
one `/bridge` endpoint, so the **leader is explicit**. See
[docs/03 → Explicit gateway](../../docs/03-architecture.md#explicit-gateway-mvp-the-hub-you-run).

Holds **no `vscode`** (it extends the `dev-server` seam — the bridge is already `vscode`-free,
with the actuator injected as callbacks).

## Status

Transport-agnostic core only, so far:

- `ProviderRegistry` — in-memory registry of connected providers, keyed by `instanceId`.
- `mergeSessions` — aggregate + de-dupe `sessions.list` across providers by
  `(instanceId, sessionId)`, preferring the `owned` (actuatable) row.

Next slices (build with the user, needs end-to-end validation): the WebSocket hub runtime
(`provider.hello` registration + operator RPC relay), the extension **client mode**
(`cloakcode.gatewayUrl`), and the Docker image.
