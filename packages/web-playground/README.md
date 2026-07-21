# @cloakcode/web-playground

Dev-only UI playground for [`@cloakcode/web`](../web). It renders the **real**
PWA `App` against an **in-browser fake bridge** + fixtures, so the UI can be
designed and tweaked with **no gateway, no extension, and no real sessions**.

```bash
pnpm --filter @cloakcode/web-playground dev   # → http://localhost:5285
```

## Why a separate package

The boundary is **structural, not just conventional**: the dependency edge points
**`web-playground` → `web`** only, never the reverse. So the shipped web build
(and the `.vsix` that bundles it) can't reference the mock even by accident —
nothing here can leak into production, knowingly or unknowingly.

- `src/fake-bridge-socket.ts` — a minimal `WebSocket` stand-in. Every bridge call
  in `@cloakcode/web` funnels through `new WebSocket(url)`, so swapping this one
  global lets the real app run against fixtures. It connects to nothing (no
  network, no egress).
- `src/fixtures.ts` — canned sessions / transcripts / a pending blocker, matching
  the `@cloakcode/protocol` schemas.
- `src/main.tsx` — installs the fake, then mounts the real `App` imported from
  `@cloakcode/web` (via that package's `exports`).

Not published, not built into any artifact (`"private": true`).
