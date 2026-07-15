# @cloakcode/extension

The only package that imports `vscode`. Thin adapter that wires the pure pieces together.

Contents (to build):

- **Model port** — implements the `@cloakcode/agent` model interface using
  `vscode.lm.selectChatModels({ vendor: 'copilot' })` (stable API).
- **Observer** — tails `workspaceStorage/*/GitHub.copilot-chat/transcripts/*.jsonl`,
  normalizes events into `SessionPart`s, and detects blockers via the unmatched
  interactive `tool.execution_start` signature (see research findings). Powers the
  remote **session list** and **live mirror**. Works for stock Copilot sessions too.
- **Bridge server** — a localhost (`127.0.0.1:7801`) WebSocket server speaking the
  `@cloakcode/protocol` RPC. This is the seam the tunnel connects to.
- **Actuator** — answering/steering: owned-loop resolution (deterministic) plus an
  experimental command-injection/queue path.

Runs with proposed API disabled (Marketplace-publishable). The optional native-VS-Code
chat-UI mirroring (proposed `chatSessionsProvider`) is a later, sideloaded-only layer.

## Dev flow (build · install · run)

Package a `.vsix` (this bundles the extension **and** the PWA first) into
`dist/extension/` at the repo root — mirroring the gateway's `dist/gateway/`:

```bash
pnpm --filter @cloakcode/extension package
# → dist/extension/  (cloakcode-<version>.vsix + install.sh + uninstall.sh)
```

Install / uninstall it (extension id `rexwel.cloakcode`) with the bundled scripts —
copy the `dist/extension/` folder anywhere and run them (set `CODE_BIN` for a
non-`code` CLI). Reload the window afterwards:

```bash
cd dist/extension
./install.sh                 # or: code --install-extension cloakcode-<version>.vsix
./uninstall.sh               # removes the extension AND its per-env Copilot hook
```

Run the bridge in one of two modes:

- **Embedded (default).** No separate process — the extension starts its own `127.0.0.1`
  bridge and serves the PWA. Set `cloakcode.tunnel` to `devtunnel` (or set the
  `CLOAKCODE_PUBLIC_URL` env var for your own tunnel) and run **CloakCode: Show Phone Link**
  for the QR code.
- **Explicit gateway.** Run the standalone hub (see [`@cloakcode/gateway`](../gateway/README.md))
  and point the extension at it — multiple windows can share one gateway:

  ```json
  "cloakcode.gatewayUrl": "ws://<gateway-host>:7900"
  ```

  If the URL is unreachable the extension logs a warning and falls back to the embedded bridge.
  For a gateway on another machine or container, start it with `--host 0.0.0.0` and use that
  host's IP.

Logs live in **Output → CloakCode**.
