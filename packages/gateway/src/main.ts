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
 *   CLOAKCODE_INSTANCE_ID    identity: tunnel-name seed + authenticator label + phone name (default: machine hostname; e.g. office/home)
 *   CLOAKCODE_LOG_LEVEL      trace|debug|info|warn|error (default info; CLOAKCODE_VERBOSE=1 ⇒ debug)
 *   CLOAKCODE_GATEWAY_LOG_FILE  on-disk action log (JSONL); unset → ./cloakcode-gateway.jsonl; "" → off
 *   CLOAKCODE_GATEWAY_TOKEN  provider↔gateway shared secret (extensions present it in their hello); unset → off
 *   CLOAKCODE_MFA            operator TOTP: off | required; unset → secure by exposure (on when exposed)
 *   CLOAKCODE_MFA_SECRET_FILE  where the base32 TOTP secret persists; default ~/.cloakcode/operator-totp.secret
 *   CLOAKCODE_MFA_ENROL      browser (default) | strict — strict never reveals the secret over the wire; the QR shows only on a TTY (never docker logs), else the 0600 secret file
 *   CLOAKCODE_MFA_RESET      1 → regenerate the secret (lockout recovery) and re-enter enrolment
 *   CLOAKCODE_TLS_PORT       enable a dedicated wss:// provider listener on this port (unset → off; loopback HTTP is unchanged)
 *   CLOAKCODE_TLS_CERT_FILE  BYO PEM cert for wss (with _KEY_FILE); unset → auto self-signed pair persisted under ~/.cloakcode
 *   CLOAKCODE_TLS_KEY_FILE   BYO PEM private key for wss (with _CERT_FILE); a 0600 secret, never logged
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
import { browserUrls, connectionUrls } from "./connect-urls.js";
import { createConsoleLogger, parseLogLevel } from "./console-logger.js";
import { startGateway } from "./gateway.js";
import { resolvePortPlan } from "./listen.js";
import { resolveInstanceId } from "./instance-id.js";
import { devTunnelName, startDevTunnel } from "./tunnel.js";
import { OperatorAuth } from "./operator-auth.js";
import { strictEnrolmentLines } from "./enrol-console.js";
import {
  isExposed,
  loadOrCreateSecret,
  operatorMfaEnabled,
  persistConfirmed,
  resolveSecretFile,
} from "./operator-secret.js";
import { resolveTlsMaterial } from "./tls.js";
import { qrTerminal } from "./qr-terminal.js";

const host = process.env["CLOAKCODE_GATEWAY_HOST"] ?? "127.0.0.1";
// Per-instance identifier: the Dev-Tunnel name seed, the authenticator label AND
// the name shown to the phone (so multiple gateways are distinguishable — e.g.
// "office" vs "home"). An explicit CLOAKCODE_INSTANCE_ID wins; otherwise it
// defaults to the machine hostname (the Windows computer/NetBIOS name, or the
// Unix hostname), never a generic "gateway".
const seed = resolveInstanceId(process.env["CLOAKCODE_INSTANCE_ID"]);
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
    label: seed,
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

// Optional product-owned native TLS for the direct provider link (docs/04/05).
// CLOAKCODE_TLS_PORT is the switch; the cert is BYO (CERT_FILE+KEY_FILE) or an
// auto self-signed pair persisted beside the operator secret (~/.cloakcode). The
// private key is a 0600 secret; only the public fingerprint (the pin) is shown.
const tlsPort = parseTlsPort(process.env["CLOAKCODE_TLS_PORT"]);
let tls:
  { port: number; cert: string; key: string; fingerprint: string } | undefined;
if (tlsPort !== undefined) {
  const material = await resolveTlsMaterial({
    certFile: process.env["CLOAKCODE_TLS_CERT_FILE"],
    keyFile: process.env["CLOAKCODE_TLS_KEY_FILE"],
    storeDir: dirname(resolveSecretFile(process.env)),
    host,
  });
  tls = {
    port: tlsPort,
    cert: material.cert,
    key: material.key,
    fingerprint: material.fingerprint,
  };
}

