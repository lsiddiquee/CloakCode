# @cloakcode/web

The **client** — phone-first React + Vite PWA (also responsive for desktop). Holds no
code and no model access; it only renders the mirror and sends answers.

Contents (to build):

- WebSocket client over the tunnel to the bridge; subscribes to a session's event log
  and resumes from `lastSeq` on reconnect (robust on flaky mobile networks).
- A **component per `SessionPart` type** mirroring Copilot Chat: collapsible tool cards,
  `<details>` thinking/sections, a button group for `confirmation` multiple-choice,
  expandable diffs, syntax-highlighted code blocks.
- **Web Push** (service worker) so a backgrounded phone gets pinged the moment a session
  enters `awaiting-input` — directly solving "a blocker was silently waiting."
- Installable PWA manifest.

See [docs/03-architecture.md](../../docs/03-architecture.md).
