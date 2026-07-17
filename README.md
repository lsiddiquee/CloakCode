# CloakCode

**Observe and drive GitHub Copilot from your phone — with zero code-sync to GitHub.**

[![CI](https://github.com/lsiddiquee/CloakCode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/lsiddiquee/CloakCode/actions/workflows/ci.yml)
[![Coverage ≥85%](https://img.shields.io/badge/coverage-%E2%89%A585%25-brightgreen)](https://github.com/lsiddiquee/CloakCode/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/badge/Marketplace-rexwel.cloakcode-0066b8?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=rexwel.cloakcode)
[![npm](https://img.shields.io/npm/v/@cloakcode/gateway?logo=npm&label=gateway)](https://www.npmjs.com/package/@cloakcode/gateway)
[![Docker Pulls](https://img.shields.io/docker/pulls/likhan/cloakcode-gateway?logo=docker&label=Docker)](https://hub.docker.com/r/likhan/cloakcode-gateway)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

CloakCode is a **local-to-remote bridge** that lets you observe and drive GitHub Copilot in your
local VS Code from a **phone** (a React PWA) or another machine. Your code never syncs to GitHub or
any third party — only prompts and minimal, redacted context ever cross the bridge, over a secure
tunnel to your own devices.

You keep VS Code's own Copilot chat — the interactive session you prefer, where you select code, point
at specific things, and attach files or screenshots — which has no remote of its own. CloakCode adds
one, and you switch fluidly between the desktop and your phone. When a long agent run **stalls on a
blocker** — a confirmation, a multiple-choice question, or a tool-call approval — you get pinged and
**answer it remotely** so the run keeps moving, instead of walking back hours later to find it waiting
on a one-word answer. It's the tool for the cases the web and CLI don't cover: your repo isn't on
GitHub, you want to bring your own models, or you just prefer the VS Code Copilot UI.

> **Status — M0 (dev experience + design).** The read/observe half (list sessions, live mirror,
> blocker detection) is proven, and the answer/steer/stop actuator is wired end-to-end. The remaining
> pre-release work is the **security core** (redaction/egress gate + bridge auth, M4). See
> [docs/05 — Roadmap](docs/05-roadmap-and-open-questions.md).

## Why it works

- **Models:** the stable `vscode.lm` API gives consented access to Copilot models.
- **Observation:** Copilot writes a **live, structured transcript to disk** per session — CloakCode
  tails it (works even for stock Copilot sessions).
- **Blocker detection:** an awaiting-input prompt shows up as an _unmatched interactive tool call_
  carrying the full question + options — enough to render richly on a phone.

The full empirical account (experiments and wrong turns included) is in
[docs/02 — Research findings](docs/02-research-findings.md).

## Install

- **Extension** (the desktop side): install **CloakCode** from the
  [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rexwel.cloakcode), or run
  `code --install-extension rexwel.cloakcode`. Each window serves its own phone PWA + bridge on
  loopback; run **CloakCode: Set Up Phone Tunnel** to get a phone-reachable URL.
- **Gateway** (optional hub for many windows / machines):
  [`@cloakcode/gateway`](packages/gateway/README.md) via `npx @cloakcode/gateway`, or the Docker
  image. Point each window at it with `"cloakcode.gatewayUrl": "ws://<host>:3543"`.

## Getting started (development)

Open in the dev container (VS Code: **Dev Containers: Reopen in Container**). It mounts the repo at
`/workspaces/cloakcode`, sets up a persisted cache volume, and installs Node + pnpm + tooling. Then:

```bash
pnpm install
pnpm build
pnpm -r test            # Vitest
pnpm -r test:coverage   # coverage gate (85% statements/lines/functions, 75% branches)
```

Try the research tools against your local Copilot sessions:

```bash
python3 research/list_sessions.py
python3 research/inspect_session.py <session-id-prefix>
```

## Repository layout

```text
.devcontainer/     Dev container: fixed /workspaces/cloakcode mount + persisted cache volume
docs/              Design & the full research record (read docs/README.md first)
research/          Validated Python PoCs (session lister + blocker detector)
packages/
  protocol/        SessionPart union + RPC schema (zod) — the contract
  agent/           (planned) pausable tool-calling + confirmation loop — stub until the actuator (M4)
  extension/       VS Code host: vscode.lm + transcript observer + localhost bridge
  web/             Phone-first React/Vite PWA client
  gateway/         Standalone hub: serves the PWA + a WebSocket hub for many windows
```

- Only `@cloakcode/extension` imports `vscode`; `protocol` and `agent` stay pure and unit-testable.
- Shared types come from `@cloakcode/protocol` — never duplicated across packages.

## Deploying & security

CloakCode binds `127.0.0.1` by **default** and reaches your phone through a **private tunnel** — so
nothing sits on your LAN. Running the gateway wider (LAN / container / WSL) is **trusted-network-only**
until the security core lands, so prefer **forward, don't widen**.

- **Deployment options** (embedded vs gateway, per-client addressing, dev-container / WSL forwarding,
  host-firewall rules): [docs/07 — Deployment](docs/07-deployment.md).
- **Security model** (zero code-sync, bounded egress, provenance tagging, threat model):
  [docs/04 — Security & compliance](docs/04-security-and-compliance.md).

## Documentation

- [Vision & requirements](docs/01-vision-and-requirements.md)
- [Research findings](docs/02-research-findings.md) — the empirical record (+ `02.x` topic files)
- [Architecture](docs/03-architecture.md)
- [Security & compliance](docs/04-security-and-compliance.md)
- [Roadmap & open questions](docs/05-roadmap-and-open-questions.md)
- [Field notes](docs/06-field-notes.md) — build/tooling gotchas & verified practices
- [Deployment](docs/07-deployment.md)

## Contributing

Work milestone by milestone and slice by slice, following the dependency direction
`protocol → agent/extension → web`. Write the failing test first (TDD), keep the pure packages highly
covered, and run the narrowest relevant check before continuing (`pnpm --filter @cloakcode/... test`,
`poetry run pytest research`). See [.github/copilot-instructions.md](.github/copilot-instructions.md)
for the full engineering discipline and the non-negotiable security rules.

## License

[MIT](LICENSE)