const gateway = await startGateway({
  host,
  port: portPlan.port,
  fallbackToEphemeral: portPlan.fallbackToEphemeral,
  logger,
  instanceId: seed,
  ...(serveDir ? { serveDir } : {}),
  ...(token ? { token } : {}),
  ...(operatorAuth ? { operatorAuth } : {}),
  ...(tls ? { tls } : {}),
});
logger.info("gateway.start", { instanceId: seed });
console.log(
  `[cloakcode-gateway] instance: ${seed} (authenticator label + tunnel seed + phone name)`,
);
console.log(
  `[cloakcode-gateway] listening on ${host}:${gateway.port}` +
    (serveDir
      ? ` (HTTP PWA + WebSocket; assets from ${serveDir})`
      : " (WebSocket only)"),
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

// Operator (phone) TOTP status. On FIRST setup only, guide the human at the
// console to enrol an authenticator — WITHOUT ever writing the seed (base32 /
// otpauth URI) to stdout, which on a container is a persistent `docker logs`
// sink (drift audit S7). The secret persists to the 0600 file; the action log
// never sees it. On later runs we only say where the secret lives.
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
      // Strict (Option B): the secret is never revealed over the wire — the
      // console is the out-of-band channel, but ONLY a real TTY (never the
      // persistent log stream) shows the QR; headless is pointed at the 0600 file.
      for (const line of strictEnrolmentLines({
        isTTY: Boolean(process.stdout.isTTY),
        secret: mfaSetup.secret,
        account: seed,
        file: mfaSetup.file,
      })) {
        console.log(line);
      }
    } else {
      // Browser (Option A): open the PWA (phone URL below) to scan the QR and
      // verify a code — pairing happens in the app, no console QR needed.
      console.log(
        "[cloakcode-gateway] open one of the PWA browser URLs below to scan the QR and finish pairing.",
      );
    }
  }
} else {
  console.log(
    "[cloakcode-gateway] operator auth (TOTP): OFF (loopback-only) — set CLOAKCODE_MFA=required to force it",
  );
}

const interfaces = networkInterfaces();

// HTTP URLs a browser can actually open. Never advertise `0.0.0.0`: for a wide
// bind, browserUrls expands it to loopback + concrete interface addresses.
if (serveDir) {
  console.log("[cloakcode-gateway] open the PWA in a browser (HTTP):");
  for (const { url, label } of browserUrls(host, gateway.port, interfaces)) {
    console.log(`[cloakcode-gateway]   ${url.padEnd(36)} ${label}`);
  }
}

// The WS URLs an extension can put in `cloakcode.gatewayUrl`, ranked by where
// it runs relative to this host (probed from the same network interfaces).
console.log(
  "[cloakcode-gateway] connect extensions with cloakcode.gatewayUrl:",
);
for (const { url, label } of connectionUrls(host, gateway.port, interfaces)) {
  console.log(`[cloakcode-gateway]   ${url.padEnd(34)} ${label}`);
}

// Native TLS (wss) status. The cert FINGERPRINT is public (the pin — integrity,
// not secrecy), so it's safe to print as the console fallback for pairing an
// extension; the private key is never printed. The PWA "Connect an extension"
// view is the primary, out-of-band delivery channel (docs/04/05).
if (gateway.tlsPort !== undefined && gateway.fingerprint) {
  console.log(
    `[cloakcode-gateway] native TLS (wss): ON — dedicated provider listener on ${host}:${gateway.tlsPort}`,
  );
  for (const { url } of connectionUrls(host, gateway.tlsPort, interfaces)) {
    console.log(
      `[cloakcode-gateway]   ${url.replace(/^ws:/, "wss:").padEnd(34)} (pin the fingerprint below)`,
    );
  }
  console.log(`[cloakcode-gateway]   cert fingerprint (SHA-256 pin):`);
  console.log(`[cloakcode-gateway]     ${gateway.fingerprint}`);
  console.log(
    `[cloakcode-gateway]   set cloakcode.gatewayCertFingerprint to that pin (or point cloakcode.gatewayCaFile at the cert).`,
  );
}

if (process.env["CLOAKCODE_TUNNEL"] === "devtunnel") {
  try {
    const tunnel = await startDevTunnel(
      gateway.port,
      devTunnelName(seed),
      (l) => console.log(`[devtunnel] ${l}`),
    );
    console.log(
      `[cloakcode-gateway] PWA / phone URL (HTTPS, private Dev Tunnel): ${tunnel.url}`,
    );
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

/**
 * Parse `CLOAKCODE_TLS_PORT`: unset/blank → `undefined` (native TLS off); a valid
 * `0-65535` → that port (the wss listener; `0` picks ephemeral). A non-numeric or
 * out-of-range value fails loud rather than silently disabling TLS. Hoisted.
 */
function parseTlsPort(raw: string | undefined): number | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(
      `CLOAKCODE_TLS_PORT must be a port 0-65535, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}
