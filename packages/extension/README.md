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
