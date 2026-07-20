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
- **Authenticated, but not yet encrypted.** An exposed hub is gated by **operator TOTP** (phone) + a
  **provider token** (extension) — F2a — so it is not open. But the extension↔gateway hop is still
  plain `ws://`, so any wider bind stays **trusted-network-only** until transport encryption lands
  (see [Transport confidentiality](04-security-and-compliance.md#tunnel--transport)). The phone hop is
  already TLS via the **private tunnel**.
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
phone tunnel itself. Sign-in is **device-code, so it runs headless — no `docker run -it`**: the code
prints to `docker logs`, the login blocks until you finish it in any browser, and the container exits
if the code expires (just restart). It defaults to a **GitHub** login
(`CLOAKCODE_TUNNEL_PROVIDER=microsoft` for a Microsoft account). See the
[gateway README — Docker](../packages/gateway/README.md#run-it--docker) for the run commands, the
`CLOAKCODE_TUNNEL` / `CLOAKCODE_TUNNEL_PROVIDER` variables, and the persist volume.

## Authenticated links (shipped) + encrypted transport (the remaining gap)

**Authentication has shipped.** Both hops now carry their own credential — **operator TOTP** on the
phone→gateway hop and a **TOTP-issued provider token** (static `CLOAKCODE_GATEWAY_TOKEN` as a demoted
escape hatch) on the extension→gateway hop, checked at the `hello` handshake (see
[docs/04 — Authentication](04-security-and-compliance.md#authentication-two-separate-boundaries)).
So a wide bind is **authenticated**, not open.

**Transport confidentiality is the one gap left.** Authentication proves *who* connects; it does not
*encrypt* the link. The posture is leg-by-leg:

- **Phone → gateway:** already TLS when you use the private **Dev Tunnel** — its ingress terminates
  HTTPS/WSS (Microsoft cert, HSTS, TLS 1.2+) and forwards to the gateway over loopback. Nothing
  crosses the wire in clear.
- **Extension → gateway over a wide `0.0.0.0` bind:** still plain `ws://`. The provider token (sent in
  the hello, and on every reconnect) and the mirrored transcript are in cleartext — sniffable and the
  token is replayable. This is why a wide bind is **trusted-network-only** today.

**Closing it (low-friction first).** In rough order of end-user friction:

1. **Encrypted overlay / reverse proxy (recommended):** run the gateway on loopback and let
   **Tailscale / WireGuard / an SSH forward**, or a **reverse proxy** (Caddy/nginx/Traefik) own the
   encryption. The proxy/overlay already solves certs, renewal and identity; CloakCode stays bound to
   `127.0.0.1`. Best fit when you already have one of these.
2. **Optional native gateway TLS (product-owned):** the standalone gateway serves `wss://` on a
   **dedicated listener** (its loopback HTTP listener still backs the tunnelled PWA — coexistence
   model B), from an **auto-generated self-signed cert** (default) or an operator-supplied cert/key.
   The extension keeps full validation (`rejectUnauthorized` stays **true**) and pins the cert's
   **SHA-256 fingerprint**, provisioned **out-of-band via the authenticated PWA** — a “Connect an
   extension” action behind the Dev Tunnel sign-in + operator TOTP hands you the URL + fingerprint to
   paste in (console/QR fallback with no tunnel; BYO-cert operators point at a CA/cert file). Never
   blind trust-on-first-use, never `rejectUnauthorized:false`. For a direct LAN/container link with no
   proxy.
3. **Dev Tunnel for a remote extension (documented, friction caveat):** an extension *can* ride the
   gateway's private Dev Tunnel, but not by only changing `cloakcode.gatewayUrl` — the Node client
   can't complete the tunnel's browser sign-in (an unauthenticated `/bridge` request returns HTTP
   `302`, observed 2026-07-18). It needs a `devtunnel connect`-scoped token, and those tokens are
   **short-lived (~24 h)**, so every extension would need re-tokening daily — high friction, so this
   stays a documented option, not the default.

Finalized, build-ready design in
[docs/05 — encrypted-link hardening](05-roadmap-and-open-questions.md) and
[docs/04 — Transport confidentiality](04-security-and-compliance.md#tunnel--transport).
