# CloakCode

**Observe and drive GitHub Copilot from your phone — with zero code-sync to GitHub.**

CloakCode is a local-to-remote bridge that lets you observe and drive GitHub Copilot in your
local VS Code from a **phone** (a React PWA) or another machine. Your codebase stays entirely on
the local machine; only prompts and minimal, redacted context ever cross a secure tunnel.

You keep VS Code's own Copilot chat — the interactive session you prefer, where you select code or
text to discuss, point at specific things, and attach files or screenshots — which has no remote
of its own. CloakCode adds one, and you switch fluidly between the desktop and your phone. When a
long agent workflow **stalls on a blocker** — a confirmation, a multiple-choice question, or a
tool-call approval — you get pinged and **answer it remotely** so the run keeps moving, instead of
walking back hours later to find it waiting on a one-word answer (and without autopilot replying
with a templated "user is away" default). It's the tool for the cases the web and CLI don't cover:
your repo isn't on GitHub, you want to bring your own models, or you just prefer the VS Code
Copilot UI — and Copilot CLI has no remote.

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

## Deployment & security

CloakCode runs in one of two shapes. **Embedded is the default and the safest.**

- **Embedded (default).** Each VS Code window runs its own bridge on `127.0.0.1` and serves the
  PWA; a **private** tunnel (VS Code port-forward or Dev Tunnel) exposes just that one port to your
  phone. Nothing listens on your LAN, and there's nothing extra to run.
- **Explicit gateway.** Run one hub — [`@cloakcode/gateway`](packages/gateway/README.md) — that many
  windows connect to as **providers** (`cloakcode.gatewayUrl`), so a single phone URL sees every
  environment (host, WSL, dev containers). Set its listen port with `--port` (default `7900`) and its
  bind address with `--host`; how you bind it is where the security tradeoff lives.

### Binding & network exposure

The gateway/bridge binds `127.0.0.1` by **default** — reachable only from the same host. Letting
another machine, WSL, or a container connect means binding wider, and **there is no app-layer auth
yet** (see below), so treat a wide bind as _trusted-network-only_. In order of preference:

1. **Loopback + a private tunnel** (default). The phone comes in through the tunnel's own sign-in;
   nothing is on the LAN.
2. **Bind only the virtual interface** your clients use — e.g. Docker's `docker0` (`172.17.0.1`) or
   the WSL vEthernet — so containers/WSL reach it but the physical LAN NIC does not.
3. **Bind `0.0.0.0` behind a host firewall** that admits only those virtual subnets (below).

There is no single URL that works everywhere: a container uses `host.docker.internal`, WSL uses the
host's gateway IP (or `localhost` in mirrored mode), and the phone uses the tunnel. The
[gateway README](packages/gateway/README.md) has the per-client address table.

### Locking down a wide bind (host firewall)

If you must bind `0.0.0.0`, restrict the gateway's port (`7900` by default, or whatever you pass to
`--port`) to the virtual subnets your clients use and keep it off the LAN. Adjust the ranges to your
actual Docker/WSL subnets (`ipconfig` / `ip addr`).

**Windows (PowerShell):**

```powershell
New-NetFirewallRule -DisplayName "CloakCode 7900 (virtual only)" `
  -Direction Inbound -Protocol TCP -LocalPort 7900 -Action Allow `
  -RemoteAddress 172.16.0.0/12,192.168.65.0/24 -Profile Any
```

Don't accept the generic "allow Node.js" popup — that opens the port on every profile.

**Linux (ufw):**

```bash
sudo ufw default deny incoming
sudo ufw allow from 172.16.0.0/12 to any port 7900 proto tcp   # Docker/WSL only
```

**Linux (nftables/iptables):**

```bash
sudo iptables -A INPUT -p tcp --dport 7900 -s 172.16.0.0/12 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 7900 -j DROP
```

**macOS** — the built-in Application Firewall is per-_app_, not per-port, so use `pf` for subnet
scope. Sketch an anchor and reference it from `/etc/pf.conf`:

```text
# /etc/pf.anchors/cloakcode
block in proto tcp to any port 7900
pass  in proto tcp from 192.168.65.0/24 to any port 7900   # Docker Desktop VM subnet
```

On every OS the firewall is the _fallback_ — prefer loopback + a private tunnel, or a
virtual-interface bind, and keep the phone on the tunnel rather than a LAN IP.

### Security posture (today)

- **Zero code-sync — structural.** No `git push` / GitHub-API / repo-upload path exists in the
  codebase; only prompts + redacted context ever egress.
- **Localhost by default + a private tunnel.** The tunnel is never `--allow-anonymous`; its own
  sign-in is the compensating control while app-auth is deferred.
- **Redaction gate & provenance.** Egress is secret-scanned and token-budgeted; every message is
  provenance-tagged so staged/reflected text is never treated as user intent.
- **No gateway/bridge app-auth yet.** Anyone who can _reach_ the port can drive it — hence the
  loopback default, the private tunnel, and the firewall scoping above.

Full model: [docs/04 — Security & compliance](docs/04-security-and-compliance.md).

### Planned (post-MVP): authenticated, encrypted gateway↔bridge

Binding wide stops being a risk once the links carry their own credential: a shared-secret/token
handshake (laddering to TLS/mTLS) on both the **operator→gateway** and **gateway→provider (bridge)**
connections, checked at the `hello` handshake and the PWA's `/bridge` upgrade. Tracked in
[docs/05 — Roadmap (M4 + post-MVP)](docs/05-roadmap-and-open-questions.md).

## Documentation

- [Vision & requirements](docs/01-vision-and-requirements.md)
- [Research findings](docs/02-research-findings.md)
- [Architecture](docs/03-architecture.md)
- [Security & compliance](docs/04-security-and-compliance.md)
- [Roadmap & open questions](docs/05-roadmap-and-open-questions.md)
