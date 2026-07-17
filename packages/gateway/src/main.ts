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
 *   CLOAKCODE_MFA            operator TOTP: off | required; unset → secure by exposure (on when exposed)
 *   CLOAKCODE_MFA_SECRET_FILE  where the base32 TOTP secret persists; default ~/.cloakcode/operator-totp.secret
 *   CLOAKCODE_MFA_ENROL      browser (default) | strict — strict never reveals the secret over the wire (console QR only)
 *   CLOAKCODE_MFA_RESET      1 → regenerate the secret (lockout recovery) and re-enter enrolment
 *
 * Security: the provider↔gateway token authenticates extensions; operator
 * (phone) access is gated by **TOTP** when exposed (F2a). Still keep an
 * untrusted-network deployment behind a PRIVATE tunnel — do not rely on a wide
 * `0.0.0.0` bind alone.
 */
import { networkInterfaces } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectionUrls } from "./connect-urls.js";
import { createConsoleLogger, parseLogLevel } from "./console-logger.js";
import { startGateway } from "./gateway.js";
import { resolvePortPlan } from "./listen.js";
import { devTunnelName, startDevTunnel } from "./tunnel.js";
import { OperatorAuth } from "./operator-auth.js";
import { otpauthUri } from "./totp.js";
import {
  isExposed,
  loadOrCreateSecret,
  operatorMfaEnabled,
  persistConfirmed,
  resolveSecretFile,
} from "./operator-secret.js";
import { qrTerminal } from "./qr-terminal.js";

const host = process.env["CLOAKCODE_GATEWAY_HOST"] ?? "127.0.0.1";
// unset → 3543 then ephemeral; 0 → ephemeral; N → lock N (same rule as embedded).
const portPlan = resolvePortPlan(process.env["CLOAKCODE_GATEWAY_PORT"]);
// Serve the PWA from CLOAKCODE_WEB_DIR, else a `web/` folder colocated with the
// bundle (how the published npm package and the assembled folder ship it). Absent
// both → WebSocket-only.
const bundledWeb = join(dirname(fileURLToPath(import.meta.url)), "web");
const serveDir =
  process.env["CLOAKCODE_WEB_DIR"] ??
  (existsSync(bundledWeb) ? bundledWeb : undefined);
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

// Operator (phone) app-layer auth: TOTP when the hub is exposed (F2a). The
// secret persists to a 0600 file (a mounted volume in Docker) and is generated
// on first run; construct the shared gate before startGateway so it applies to
// every operator connection. A fresh secret is UNCONFIRMED — the hub serves only
// pairing until a code is verified (enrolment mode). Off ⇒ undefined ⇒ open gate.
const mfaOn = operatorMfaEnabled(process.env, isExposed(host, process.env));
const strictEnrol =
  (process.env["CLOAKCODE_MFA_ENROL"] ?? "").trim().toLowerCase() === "strict";
const mfaReset =
  process.env["CLOAKCODE_MFA_RESET"] === "1" ||
  process.env["CLOAKCODE_MFA_RESET"] === "true";
let operatorAuth: OperatorAuth | undefined;
let mfaSetup:
  | { secret: string; file: string; confirmed: boolean; strict: boolean }
  | undefined;
if (mfaOn) {
  const file = resolveSecretFile(process.env);
  const { secret, confirmed } = loadOrCreateSecret(file, { reset: mfaReset });
  operatorAuth = new OperatorAuth({
    secret,
    confirmed,
    strictEnrol,
    onConfirmed: () => persistConfirmed(file),
  });
  mfaSetup = { secret, file, confirmed, strict: strictEnrol };
}

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
  ...(operatorAuth ? { operatorAuth } : {}),
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

// Operator (phone) TOTP status. On FIRST setup only, print the pairing QR + the
// otpauth URI + the base32 secret so the operator can enrol an authenticator app
// — intentional one-time stdout for the human at the console (not the action
// log; the secret is never sent to the logger). On later runs we only say where
// the secret lives, never reprinting it.
if (mfaOn && mfaSetup) {
  console.log(
    `[cloakcode-gateway] operator auth (TOTP): ON — secret at ${mfaSetup.file}`,
  );
  if (!mfaSetup.confirmed) {
    // Enrolment mode: the hub serves ONLY pairing until a code is verified.
    console.log(
      "[cloakcode-gateway] enrolment required — the hub serves ONLY pairing until you verify a code.",
    );
    if (mfaSetup.strict) {
      // Strict (Option B): the secret is NEVER revealed over the wire — the
      // console is the out-of-band pairing channel. Scan here, verify in the app.
      const uri = otpauthUri(mfaSetup.secret);
      console.log(
        "[cloakcode-gateway] strict enrolment — scan this QR, then enter a code in the app:",
      );
      console.log(qrTerminal(uri));
      console.log(`[cloakcode-gateway]   otpauth URI: ${uri}`);
      console.log(`[cloakcode-gateway]   secret (base32): ${mfaSetup.secret}`);
    } else {
      // Browser (Option A): open the PWA (phone URL below) to scan the QR and
      // verify a code — pairing happens in the app, no console QR needed.
      console.log(
        "[cloakcode-gateway] open the app (phone URL below) to scan the QR and finish pairing.",
      );
    }
  }
} else {
  console.log(
    "[cloakcode-gateway] operator auth (TOTP): OFF (loopback-only) — set CLOAKCODE_MFA=required to force it",
  );
}

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
    console.log(qrTerminal(tunnel.url));
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
