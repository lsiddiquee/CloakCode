# Deployment & network exposure

How to run CloakCode so your phone can reach it **without** widening your attack surface. The
guiding rule: **forward, don't widen** — prefer loopback + a private tunnel over binding to the
network.

> See also: [Security & compliance](04-security-and-compliance.md) for the threat model, and the
> [gateway README](../packages/gateway/README.md) for the per-client address table and env vars.

## Two shapes

CloakCode runs in one of two shapes. **Embedded is the default and the safest.**

- **Embedded (default).** Each VS Code window runs its own bridge on `127.0.0.1` and serves the
  PWA; a **private** tunnel (VS Code port-forward or Dev Tunnel) exposes just that one port to your
  phone. Nothing listens on your LAN, and there's nothing extra to run.
- **Explicit gateway.** Run one hub — [`@cloakcode/gateway`](../packages/gateway/README.md) — that
  many windows connect to as **providers** (`cloakcode.gatewayUrl`), so a single phone URL sees
  every environment (host, WSL, dev containers). Set its listen port with `CLOAKCODE_GATEWAY_PORT`
  (default `3543`) and its bind address with `CLOAKCODE_GATEWAY_HOST`; how you bind it is where the
  security tradeoff lives.

## The core constraint

- **Default bind is `127.0.0.1` (loopback only)** — both the gateway and the extension's embedded
  bridge. Reachable only from the same host / network namespace.
- **No app-layer auth yet (until M4).** Any wider bind is **trusted-network-only**; the phone hop
  leans on the **private tunnel**'s own sign-in.
- **Loopback only reaches the same network namespace.** Cross-namespace hops (container↔host,
  WSL↔container, WSL↔Windows) do **not** see each other's `127.0.0.1` — that's the whole problem a
  tunnel or port-forward solves.

## Binding & network exposure

Letting another machine, WSL, or a container connect means binding wider than loopback. In order of
preference:

1. **Loopback + a private tunnel** (default). The phone comes in through the tunnel's own sign-in;
   nothing is on the LAN.
2. **Bind only the virtual interface** your clients use — e.g. Docker's `docker0` (`172.17.0.1`) or
   the WSL vEthernet — so containers/WSL reach it but the physical LAN NIC does not.
3. **Bind `0.0.0.0` behind a host firewall** that admits only those virtual subnets (below).

There is no single URL that works everywhere: a container uses `host.docker.internal`, WSL uses the
host's gateway IP (or `localhost` in mirrored mode), and the phone uses the tunnel. The
[gateway README](../packages/gateway/README.md) has the per-client address table.

## Forwarding across namespaces (dev container / WSL)

Prefer **VS Code's port forwarding** over binding `0.0.0.0`:

- A gateway or bridge running **inside the VS Code remote** (dev container or WSL) is surfaced at the
  **client's `localhost:3543`** by VS Code's forwarder — it connects to the remote's own loopback and
  tunnels it out, so you **never bind `0.0.0.0`**. Add it under `forwardPorts` in `devcontainer.json`
  (or let VS Code auto-detect it).
- **Direction matters.** `forwardPorts` surfaces a port the **remote** listens on *outward* to the
  client (**remote → local**). It does **not** pull a client/WSL-host port *into* the container.
- **`--network=host` caveats.** In `devcontainer.json` host networking is
  `"runArgs": ["--network=host"]` (there is no top-level `"network"` key). With **Docker Desktop**
  (typical on Windows/WSL2) it joins the **Docker Desktop VM's** namespace — not your WSL distro or
  Windows — so it does **not** merge with a WSL-hosted gateway's loopback. It only truly merges
  loopback for **native Docker Engine inside the WSL distro**. It also drops container network
  isolation, against the minimal-exposure posture — avoid it unless you know you need it.

## Locking down a wide bind (host firewall)

If you must bind `0.0.0.0`, restrict the gateway's port (`3543` by default, or whatever you set with
`CLOAKCODE_GATEWAY_PORT`) to the virtual subnets your clients use and keep it off the LAN. Adjust the
ranges to your actual Docker/WSL subnets (`ipconfig` / `ip addr`).

**Windows (PowerShell):**

```powershell
New-NetFirewallRule -DisplayName "CloakCode 3543 (virtual only)" `
  -Direction Inbound -Protocol TCP -LocalPort 3543 -Action Allow `
  -RemoteAddress 172.16.0.0/12,192.168.65.0/24 -Profile Any
```

Don't accept the generic "allow Node.js" popup — that opens the port on every profile.

**Linux (ufw):**

```bash
sudo ufw default deny incoming
sudo ufw allow from 172.16.0.0/12 to any port 3543 proto tcp   # Docker/WSL only
```

**Linux (nftables/iptables):**

```bash
sudo iptables -A INPUT -p tcp --dport 3543 -s 172.16.0.0/12 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3543 -j DROP
```

**macOS** — the built-in Application Firewall is per-*app*, not per-port, so use `pf` for subnet
scope. Sketch an anchor and reference it from `/etc/pf.conf`:

```text
# /etc/pf.anchors/cloakcode
block in proto tcp to any port 3543
pass  in proto tcp from 192.168.65.0/24 to any port 3543   # Docker Desktop VM subnet
```

On every OS the firewall is the *fallback* — prefer loopback + a private tunnel, or a
virtual-interface bind, and keep the phone on the tunnel rather than a LAN IP.

## Docker

The gateway ships as a container image that **bundles the `devtunnel` CLI**, so it can host the
phone tunnel itself (device-code sign-in at startup). See the
[gateway README — Docker](../packages/gateway/README.md#run-it--docker) for the run commands, the
`CLOAKCODE_TUNNEL` / `CLOAKCODE_TUNNEL_PROVIDER` variables, and the persist volume.

## Planned (post-MVP): authenticated, encrypted gateway↔bridge

Binding wide stops being a risk once the links carry their own credential: a shared-secret/token
handshake (laddering to TLS/mTLS) on both the **operator→gateway** and **gateway→provider (bridge)**
connections, checked at the `hello` handshake and the PWA's `/bridge` upgrade. Tracked in
[docs/05 — Roadmap (M4 + post-MVP)](05-roadmap-and-open-questions.md).
