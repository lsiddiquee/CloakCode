# 01 — Vision & requirements

## Vision

**CloakCode** is a secure "bridge" that lets a developer observe and drive GitHub Copilot (and,
later, other remote tooling) **in their local VS Code**, controlled **remotely** from a
phone or another machine — while **your code never syncs to GitHub or a third party** (the session
mirror is deliberately viewed on _your_ devices over _your_ tunnel; CloakCode adds no new path that
sends your code anywhere Copilot doesn't already). You keep VS Code's own Copilot chat and can step
away without losing the thread: get pinged when a session needs input and answer it from your
phone.

Three core objectives:

1. **Control Copilot** — use Copilot's models and agent behaviour locally via supported APIs.
2. **Zero code-sync** — only prompts and minimal, redacted context ever traverse the bridge.
3. **Extensible remote controller** — groundwork for a command centre for remote operations from a local editor.

## Why it exists

The motivation is everyday developer flow, not a single deployment constraint:

- **Remote for the VS Code Copilot chat — which has none.** VS Code's Copilot chat is the
  interactive session many prefer (select code or text to discuss, point at specific things,
  attach files or screenshots from the repo or outside it), but it can't be reached remotely.
  CloakCode adds that remote, so you don't have to switch to a CLI or web mode that drops the
  interactive UI — and you can't always: Copilot CLI has no remote either.
- **Long runs shouldn't sit idle waiting for you.** A long agent workflow stalls on a
  confirmation, a multiple-choice question, or a tool-call approval; get pinged and answer it from
  your phone so it **keeps moving**, instead of waiting hours for you to come back to a one-word
  answer.
- **You answer, not autopilot.** Give the real answer to a question rather than letting an
  autopilot reply with a templated "user is away — choose the best option" default.
- **Fluid and two-way.** Move between your phone and the desktop chat at will — no one-way handoff
  to a CLI or mode you can't switch back from.
- **Covers the gaps.** Works when your repo isn't on GitHub and when you'd rather bring your own
  models — all while your code stays on your machine.

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
| R1  | Never sync/push code to GitHub                                    | Core privacy guarantee; enforced architecturally, not by policy.                                                                                                                                                            |
| R2  | Access Copilot models locally                                     | Via stable `vscode.lm`.                                                                                                                                                                                                       |
| R3  | List available sessions remotely                                  | Session picker for the phone. **Proven.**                                                                                                                                                                                     |
| R4  | View a session's full transcript remotely                         | Live mirror. **Proven (read).**                                                                                                                                                                                               |
| R5  | Rich rendering (expandable sections, tool cards, multiple-choice) | Own normalized `SessionPart` schema.                                                                                                                                                                                          |
| R6  | Detect when a session is blocked/awaiting input                   | **Proven** via unmatched interactive tool call.                                                                                                                                                                               |
| R7  | Answer the blocker remotely (incl. multiple-choice)               | The remaining build work (actuator).                                                                                                                                                                                          |
| R8  | Phone-first client                                                | React PWA + Web Push for blocker alerts.                                                                                                                                                                                      |
| R9  | Resilient on mobile networks                                      | Resumable event log (`lastSeq`).                                                                                                                                                                                              |
| R10 | Bounded, self-owned egress                                        | No new code→model path; the mirror + actions cross only your bridge + authenticated tunnel; never auto-harvest context. |
| R11 | Observability: structured logs, health metrics, per-session action logs | **Redacted by construction** (never logs code/prompts/secrets); `traceId`-correlated across extension/leader/hook/bridge/web; provenance-stamped. Per-session action logs (one JSONL per `sessionId`, like Copilot's transcripts) ship; the rest of the foundation is **pre-MVP** — see docs/03 "Observability". |

## Non-goals (for now)

- Publishing to the public Marketplace using **proposed** VS Code APIs (they can't be published).
- Mirroring a session inside VS Code's own chat UI with native widgets (a later, sideloaded-only layer).
- Replacing Copilot; CloakCode _drives_ it.
