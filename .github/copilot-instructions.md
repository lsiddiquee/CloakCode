# CloakCode — GitHub Copilot Instructions

> Authoritative short-form baseline for CloakCode. Detailed, living design lives in
> [`docs/`](../docs/README.md); read [`docs/02-research-findings.md`](../docs/02-research-findings.md)
> before touching anything that reads Copilot state — it is the empirical record.

## Repository overview

CloakCode is a **local-to-remote bridge** that lets a developer **observe and drive GitHub
Copilot from a phone (or another machine)** — with **zero code-sync to GitHub**. It targets
restricted enterprise tenants where pushing code to GitHub is prohibited. Only prompts and
minimal, redacted context ever cross the bridge.

Polyglot monorepo (pnpm TypeScript + a small Python research/observer toolkit). Current
status: **M0 — dev experience + design complete**; the read/observe half is proven, the
actuator (answering/steering remotely) is the next build. See
[`docs/05-roadmap-and-open-questions.md`](../docs/05-roadmap-and-open-questions.md).

## Non-negotiable rules (project-wide)

1. **Zero code-sync.** NEVER add code that pushes, uploads, or syncs the workspace to
   GitHub (`git push`, GitHub REST, repo/Codespaces upload). Compliance is architectural —
   there must be **no such path** in the codebase.
2. **Minimal, redacted egress.** Only prompts + minimal context (selection, symbol
   signatures, nearby diagnostics) leave the machine, and only after the redaction gate
   (secret/entropy scan + token budget). Never send whole files/repos.
3. **Localhost-only bridge.** The bridge binds `127.0.0.1`; remote access is exclusively via
   an explicit tunnel to _your_ infra — never GitHub.
4. **Prompt-injection provenance.** Every message carries a source tag
   (`genuine-local-user` / `remote-operator` / `cloakcode-staged`). Never treat reflected or
   staged text as trusted user intent. (This bit us in testing — a staged prompt round-tripped
   into a real turn.)
5. **Never log** secrets, tokens, or raw code/prompts. OWASP Top 10 awareness at every boundary.

## Architecture & package boundaries

```text
packages/
  protocol/   SessionPart union + RPC schema (zod). The contract.   — NO vscode import
  agent/      Pausable tool-calling + confirmation loop (pure TS).  — NO vscode import
  extension/  vscode.lm model port + transcript observer + bridge.  — the ONLY vscode importer
  web/        Phone-first React + Vite PWA client.                  — NO vscode / node-server import
research/     Python PoCs: session lister + transcript/blocker inspector (stdlib-only).
```

- **Only `@cloakcode/extension` imports `vscode`.** Keep `protocol` and `agent` pure and
  unit-testable without an extension host. Do not reach around this with re-exports.
- Shared types come from `@cloakcode/protocol` — do not duplicate the `SessionPart`/RPC
  shapes in other packages.
- The **observer** (read) and **actuator** (write) are separate concerns — see docs/03.

## Key domain facts (verified — do not re-derive)

- **Model access:** `vscode.lm.selectChatModels({ vendor: 'copilot' })` is the stable, consented
  path. There is **no** public API to read Copilot's own in-memory chat session.
