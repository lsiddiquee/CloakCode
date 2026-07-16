# CloakCode documentation

CloakCode is a local-to-remote bridge that lets you **observe and drive GitHub Copilot
from a phone or another machine — with zero code-sync to GitHub**. In restricted
enterprise tenants where pushing code to GitHub is prohibited, CloakCode keeps the entire
codebase local and sends only prompts and minimal, redacted context across a secure
tunnel.

> This documentation set was authored to preserve a full investigation (2026-07-08)
> before moving development into the dev container. It captures not just conclusions but
> the experiments, corrections, and dead-ends — so nothing is re-litigated.

## Read in order

1. [01 — Vision & requirements](01-vision-and-requirements.md) — what we're building and why, and how the requirements evolved.
2. [02 — Research findings](02-research-findings.md) — the empirical heart: API surface, a one-line **findings ledger**, and the capability matrix. Detail (mechanics + wrong turns) lives in the topic files [02.1 messaging](02.1-messaging.md), [02.2 turn tracking](02.2-turn-tracking.md), [02.3 tool call handling](02.3-tool-call-handling.md), [02.4 storage & logs](02.4-storage-and-logs.md), [02.5 session state](02.5-session-state.md).
3. [03 — Architecture](03-architecture.md) — components, the `SessionPart` schema, observer + actuator split, data flows, tech stack.
4. [04 — Security & compliance](04-security-and-compliance.md) — how the zero-code-sync guarantee is enforced, plus the prompt-injection provenance lesson.
5. [05 — Roadmap & open questions](05-roadmap-and-open-questions.md) — what's proven, what's next, what's still unknown.
6. [06 — Field notes](06-field-notes.md) — preserved raw working memory (the compressed field log behind 02).

## Fast orientation

| | |
|---|---|
| **Problem** | Leverage Copilot remotely without ever syncing code to GitHub. |
| **Main client** | Phone (React PWA); sometimes another desktop/laptop. |
| **Core pain solved** | A long agent flow stalls on an unexpected blocker/confirmation and you don't notice — CloakCode surfaces it on your phone and lets you answer. |
| **Key enabler (read)** | Copilot writes a **live, structured transcript to disk** per session (`transcripts/*.jsonl`) — observable server-side. |
| **Key enabler (models)** | The stable `vscode.lm` API gives consented access to Copilot models. |
| **Proven capabilities** | List sessions · view transcript · track blockers · surface multiple-choice richly. |
| **Remaining build work** | The **actuator** — answering/steering a session remotely. |

See also the runnable proofs in [../research/](../research/README.md).
