# @cloakcode/protocol

The **contract**. Every other package depends on this and nothing else depends on VS Code here.

Contents (to build):

- `SessionPart` discriminated union — the normalized, richly-renderable transcript part
  types (`markdown`, `thinking`, `toolCall`, `confirmation`, `progress`, `diff`,
  `fileTree`, `codeblock`, `error`). See [docs/03-architecture.md](../../docs/03-architecture.md).
- RPC operations for the bridge: `sessions.list`, `session.open`, `session.subscribe`,
  `session.respond` (answer a blocker), `session.send`.
- Event-log envelope with sequence numbers for resumable mobile streaming
  (`append` / `patch` / `updateStatus`).
- `zod` schemas for every message so both ends validate at the boundary.

Pure TypeScript, unit-tested without VS Code.
