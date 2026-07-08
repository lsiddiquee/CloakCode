# 03 — Architecture

## Guiding split: Observer + Actuator

The research produced one clean architectural insight: the problem divides into two
halves that are solved differently.

- **Observer (read) — proven, universal.** Tail the on-disk transcripts, normalize to a
  rich schema, stream to the phone. Detects blockers. Works for **stock** Copilot sessions.
  No proposed API, no owning the loop.
- **Actuator (write) — the build focus.** Answering/steering a session. Deterministic path
  = CloakCode **owns the agent loop**; lighter path = queue/steer injection (unproven for
  precise control).

## Components

```mermaid
flowchart TB
    subgraph Local["🖥️ Local machine (trust boundary — code never leaves)"]
        subgraph VS["VS Code + @cloakcode/extension"]
            OBS["Observer\n(tails transcripts/*.jsonl)"]
            LM["Model port → vscode.lm (Copilot)"]
            AG["@cloakcode/agent\n(owned pausable loop)"]
            ACT["Actuator\n(own-loop resolve / queue-steer)"]
            BR["Bridge server\n127.0.0.1:7801 (WS, @cloakcode/protocol)"]
        end
        TR[("GitHub.copilot-chat/\ntranscripts/*.jsonl")]
        OBS -->|read-only| TR
        AG --> LM
        OBS --> BR
        AG --> BR
        ACT --> BR
    end
    BR -.->|secure tunnel (mTLS/WireGuard) — prompts + redacted context only| PH["📱 @cloakcode/web (PWA)\nsession list · live mirror · answer blockers"]
    LM -.->|consented| COP[("Copilot models")]
```

| Package                | Role                                                         | Depends on `vscode`? |
| ---------------------- | ------------------------------------------------------------ | -------------------- |
| `@cloakcode/protocol`  | `SessionPart` union + RPC schema (zod). The contract.        | No                   |
| `@cloakcode/agent`     | Pausable tool-calling + confirmation loop (pure).            | No                   |
| `@cloakcode/extension` | Model port (`vscode.lm`), observer, bridge server, actuator. | **Yes** (only here)  |
| `@cloakcode/web`       | Phone-first React/Vite PWA client.                           | No                   |

Keeping `vscode` isolated to one package makes the protocol and agent unit-testable
without an extension host.

## The core abstraction: `SessionPart`

A discriminated union both the VS Code side and the phone renderer understand — mirroring
how Copilot Chat renders typed parts:

```ts
type SessionPart =
  | {
      kind: "markdown";
      id: string;
      text: string;
      collapsible?: boolean;
      title?: string;
    }
  | { kind: "thinking"; id: string; text: string; collapsed: true }
  | {
      kind: "toolCall";
      id: string;
      name: string;
      input: unknown;
      output?: unknown;
      status: "running" | "done" | "error";
    }
  | {
      kind: "confirmation";
      id: string;
      prompt: string;
      options: Choice[];
      allowFreeform?: boolean;
    } // the blocker
  | { kind: "progress"; id: string; label: string }
  | {
      kind: "diff";
      id: string;
      path: string;
      hunks: Hunk[];
      insertions: number;
      deletions: number;
    }
  | { kind: "fileTree"; id: string; root: FileNode }
  | { kind: "codeblock"; id: string; lang: string; code: string }
  | { kind: "error"; id: string; message: string };

type Choice = {
  id: string;
  label: string;
  detail?: string;
  recommended?: boolean;
};
```

Streamed as a **sequence-numbered event log** (`append(part)`, `patch(id, delta)`,
`updateStatus(id, status)`) so a reconnecting phone resumes from `lastSeq`.

### Mapping the on-disk observer onto `SessionPart`

| Transcript event          | Becomes                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `user.message`            | (turn boundary)                                                                  |
| `assistant.message`       | `markdown` (+ `thinking` from `reasoningText`)                                   |
| `tool.execution_start`    | `toolCall` status `running` — **or `confirmation`** if `toolName` is interactive |
| `tool.execution_complete` | `toolCall` → `done`/`error` (or resolves the `confirmation`)                     |

## Session state machine

