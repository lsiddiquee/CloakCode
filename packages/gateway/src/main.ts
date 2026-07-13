#!/usr/bin/env node
/*
 * Standalone CloakCode gateway runner — run this OUTSIDE VS Code (host binary or
 * Docker). It serves the PWA + the WebSocket hub, and (since it is the public-
 * facing server) it OWNS the Dev Tunnel that exposes itself to a phone.
 * Extensions connect in as providers (docs/03 "Explicit gateway").
 *
 * Env:
 *   CLOAKCODE_GATEWAY_HOST   bind address (default 127.0.0.1; use 0.0.0.0 in Docker)
 *   CLOAKCODE_GATEWAY_PORT   port (default 7900)
 *   CLOAKCODE_WEB_DIR        directory of the built PWA to serve (optional)
 *   CLOAKCODE_TUNNEL         `devtunnel` to auto-host a private tunnel (optional)
 *   CLOAKCODE_INSTANCE_ID    tunnel-name seed (default "gateway")
 *
 * Security: no app-layer auth yet (bridge auth is deferred) — keep it on
 * loopback + a PRIVATE tunnel; do not expose 0.0.0.0 on an untrusted network.
 */
import { startGateway } from "./gateway.js";
import { devTunnelName, startDevTunnel } from "./tunnel.js";

const host = process.env["CLOAKCODE_GATEWAY_HOST"] ?? "127.0.0.1";
const port = Number(process.env["CLOAKCODE_GATEWAY_PORT"]) || 7900;
const serveDir = process.env["CLOAKCODE_WEB_DIR"];

const gateway = await startGateway({
  host,
  port,
  ...(serveDir ? { serveDir } : {}),
});
console.log(
  `[cloakcode-gateway] listening on ws://${host}:${gateway.port}` +
    (serveDir ? ` (+ PWA from ${serveDir})` : " (WebSocket only)"),
);

if (process.env["CLOAKCODE_TUNNEL"] === "devtunnel") {
  const seed = process.env["CLOAKCODE_INSTANCE_ID"] || "gateway";
  try {
    const tunnel = await startDevTunnel(gateway.port, devTunnelName(seed), (l) =>
      console.log(`[devtunnel] ${l}`),
    );
    console.log(`[cloakcode-gateway] phone URL: ${tunnel.url}`);
  } catch (err) {
    console.error(
      `[cloakcode-gateway] tunnel failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

const shutdown = (): void => {
  void gateway.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
