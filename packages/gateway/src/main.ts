#!/usr/bin/env node
/*
 * Standalone CloakCode gateway runner — run this OUTSIDE VS Code (host binary or
 * Docker). It serves the PWA + the WebSocket hub, and (since it is the public-
 * facing server) it OWNS the Dev Tunnel that exposes itself to a phone.
 * Extensions connect in as providers (docs/03 "Explicit gateway").
 *
 * Env:
 *   CLOAKCODE_GATEWAY_HOST   operator-listener bind: PWA + phone (default 127.0.0.1; pair with a private tunnel for remote)
 *   CLOAKCODE_GATEWAY_PORT   operator port: unset → 3543 (ephemeral if taken); 0 → ephemeral; N → lock N
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
 *   CLOAKCODE_TLS_HOST       provider-listener bind (default 127.0.0.1; set 0.0.0.0 to reach it from another host/container — the Docker image does; extensions connect here)
 *   CLOAKCODE_TLS_PORT       provider-listener port: unset → 3544 (ephemeral if taken); 0 → ephemeral; N → lock N
 *   CLOAKCODE_TLS_CERT_FILE  BYO PEM cert for the wss provider listener (with _KEY_FILE); unset → auto self-signed pair persisted under ~/.cloakcode
 *   CLOAKCODE_TLS_KEY_FILE   BYO PEM private key (with _CERT_FILE); a 0600 secret, never logged
 *   CLOAKCODE_PROVIDER_INSECURE  1 → serve the provider listener as INSECURE plain ws:// (no cert); warned in console + UI
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
import { devTunnelName, startDevTunnel } from "./tunnel.js";
import { OperatorAuth } from "./operator-auth.js";
import { strictEnrolmentLines } from "./enrol-console.js";
import {
  isExposed,
  isLoopbackHost,
  loadOrCreateSecret,
  operatorMfaEnabled,
  persistConfirmed,
  resolveSecretFile,
} from "./operator-secret.js";
import { resolveTlsMaterial } from "./tls.js";
import { qrTerminal } from "./qr-terminal.js";
import { DEFAULT_PROVIDER_PORT } from "@cloakcode/protocol";
import { resolveInstanceId } from "./instance-id.js";

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

// The dedicated PROVIDER listener (docs/04 role split): extensions connect here,
// separate from the operator/PWA listener. Binds CLOAKCODE_TLS_HOST (default
// 127.0.0.1 — loopback like the operator listener; set 0.0.0.0 to reach it from
// another host/container, as the Docker image does). wss by default
// — a BYO cert (CERT_FILE+KEY_FILE) or an auto self-signed pair persisted beside
// the operator secret (~/.cloakcode); the private key is a 0600 secret, only the
// public fingerprint (the pin) is shown. CLOAKCODE_PROVIDER_INSECURE=1 makes it an
// insecure plain ws:// listener (no cert), warned in the console + UI.
const providerHost = process.env["CLOAKCODE_TLS_HOST"] ?? "127.0.0.1";
const providerPortPlan = resolvePortPlan(
  process.env["CLOAKCODE_TLS_PORT"],
  null,
  DEFAULT_PROVIDER_PORT,
);
const insecureProvider =
  process.env["CLOAKCODE_PROVIDER_INSECURE"] === "1" ||
  process.env["CLOAKCODE_PROVIDER_INSECURE"] === "true";
let providerTls: { cert: string; key: string; fingerprint: string } | undefined;
if (!insecureProvider) {
  const material = await resolveTlsMaterial({
    certFile: process.env["CLOAKCODE_TLS_CERT_FILE"],
    keyFile: process.env["CLOAKCODE_TLS_KEY_FILE"],
    storeDir: dirname(resolveSecretFile(process.env)),
    host: providerHost,
  });
  providerTls = {
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
  provider: {
    host: providerHost,
    port: providerPortPlan.port,
    fallbackToEphemeral: providerPortPlan.fallbackToEphemeral,
    ...(providerTls ? { tls: providerTls } : {}),
  },
});
logger.info("gateway.start", { instanceId: seed });
console.log(
  `[cloakcode-gateway] instance: ${seed} (authenticator label + tunnel seed + phone name)`,
);
console.log(
  `[cloakcode-gateway] operator listener on ${host}:${gateway.port}` +
    (serveDir
      ? ` (HTTP PWA + phone WebSocket; assets from ${serveDir})`
      : " (phone WebSocket only)"),
);
console.log(
  `[cloakcode-gateway] provider listener on ${providerHost}:${gateway.providerPort} (${
    gateway.providerInsecure ? "INSECURE plain ws" : "wss"
  }; extensions connect here)`,
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

// The URLs an extension puts in `cloakcode.gatewayUrl` — the dedicated PROVIDER
// listener (not the operator port), ranked by where the extension runs relative
// to this host. wss when the listener has a cert (also print the fingerprint pin);
// an insecure plain ws otherwise. The cert FINGERPRINT is public (the pin —
// integrity, not secrecy), safe to print as the console fallback for pairing; the
// PWA "Connect an extension" view is the primary out-of-band channel (docs/04/05).
const providerScheme = gateway.providerInsecure ? "ws" : "wss";
console.log(
  `[cloakcode-gateway] connect extensions with cloakcode.gatewayUrl (${providerScheme}://, provider listener):`,
);
for (const { url, label } of connectionUrls(
  providerHost,
  gateway.providerPort,
  interfaces,
)) {
  console.log(
    `[cloakcode-gateway]   ${url.replace(/^ws:/, `${providerScheme}:`).padEnd(34)} ${label}`,
  );
}
if (!gateway.providerInsecure && gateway.fingerprint) {
  console.log(`[cloakcode-gateway]   cert fingerprint (SHA-256 pin):`);
  console.log(`[cloakcode-gateway]     ${gateway.fingerprint}`);
  console.log(
    `[cloakcode-gateway]   set cloakcode.gatewayCertFingerprint to that pin (a self-signed gateway needs nothing else).`,
  );
}

// Consolidated INSECURE-MODE banner (docs/04): warn — in the console AND, via
// gateway.info/connectInfo, the UI — when traffic is NOT encrypted. Authentication
// (TOTP/token) still applies; only confidentiality is lost. The operator is
// cleartext only on a **wide bind** (a private tunnel in front of a loopback
// operator supplies TLS, so it is NOT insecure).
const operatorCleartext = !isLoopbackHost(host);
if (operatorCleartext || gateway.providerInsecure) {
  console.warn(
    "[cloakcode-gateway] \u26a0 INSECURE MODE — traffic is NOT encrypted and can be read on the network:",
  );
  if (operatorCleartext) {
    console.warn(
      `[cloakcode-gateway]     • operator (PWA + phone) is on a wide bind (${host}) in cleartext HTTP/ws — prefer 127.0.0.1 + a private tunnel (devtunnel), which encrypts it`,
    );
  }
  if (gateway.providerInsecure) {
    console.warn(
      "[cloakcode-gateway]     • provider (extension) listener is plain ws — prefer wss (unset CLOAKCODE_PROVIDER_INSECURE to auto-generate a cert)",
    );
  }
  console.warn(
    "[cloakcode-gateway]   Authentication (TOTP/token) still applies; only confidentiality is lost. Use only on a trusted network.",
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