`idle → running → awaiting-input → running → … → completed | failed`

`awaiting-input` = the blocker state, detected via the unmatched interactive
`tool.execution_start` signature (see research §3.2).

## Data flows

### List sessions

```text
phone → bridge {op: 'sessions.list'} → extension enumerates transcripts/*.jsonl (+ mtime liveness) → [ {id, title, turns, status, age} ]
```

### Live mirror + blocker

```mermaid
sequenceDiagram
    participant Ph as 📱 PWA
    participant BR as Bridge (WS)
    participant OB as Observer
    participant TR as transcripts/*.jsonl
    OB->>TR: tail -f
    TR-->>OB: tool.execution_start (interactive, unmatched)
    OB->>OB: state = awaiting-input; build confirmation SessionPart from arguments
    OB-->>BR: append(confirmation) + status
    BR-->>Ph: Web Push + render multiple-choice
    Ph->>BR: {op: 'session.respond', partId, choiceId}
    BR->>+Actuator: deliver answer (own-loop promise / steer-inject)
    Actuator-->>-TR: (session continues)
```

### Answer a blocker (deterministic, owned loop)

The `@cloakcode/agent` loop `await`s a promise at the confirmation point; the promise
resolves when **either** VS Code **or** the phone answers — so you can pick it up on
whichever device is nearest.

## Multi-instance topology & discovery

The extension runs in **every** VS Code instance, and a developer typically has many open
at once — across dev containers, WSL distros, and the host. `127.0.0.1` is **not** shared
across those environments, so "just bind a fixed port" both false-collides and fails to
cross namespaces. The problem is not sharing data (each observer is already whole-
environment) — it is **enumerating and routing to N independent bridges**, each labeled by
which machine/container it is.

### The grouping rule: one environment = one transcript store

All repos/windows that share **one `~/.vscode-server/data/User/`** (remote) or **one
native User dir** (local) form a single environment. This is the unit of observation:

| Scenario                                   | Same transcript store?              | Consequence                                                             |
| ------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------- |
| N repos/windows in the **same WSL distro** | **Yes** — one `~/.vscode-server`    | One observer already sees **all** repos; N activations would duplicate. |
| N repos/windows on the **host** (native)   | **Yes** — one local User dir        | Same: one observer covers all host repos.                               |
| Two **different** WSL distros              | **No** — one server dir each        | Two environments.                                                       |
| WSL **and** host together                  | **No** — server dir ≠ host User dir | Two environments.                                                       |
| Two **dev containers**                     | **No** — one server dir each        | Two environments.                                                       |

Because the observer enumerates `workspaceStorage/*/…/transcripts/*.jsonl`, it is inherently
whole-environment: **one leader per environment covers every repo in it**.

### Two-tier design

**Within an environment — single-instance leader election.** Multiple windows each activate
the extension and would each enumerate the _same_ store → duplicate sessions. Elect one
leader via a **lock file in that environment's own `globalStorage`** (scoped to the
container/distro/host — it never merges distinct environments the way `localhost` does).
Non-leaders defer and hand off their workspace info; on leader death another takes over.

**Across environments — outbound registration to a rendezvous relay.** The phone cannot
_discover_ bridges across isolated namespaces, so each environment's leader dials **out**
to CloakCode's relay (part of _your_ infra, via the existing tunnel — never GitHub) and
registers. The phone talks only to the relay, which serves the **union**. Outbound egress
works from every environment even when inbound does not, so this is uniform across dev
containers, WSL, and host, and there is **no fixed-port collision** (connections are
outbound; any optional local `127.0.0.1` bridge uses an **ephemeral** port, never a
hardcoded one as the discovery/collision mechanism).

```mermaid
flowchart LR
    subgraph C1["dev container A"]
        E1["extension (leader)"]
    end
    subgraph W["WSL: Ubuntu (repos x, y, z)"]
        E3["extension (leader) — sees all repos"]
    end
    subgraph H["host"]
        E4["extension (leader)"]
    end
    E1 -->|register + stream| R
    E3 -->|register + stream| R
    E4 -->|register + stream| R
    R["Rendezvous relay\n(your infra, via tunnel)"] <-->|one connection| P["📱 PWA"]
```