- **On-disk transcripts (the observer's source):**
  `~/.vscode-server/data/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<id>.jsonl`
  — a live, event-sourced log. Event vocabulary: `session.start`, `user.message`,
  `assistant.turn_start/message/turn_end`, `tool.execution_start {toolCallId,toolName,arguments}`,
  `tool.execution_complete {toolCallId,success}`.
- **Blocker signature:** an interactive `tool.execution_start` (toolName matching
  `ask/question/confirm/input/elicit`) with **no matching `tool.execution_complete` for its
  `toolCallId`** = the session is awaiting input; the `arguments` carry the full question+options.
- **Session-list status** must use **file mtime liveness**, not the last event type.
- **Actuator is unsolved:** command injection can only queue/steer (non-deterministic); owning
  the loop is the deterministic path; the `@github/copilot` agent-host SDK is the lead.

## Conventions

### TypeScript

- Strict everywhere (extends `tsconfig.base.json`). Author everything in **ESM/TypeScript**;
  the `extension` is **bundled to CommonJS** for the VS Code host at packaging (esbuild, I3).
- Validate all cross-boundary/RPC payloads with **zod**.
- pnpm workspace. Build all: `pnpm -r build`. Lint: `pnpm -r lint`. Test: `pnpm -r test` (Vitest).

### Python (`research/`)

- **Poetry-managed** in-project `.venv`; run tools via `poetry run` (e.g. `poetry run ruff check`).
- Lint/format with **ruff** (line-length 100, py312); type-check with **mypy**.
- Keep the runtime research scripts **stdlib-only** so they run anywhere without the venv.

### Testing

- Vitest (TS), pytest (Python). **Never remove tests to make a change pass.** Cover success and
  failure paths.

## Engineering discipline (DRY · YAGNI · TDD)

- **TDD.** Write the failing test first, then the minimal code to pass, then refactor. The pure
  packages (`protocol`, `agent`) are deliberately testable **without** an extension host — keep
  them that way; do not introduce a `vscode` dependency to make something "easier" to test.
- **YAGNI.** Build the smallest thing that ships the current milestone (see docs/05). The
  **actuator is unsolved** — do **not** build speculative abstractions for steer / queue /
  own-loop until a slice actually needs one. No compatibility shims, aliases, or dual code paths
  for unreleased in-progress work.
- **DRY.** First instance stays local; a second is compared carefully; a third stable instance
  earns a shared abstraction **in the right layer** (usually `@cloakcode/protocol`). Never
  duplicate the `SessionPart` / RPC shapes across packages.
- **Small, reversible changes.** Fix root causes, not symptoms. Match the existing package
  boundaries and seams before inventing new ones.
- **No over-engineering.** Only make changes that are directly requested or clearly necessary.
  Don't add error handling for states that can't happen; validate at system boundaries (RPC,
  file parsing, model I/O) with zod.

## Development workflow

- Work **milestone by milestone** (M1→M5) and **slice by slice** within one: for the observer,
  settle the `SessionPart`/event contract first, then the JSONL parser, then the bridge, then the
  client — following the dependency direction `protocol → agent/extension → web`.
- **Test at the owning layer.** Schema/RPC tests live in `protocol`; loop/confirmation tests in
  `agent`; observer parsing in `extension`. Add cross-package tests only when the seam is at risk.
- After the first production edit, run the **narrowest** relevant test before continuing
  (e.g. `pnpm --filter @cloakcode/protocol test`, `poetry run pytest research`).
- Port the validated Python PoCs (`research/`) faithfully when building the TS observer — the
  event vocabulary and blocker signature are already proven; don't re-derive them.

## Definition of Done (every change)

1. **TDD + coverage.** Failing test written first; meaningful coverage of success **and** failure
   paths. Aim high on the pure packages (`protocol`/`agent`); `extension` stays a thin adapter.
   No coverage padding; never delete a test to go green.
2. **Green build.** `pnpm -r typecheck` + `pnpm -r lint` clean; `poetry run ruff check .` +
   `poetry run mypy research` clean.
3. **Boundaries respected.** Only `@cloakcode/extension` imports `vscode`; shared types come from
   `@cloakcode/protocol`; no lazy-import/`importlib`-style workarounds.
4. **Security gate.** No code-sync path introduced; nothing logs secrets/tokens/raw code; egress
   stays redacted and token-budgeted; message provenance tags preserved.
5. **Docs current.** Update the relevant `docs/` file in the **same change** that alters a design
   decision; extend the corrections log in `docs/02` when a finding changes.
6. **Conventional Commit** message (enforced by the `commit-msg` hook).

## Validation commands

```bash
pnpm install && pnpm build          # TS monorepo
pnpm -r test                        # Vitest
poetry install                      # Python dev env
poetry run ruff check . && poetry run mypy research
python3 research/list_sessions.py   # session lister PoC
pre-commit run --all-files          # hooks
```

## Context persistence (never lose work on tangents) — MANDATORY

We go on tangents constantly, and long sessions **will** exceed the context window; session memory
can also be flushed on container rebuild. Assume anything not written to the workspace is lost.
These rules are **not optional** and apply **no matter the reason for a switch or deep dive**.

- **Persist locally, not in memory.** Create `.local/scratch/` if missing and keep
  work-in-progress there — it is gitignored and survives rebuilds. Use it freely as a scratchpad.
- **One task-state file:** maintain `.local/scratch/task-state.md` with the current focus, a ledger
  of every in-flight issue (`pending` / `in-progress` / `blocked` / `done` + next step), open
  threads (deferred items), and key findings. Create it before the first edit of any non-trivial
  task.
- **Checkpoint before you act** — before switching focus or deep-diving, the moment you spot a new
  sub-issue, after completing meaningful steps or learning key facts, and before any long/branching
  operation. Re-read and reconcile it when resuming or whenever you're unsure you still hold earlier
  state.
- Durable **design** decisions still go in the relevant `docs/` file in the same change.

Rule of thumb: if it isn't in `.local/scratch/` or `docs/`, assume it will be forgotten.

## Pattern capture

When you find yourself re-explaining the same thing to the AI, fixing the same class of issue
repeatedly, or hitting a non-obvious gotcha, capture it — extend the relevant `docs/` file (or
the corrections log in docs/02) so the project learns.

## Docs map

- [Vision & requirements](../docs/01-vision-and-requirements.md)
- [Research findings](../docs/02-research-findings.md) — the empirical record + corrections log
- [Architecture](../docs/03-architecture.md)
- [Security & compliance](../docs/04-security-and-compliance.md)
- [Roadmap & open questions](../docs/05-roadmap-and-open-questions.md)
