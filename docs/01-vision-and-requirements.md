# 01 — Vision & requirements

## Vision

**CloakCode** is a secure "bridge" that lets a developer leverage GitHub Copilot (and,
later, other remote tooling) from a **local editor**, controlled **remotely** from a
phone or another machine — while guaranteeing that **the codebase never leaves the local
machine**. It is built for enterprise tenants where syncing/pushing code to GitHub
(remote repos, Codespaces, standard remote-dev extensions) is prohibited.

Three core objectives:

1. **Control Copilot** — use Copilot's models and agent behaviour locally via supported APIs.
2. **Zero code-sync** — only prompts and minimal, redacted context ever traverse the bridge.
3. **Extensible remote controller** — groundwork for a command centre for remote operations from a local editor.

## How the requirements evolved (important context)

The scope sharpened over the investigation. Recording the progression so the "why" behind
the design is preserved:

1. **Start: remote control.** "Can we hook a chat session, create one, list them, send a
   message — then do it remotely?"
2. **Pivot: mirror, not just control.** The real pain isn't sending prompts — it's that a
   **long agent flow stalls on an unexpected blocker/confirmation** and waits silently.
   The user must be able to **see the whole session** and **answer the blocker** remotely.
3. **Fidelity bar: rich like Copilot Chat.** Rendering must match Copilot Chat — expandable
   sections, tool cards, and especially **multiple-choice confirmation prompts** — not a
   plain text stream.
4. **Client: phone-first.** The main client is a **phone**; sometimes another desktop/laptop.
   A terminal client is explicitly rejected.

## Concrete requirements

| #   | Requirement                                                       | Notes                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Never sync/push code to GitHub                                    | Compliance-critical; architectural, not policy-based.                                                                                                                                                                         |
| R2  | Access Copilot models locally                                     | Via stable `vscode.lm`.                                                                                                                                                                                                       |
| R3  | List available sessions remotely                                  | Session picker for the phone. **Proven.**                                                                                                                                                                                     |
| R4  | View a session's full transcript remotely                         | Live mirror. **Proven (read).**                                                                                                                                                                                               |
| R5  | Rich rendering (expandable sections, tool cards, multiple-choice) | Own normalized `SessionPart` schema.                                                                                                                                                                                          |
| R6  | Detect when a session is blocked/awaiting input                   | **Proven** via unmatched interactive tool call.                                                                                                                                                                               |
| R7  | Answer the blocker remotely (incl. multiple-choice)               | The remaining build work (actuator).                                                                                                                                                                                          |
| R8  | Phone-first client                                                | React PWA + Web Push for blocker alerts.                                                                                                                                                                                      |
| R9  | Resilient on mobile networks                                      | Resumable event log (`lastSeq`).                                                                                                                                                                                              |
| R10 | Minimal context egress + redaction                                | Send only selection/signatures, scrubbed for secrets.                                                                                                                                                                         |
| R11 | Observability: structured logs, health metrics, audit trail       | **Redacted by construction** (never logs code/prompts/secrets); `traceId`-correlated across extension/leader/hook/bridge/web; provenance-stamped. Foundation is **pre-MVP**; currently missing — see docs/03 "Observability". |

## Non-goals (for now)

- Publishing to the public Marketplace using **proposed** VS Code APIs (they can't be published).
- Mirroring a session inside VS Code's own chat UI with native widgets (a later, sideloaded-only layer).
- Replacing Copilot; CloakCode _drives_ it.