### Instance identity (touches the M1 protocol)

Every registration and every `sessions.list` row is namespaced by a stable **instance id**,
composed from what VS Code already exposes: `vscode.env.machineId`,
`vscode.env.remoteName` (`dev-container` / `wsl` / `ssh-remote` / local), the
hostname/distro/container name, and a persisted UUID in that environment's `globalStorage`.
A session is addressed as **`(instanceId, workspaceHash, sessionId)`**, and the phone shows
a labeled list — e.g. `myrepo (dev-container) · fix-auth`, `Ubuntu (wsl) · refactor`.

The relay/tunnel itself is **M4** (YAGNI — not built early), but two cheap decisions land
in **M1** so nothing is repainted later: (1) `sessions.list` returns instance-scoped rows
and `session.subscribe` keys on `(instanceId, sessionId)`; (2) the bridge port is
configurable with an **ephemeral fallback** (`port: 0`), a fixed port being only an optional
same-host convenience.

### Endpoint modes (pluggable behind one protocol)

"Where the phone-facing endpoint lives" is a swappable choice; an instance only ever
"registers and streams," so it does not care which of these it is talking to:

| Mode                           | Endpoint lives in                              | Use                                                       |
| ------------------------------ | ---------------------------------------------- | --------------------------------------------------------- |
| **Embedded**                   | the extension host itself                      | one environment at a time; simplest, zero infra.          |
| **Self-elected local gateway** | one window per environment (owns a local port) | many windows/repos on one host or one WSL distro.         |
| **Remote gateway / mesh**      | your infra, or a WireGuard/Tailscale mesh      | many _different_ environments unified for the phone (M4). |

Because they share the same protocol + `instanceId` seam, the mode can change later without
touching the observer or the client.

### Lifetime & restart (decided)

**Decision: the bridge must NOT outlive the editor.** No detached helper, no daemon, no OS
service — an idea deliberately rejected so nothing lingers holding a port or tunnel after
you close VS Code. The lifetime contract is simply:

> **Remote access exists while ≥1 window is open on that environment, and ends cleanly when
> the last one closes.**

- **A non-leader window closes** → nothing happens (it was a follower).
- **The leader closes while others remain** → the port frees and the remaining windows
  re-elect (the same "whoever grabs the port next is host" loop); followers and the phone
  reconnect after a ~1–2 s blip.
- **The last window closes** → `deactivate()` actively disposes the WS server, releases the
  port, deregisters from any gateway, and drops the tunnel. The phone flips to
  **"environment offline"** immediately rather than hanging on a dead socket.

**Restart (the LSP-restart equivalent).** A `CloakCode: Restart Bridge` palette command (plus
an optional status-bar affordance) rebuilds the observer + server in place; a
`Restart & Re-elect Gateway` variant makes the current leader step down so the next instance
takes over; **Reload Window** is the nuclear fallback. Restarts are seamless because the phone
reconnects and **replays from `lastSeq`** — a restart looks like a brief blip, not a lost
session.

## Tech stack

| Layer     | Choice                                                 | Why                                               |
| --------- | ------------------------------------------------------ | ------------------------------------------------- |
| Extension | TypeScript + `@types/vscode`, esbuild                  | Only supported language; `vscode.lm` first-class. |
| Bridge    | Node + WebSocket (`ws`/Fastify), `127.0.0.1`           | Low overhead; localhost-only.                     |
| Protocol  | TypeScript + `zod`                                     | Boundary validation; shared types.                |
| Client    | React + Vite PWA, Shiki, `react-markdown`              | Phone-first, installable, rich rendering.         |
| Push      | Service worker + Web Push API                          | Blocker alerts to a backgrounded phone.           |
| Tunnel    | WireGuard / SSH reverse forward / mTLS to _your_ infra | Never GitHub.                                     |
| Packaging | `@vscode/vsce` (private/internal)                      | Enterprise-restricted distribution.               |

## Client ordering

1. **PWA mirror + session list first** (rides the proven observer — immediate value).
2. **Actuator** (answer/steer) second — the real remaining engineering.
