# CloakCode

**Observe and drive GitHub Copilot from your phone — with zero code-sync to GitHub.**

CloakCode is a local-to-remote bridge for enterprise tenants where pushing code to GitHub
is prohibited. Your codebase stays entirely on the local machine; only prompts and minimal,
redacted context ever cross a secure tunnel. The main client is a **phone** (a React PWA),
so you can watch a long Copilot agent flow, get pinged when it **stalls on a blocker**, and
**answer that multiple-choice prompt remotely**.

> Status: **M0 — dev experience + design.** The read/observe half (list sessions, live
> mirror, blocker detection) is proven; the actuator (answering/steering remotely) is the
> next build. See [docs/](docs/README.md).

## Why it works

- **Models:** the stable `vscode.lm` API gives consented access to Copilot models.
- **Observation:** Copilot writes a **live, structured transcript to disk** per session —
  CloakCode tails it (works even for stock Copilot sessions).
- **Blocker detection:** an awaiting-input prompt shows up as an _unmatched interactive
  tool call_ carrying the full question + options — enough to render richly on a phone.

Full empirical account (including the experiments and the wrong turns) is in
[docs/02-research-findings.md](docs/02-research-findings.md).

## Repository layout

```text
.devcontainer/     Dev container: fixed /workspaces/cloakcode mount + persisted cache volume
docs/              Design & the full research record (read docs/README.md first)
research/          Validated Python PoCs (session lister + blocker detector)
packages/
  protocol/        SessionPart union + RPC schema (zod) — the contract
  agent/           Pausable tool-calling + confirmation loop (pure TS)
  extension/       VS Code host: vscode.lm + transcript observer + localhost bridge
  web/             Phone-first React/Vite PWA client
```

## Getting started

Open in the dev container (VS Code: **Dev Containers: Reopen in Container**). It mounts the
repo at `/workspaces/cloakcode`, sets up a persisted cache volume, and installs Node LTS +
pnpm + extension tooling. Then:

```bash
pnpm install
pnpm build
```

Try the research tools against your local Copilot sessions:

```bash
python3 research/list_sessions.py
python3 research/inspect_session.py <session-id-prefix>
```

## Documentation

- [Vision & requirements](docs/01-vision-and-requirements.md)
- [Research findings](docs/02-research-findings.md)
- [Architecture](docs/03-architecture.md)
- [Security & compliance](docs/04-security-and-compliance.md)
- [Roadmap & open questions](docs/05-roadmap-and-open-questions.md)
