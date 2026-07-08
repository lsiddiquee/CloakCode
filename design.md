# CloakCode — Project overview & pragmatic design

> A short, approachable companion to the detailed design in [`docs/`](docs/README.md).
> This file is the **"simple first, improve over time"** view: what CloakCode is, and the
> smallest thing we can ship that actually works — then how we grow it without repainting.

## What it is (one paragraph)

CloakCode lets you **watch and drive GitHub Copilot from your phone** while your code
**never leaves your machine**. In locked-down enterprise tenants where pushing code to
GitHub is banned, CloakCode keeps the whole repo local and sends only prompts and minimal,
redacted context across a private tunnel to *your* infra — never GitHub.

## Why (the pain)

You kick off a long Copilot agent run, walk away, and it silently stalls on a confirmation
or a multiple-choice prompt. You don't notice for an hour. CloakCode surfaces that blocker
on your phone and (later) lets you answer it from wherever you are.

## The non-negotiables (unchanged, whatever we build)

These hold for **every** version, including v0:

1. **Zero code-sync to GitHub** — no push/upload/repo-sync path exists in the codebase.
2. **Minimal, redacted egress** — only prompts + small context leave, after a redaction gate.
3. **Localhost-only bridge** — binds `127.0.0.1`; remote access is via *your* tunnel only.
4. **Provenance tags** — every message is tagged `genuine-local-user` / `remote-operator` /
   `cloakcode-staged`; reflected/staged text is never trusted as user intent.
5. **Never log** secrets, tokens, or raw code/prompts.

## Build philosophy: walking skeleton

Instead of building the clean layered system bottom-up and only seeing results at the end,
we build a **thin vertical slice that works end-to-end first**, then improve each layer in
place. The read/observe half is already proven (see
[`docs/02-research-findings.md`](docs/02-research-findings.md)), so v0 can be genuinely
useful with almost no risk.

Rule of thumb: **ship the smallest thing that shows a real session on the phone**, then add
one capability at a time.

## v0 — the smallest working thing (read-only mirror)

```mermaid
flowchart LR
    TR[("transcripts/*.jsonl")] -->|tail, read-only| OB["observer (TS port of the Python PoCs)"]
    OB --> WS["tiny localhost WS + static web page"]
    WS -.->|your tunnel (Tailscale / SSH)| PH["📱 phone browser"]
```

**In scope for v0:**

- Port the two validated Python PoCs to TypeScript: session lister + blocker detector
  ([`research/list_sessions.py`](research/list_sessions.py),
  [`research/inspect_session.py`](research/inspect_session.py)).
- Normalize transcript events into the `SessionPart` shapes we already designed.
- A minimal localhost WebSocket + a single web page: **session list → open → live mirror →
  blocker shown**.
- Reach it from the phone over a tunnel you already run (no relay, no push yet).

**Deliberately skipped in v0 (added later):**

- Answering/steering a session (the actuator) — **view only** at first.
- The cross-environment relay, Web Push notifications, multi-instance leader election.
- A heavy redaction pipeline (v0 stays read-only and local, so egress risk is minimal;
  the redaction gate lands before anything is *sent* on behalf of the user).

v0 proves the whole height of the system with the least code, and every piece of it is on
the path to the real thing.

## The three screens

The phone client is three simple views (see the mockups in
[`mockups/index.html`](mockups/index.html)):

1. **Sessions** — a list grouped by instance/environment, each row showing status
   (active / blocked / idle), title, turn count, and age.
2. **Live mirror** — the running transcript rendered as typed parts: markdown, collapsible
   "thinking", tool-call cards, progress.
3. **Answer a blocker** — when a session is awaiting input, the full question + options
   render as a multiple-choice card (this is *view-only* in v0, *interactive* from v1).

## Iteration path (each step is shippable)

| Version | Adds | Maps to |
|---|---|---|
| **v0** | Read-only mirror: list → open → live → blocker shown. One tunnel. | M1 (observer), reframed as a slice |
| **v1** | Answer a blocker from the phone (own-loop resolve or best-effort steer). | M3 (actuator) |
| **v2** | Web Push on `awaiting-input`; installable PWA; resumable stream (`lastSeq`). | M2 |
| **v3** | Multi-instance: leader-per-environment + rendezvous relay, `instanceId` labels. | M3/M4 (see Q6) |
| **v4** | Hardening: mTLS/token auth, redaction gate, audit log, provenance end-to-end. | M4 |
| **v5** | Packaging: private `.vsix`, PWA deploy behind the tunnel. | M5 |

## Keeping it clean while moving fast

Going fast does **not** mean going messy. Two cheap rules keep v0 from becoming debt:

- **Pure core stays pure and tested.** The transcript→`SessionPart` normalizer and the
  blocker detector live as pure functions (`@cloakcode/protocol` shapes, tested without an
  extension host). The WS server + web page are a thin shell around them.
- **Respect the seams now.** Only `@cloakcode/extension` touches `vscode`; shared types come
  from `@cloakcode/protocol`; sessions are addressed as `(instanceId, sessionId)` even in v0
  (single instance for now) so multi-instance drops in later without repainting.

## Open choices to confirm

- **v0 client**: plain single HTML page first (fastest), or start directly in the React/Vite
  PWA? (Leaning: plain page for v0, migrate to the PWA at v2.)
- **Mockup direction**: dark, Copilot-Chat-like styling (what the mockups show) — thumbs
  up, or a different look?
- **Tunnel for v0**: assume Tailscale/SSH you already run, or should v0 document a specific
  one?
