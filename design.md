# CloakCode — Project overview & pragmatic design

> A short, approachable companion to the detailed design in [`docs/`](docs/README.md).
> This file is the **"simple first, improve over time"** view: what CloakCode is, and the
> smallest thing we can ship that actually works — then how we grow it without repainting.

## What it is (one paragraph)

CloakCode lets you **watch and drive GitHub Copilot from your phone** while your code **never
leaves your machine**. You keep using VS Code's own Copilot chat — select code to discuss, point
at things, attach files or screenshots — and switch fluidly between the desktop and your phone.
Only prompts and minimal, redacted context cross a private tunnel to _your_ infra — never GitHub.

## Why (the pain)

You kick off a long Copilot agent run, walk away, and it silently stalls on a confirmation
or a multiple-choice prompt. You don't notice for an hour. CloakCode surfaces that blocker
on your phone and (later) lets you answer it from wherever you are.

## The non-negotiables (unchanged, whatever we build)

These hold for **every** version, including v0:

1. **Zero code-sync to GitHub** — no push/upload/repo-sync path exists in the codebase.
2. **Bounded, self-owned egress** — no new code→model path; the mirror + actions cross only your bridge + tunnel, never GitHub/third party.
3. **Localhost-only bridge** — binds `127.0.0.1`; remote access is via _your_ tunnel only.
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
- A context-redaction pipeline (unnecessary by design — CloakCode mirrors Copilot's transcript and
  relays prompts into Copilot; it never assembles or uploads workspace context of its own).

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
   render as a multiple-choice card (this is _view-only_ in v0, _interactive_ from v1).

## Build plan: full-stack thin slices (see something every step)

We do **not** build one layer to completion before the next. Each **iteration cuts
vertically** through `protocol → extension → web` and ends in something you can open in a
browser. The slices get _thicker_, never _taller_.

**The trick that makes this fast:** reading transcripts is pure Node `fs` — it needs **no**
`vscode`. So the observer + bridge run as a plain Node **dev harness**
(`pnpm --filter @cloakcode/extension dev`) and the web app points at it. You get a working
browser view on day one; the VS Code extension host later just _wraps and launches the same
bridge_. No waiting for the extension host to see results.

| Iter    | Vertical slice (protocol → extension → web)                                                                                                                                | You can demo                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **I0**  | RPC envelope + `SessionSummary` (zod) · `TranscriptScanner` (port of `list_sessions.py`) + WS bridge serving `sessions.list` · React app rendering the session list        | Open the browser → **your real sessions appear**, instance-labelled, with status. |
| **I1**  | `SessionPart` subset (markdown/thinking/toolCall) + `session.subscribe` stream · transcript parser (port of `inspect_session.py`) + `tail -f` follow · session detail view | Click a session → **it streams live**.                                            |
| **I2**  | `confirmation` part · blocker signature (unmatched interactive tool) → `awaiting-input` · blocker card + "Needs input" badge                                               | A blocked session **shows the question + options** (read-only).                   |
| **I3**  | resumable stream (`lastSeq`) + connection config · real `activate()` hosts the bridge, `CloakCode: Restart Bridge` + status bar · settings/connect screen, installable PWA | Runs **inside VS Code**; installable PWA reachable over your tunnel.              |
| **I4+** | actuator (`session.respond`), tool-approval detection (Q4), Web Push, multi-instance relay, redaction + mTLS                                                               | Answer blockers remotely; hardened, multi-environment.                            |

Each iteration is a natural commit (or a few). The dependency direction still holds
(`protocol` first within a slice), but we never build a layer taller than the current slice
needs.

## Keeping it clean while moving fast

Going fast does **not** mean going messy. Two cheap rules keep the skeleton from becoming
debt:

- **Pure core stays pure and tested.** The transcript→`SessionPart` normalizer and the
  blocker detector are pure functions (typed by `@cloakcode/protocol`, tested without an
  extension host or a browser). The WS bridge and the React views are thin shells over them.
- **Respect the seams now.** Only `@cloakcode/extension` touches `vscode` (and not until
  I3); shared types come from `@cloakcode/protocol`; sessions are addressed as
  `(instanceId, sessionId)` from I0 (single instance for now) so multi-instance drops in
  later without repainting.

## Decisions locked in

- **Client**: the React/Vite **PWA** from I0 (per the approved mockups) — not a throwaway
  HTML page. Responsive phone→desktop, device-driven light/dark.
- **Look**: the dark/light Copilot-Chat styling in [`mockups/index.html`](mockups/index.html).
- **Dev loop**: Node dev harness for the bridge until I3; extension host wraps it after.

## Still to confirm

- **Tunnel**: assume a Tailscale/SSH tunnel you already run, or should the docs pin a
  specific one for I3?
