#!/usr/bin/env node
/*
 * Standalone CloakCode gateway runner — run this OUTSIDE VS Code (host binary or
 * Docker). It serves the PWA + the WebSocket hub, and (since it is the public-
 * facing server) it OWNS the Dev Tunnel that exposes itself to a phone.
 * Extensions connect in as providers (docs/03 "Explicit gateway").
 *
 * Env:
 *   CLOAKCODE_GATEWAY_HOST   bind address (default 127.0.0.1; use 0.0.0.0 in Docker)
 *   CLOAKCODE_GATEWAY_PORT   port: unset → 3543 (ephemeral if taken); 0 → ephemeral; N → lock N
 *   CLOAKCODE_WEB_DIR        directory of the built PWA to serve (optional)
 *   CLOAKCODE_TUNNEL         `devtunnel` to auto-host a private tunnel (optional)
 *   CLOAKCODE_INSTANCE_ID    tunnel-name seed (default "gateway")
 *   CLOAKCODE_LOG_LEVEL      trace|debug|info|warn|error (default info; CLOAKCODE_VERBOSE=1 ⇒ debug)
 *   CLOAKCODE_GATEWAY_LOG_FILE  on-disk action log (JSONL); unset → ./cloakcode-gateway.jsonl; "" → off
 *   CLOAKCODE_GATEWAY_TOKEN  provider↔gateway shared secret (extensions present it in their hello); unset → off
 *
 * Security: no app-layer auth yet (bridge auth is deferred) — keep it on
 * loopback + a PRIVATE tunnel; do not expose 0.0.0.0 on an untrusted network.
 */
import { networkInterfaces } from "node:os";
import { connectionUrls } from "./connect-urls.js";
import { createConsoleLogger, parseLogLevel } from "./console-logger.js";
import { startGateway } from "./gateway.js";
import { resolvePortPlan } from "./listen.js";
import { devTunnelName, startDevTunnel } from "./tunnel.js";

const host = process.env["CLOAKCODE_GATEWAY_HOST"] ?? "127.0.0.1";
// unset → 3543 then ephemeral; 0 → ephemeral; N → lock N (same rule as embedded).
const portPlan = resolvePortPlan(process.env["CLOAKCODE_GATEWAY_PORT"]);
const serveDir = process.env["CLOAKCODE_WEB_DIR"];
const verbose =
  process.env["CLOAKCODE_VERBOSE"] === "1" ||
  process.env["CLOAKCODE_VERBOSE"] === "true";
// Structured, local-only logger (docs/03). CLOAKCODE_VERBOSE=1 is shorthand for debug.
// Running standalone (outside VS Code) it also persists its action log to a JSONL file
// (the gateway relays remote-operator actions), overridable/disable-able via env.
const logFile =
  process.env["CLOAKCODE_GATEWAY_LOG_FILE"] ?? "cloakcode-gateway.jsonl";
// Shared secret for the provider↔gateway link: extensions present it in their
// hello to register. Machine-to-machine only (operator/phone auth is separate,
// docs/05 Q9). Unset/empty → auth OFF (loopback dev).
const token = process.env["CLOAKCODE_GATEWAY_TOKEN"] || undefined;
const logger = createConsoleLogger({
  level:
    parseLogLevel(process.env["CLOAKCODE_LOG_LEVEL"]) ??
    (verbose ? "debug" : "info"),
  base: { component: "gateway" },
  ...(logFile ? { logFile } : {}),
});

const gateway = await startGateway({
  host,
  port: portPlan.port,
  fallbackToEphemeral: portPlan.fallbackToEphemeral,
  logger,
  ...(serveDir ? { serveDir } : {}),
  ...(token ? { token } : {}),
});
console.log(
  `[cloakcode-gateway] listening on ws://${host}:${gateway.port}` +
    (serveDir ? ` (+ PWA from ${serveDir})` : " (WebSocket only)"),
);
if (logFile) {
  console.log(`[cloakcode-gateway] action log → ${logFile}`);
}
console.log(
  `[cloakcode-gateway] provider auth: ${
    token
      ? "ON (extensions must present the token)"
      : "OFF (no token) — keep on loopback + a private tunnel"
  }`,
);

// The URLs an extension can put in `cloakcode.gatewayUrl`, ranked by where it
// runs relative to this host (probed from the network interfaces).
console.log(
  "[cloakcode-gateway] connect extensions with cloakcode.gatewayUrl:",
);
for (const { url, label } of connectionUrls(
  host,
  gateway.port,
  networkInterfaces(),
)) {
  console.log(`[cloakcode-gateway]   ${url.padEnd(34)} ${label}`);
}

if (process.env["CLOAKCODE_TUNNEL"] === "devtunnel") {
  const seed = process.env["CLOAKCODE_INSTANCE_ID"] || "gateway";
  try {
    const tunnel = await startDevTunnel(
      gateway.port,
      devTunnelName(seed),
      (l) => console.log(`[devtunnel] ${l}`),
    );
    console.log(`[cloakcode-gateway] phone URL: ${tunnel.url}`);
    gateway.setPhoneUrl(tunnel.url);
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
