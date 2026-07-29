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
- `src/scenarios.ts` — the named bridge **states** (below). Fixtures say what the
  transcript contains; a scenario says how the ingress behaves.
- `src/main.tsx` — installs the fake, then mounts the real `App` imported from
  `@cloakcode/web` (via that package's `exports`).

Not published, not built into any artifact (`"private": true`).

## Scenarios

Several screens are only reachable when the ingress **refuses** or **answers**
something, so they can't be expressed as fixture data. Pick one with
`?scenario=<id>`; the index is also printed to the browser console.

| `?scenario=`   | Shows                                                                        |
| -------------- | ---------------------------------------------------------------------------- |
| `default`      | Populated list, two live blockers, a pinned `wss://` provider listener.       |
| `sign-in`      | Operator TOTP prompt — every op refused with `needsAuth` until a code.        |
| `first-run`    | First-run enrolment: the pairing QR, then verify a code.                      |
| `insecure`     | The plain-`ws://` provider opt-in, with the confidentiality warning.          |
| `empty`        | A paired gateway with nothing to mirror.                                      |
| `offline`      | The socket never opens — the app's offline state.                             |

The gated scenarios accept **any 6-digit code** (there is no secret to check
against) and clear any stored operator token on load, so they always start at the
screen they exist to show. Every value they serve — the token, the enrolment
secret, the certificate fingerprint — is fixture material with nothing real
behind it.

## Capturing the README screenshots

The images in [`docs/media/`](../../docs/media) are shot from here, so they show
the real UI without exposing anyone's sessions. Two things to get right:

- Run the dev server with a `wss://` override —
  `VITE_BRIDGE_URL=wss://cloakcode.local/bridge pnpm --filter @cloakcode/web-playground dev`.
  The fake socket ignores the URL, but `isBridgeInsecure()` reads it, so without
  the override every shot carries the (correct, but here misleading) plain-`http`
  insecure-mode banner.
- Screenshot with animations disabled and the read-only workspace revealed
  (gear → **Show read-only workspaces**), so the list shows all three instances.
