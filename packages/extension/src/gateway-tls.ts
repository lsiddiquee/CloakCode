import type { IncomingMessage } from "node:http";
import { Agent } from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { PeerCertificate, TLSSocket } from "node:tls";
import type { ClientOptions, WebSocket } from "ws";

/**
 * Server-identity pinning for the extension's outbound provider link (drift
 * audit S4b; docs/04 "Closing the gap", docs/05). When the extension connects to
 * a gateway over `wss://` it must verify **which** server it reached — otherwise
 * a redirected `gatewayUrl` (S4) or a MITM could impersonate the hub and request
 * env-wide session data. Pure so the pin logic unit-tests without an extension host.
 *
 * Two ways to trust a self-signed / BYO gateway — pick per what you configured:
 *
 *  • **Fingerprint-only (the easy path)** — set only
 *    `cloakcode.gatewayCertFingerprint`. Node's `rejectUnauthorized:true` would
 *    reject a self-signed chain *before* any pin runs, and `checkServerIdentity`
 *    is **ignored** when auth is off — so this mode turns chain auth off and
 *    verifies the **exact cert fingerprint by hand** the instant the socket opens,
 *    failing closed before sending anything (see {@link guardFingerprintPin}).
 *    Pinning the exact cert is as strong as a CA for a single known server, and it
 *    skips the hostname/SAN check a bare-IP / `host.docker.internal` gateway can't
 *    satisfy. (Verified secure against the live gateway; "Mechanism 2".)
 *
 *  • **CA-pin (optional, stricter)** — additionally set `cloakcode.gatewayCaFile`
 *    to the gateway's cert. Full chain validation stays **on** (`rejectUnauthorized`
 *    is never downgraded); the self-signed cert is trusted as a CA and the optional
 *    fingerprint pins it in `checkServerIdentity` (which Node calls only *after*
 *    chain validation succeeds).
 *
 * A **real-CA** gateway needs neither: the system trust store validates it and the
 * default hostname check applies (plus the fingerprint pin if provided). With no
 * pin and no CA on a `wss://` URL we still fail closed — `rejectUnauthorized:true`
 * against the system trust store; we never fall back to an unverified socket.
 */
export interface GatewayPinConfig {
  /** Contents of the gateway cert PEM (from `cloakcode.gatewayCaFile`), if set. */
  caPem?: string | undefined;
  /** Expected SHA-256 fingerprint (`cloakcode.gatewayCertFingerprint`), if set. */
  fingerprint?: string | undefined;
}

/** Canonicalize a fingerprint for comparison: hex only, uppercase. */
export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

/**
 * True when the pin config selects **fingerprint-only** mode for this URL: a
 * `wss://` gateway with a fingerprint set but no CA PEM. In this mode
 * {@link gatewayTlsOptions} returns `rejectUnauthorized:false` and the caller MUST
 * verify the peer cert by hand via {@link guardFingerprintPin}.
 */
export function isFingerprintOnly(url: string, pin: GatewayPinConfig): boolean {
  return (
    /^wss:/i.test(url.trim()) &&
    Boolean(pin.fingerprint && pin.fingerprint.trim()) &&
    !(pin.caPem && pin.caPem.trim())
  );
}

/**
 * The pin check: accept (return `undefined`) iff the peer cert's SHA-256
 * fingerprint equals the expected pin; else return an `Error` (fail closed).
 * Separated out so it unit-tests directly with a `PeerCertificate`.
 *
 * The message **names both fingerprints**, and says so explicitly when the peer
 * presented none: otherwise "a different server answered" and "we never captured
 * the certificate" produce byte-identical logs, which is undebuggable from a
 * report (cost real time 2026-07-27). A certificate fingerprint is public
 * material — the gateway prints its own — so this leaks no secret.
 */
export function verifyPinnedCert(
  expectedFingerprint: string,
  cert: Pick<PeerCertificate, "fingerprint256">,
): Error | undefined {
  const expected = normalizeFingerprint(expectedFingerprint);
  const actual = normalizeFingerprint(cert.fingerprint256 ?? "");
  if (actual === expected) return undefined;
  // Show enough of each to tell the failures apart (a DIFFERENT cert vs none at
  // all vs which pin was in effect) and no more. The presented value is derived
  // from bytes the REMOTE chose, so printing it in full lets whatever answered
  // put a ready-to-paste "fix" in front of the operator — that turns pinning into
  // trust-on-first-use. The configured value is theirs already, and a truncated
  // echo keeps it out of shared logs.
  return new Error(
    actual === ""
      ? `cloakcode: gateway presented no certificate to pin (configured pin ${short(expected)})`
      : `cloakcode: gateway certificate fingerprint does not match the configured pin ` +
          `(presented ${short(actual)}, configured ${short(expected)}). Read the correct ` +
          `pin from the gateway's own console or its "Connect an extension" view — ` +
          `never from this message.`,
  );
}

/** First 12 hex chars — enough to compare by eye, useless to paste. */
function short(fingerprint: string): string {
  return fingerprint.slice(0, 12) + "…";
}

/**
 * An agent that never resumes a TLS session, so every pinned connection does a
 * **full** handshake and the server therefore always presents its certificate.
 *
 * On a resumed session the peer sends no certificate: `getPeerCertificate()`
 * returns `{}` and `checkServerIdentity` is not called — the pin then cannot be
 * verified at all. That is both a false rejection (the first connect works and
 * every reconnect "fails the pin" — exactly what a packaged extension hit on
 * 2026-07-27) and, in CA-pin mode, a silent *skip* of the fingerprint check.
 * Owning the agent also means a shared session cache we don't control (VS Code
 * installs one for extensions via `http.proxySupport`) can't reintroduce it.
 */
function noResumptionAgent(rejectUnauthorized: boolean): Agent {
  return new Agent({ maxCachedSessions: 0, rejectUnauthorized });
}

/**
 * Build the `ws` client options for a gateway URL. For `ws://` (loopback dev /
 * an overlay that terminates TLS) returns `{}` — no TLS layer. For `wss://` it
 * pins the server identity per {@link GatewayPinConfig}, keeping
 * `rejectUnauthorized: true` (no downgrade).
 */
export function gatewayTlsOptions(
  url: string,
  pin: GatewayPinConfig = {},
): ClientOptions {
  if (!/^wss:/i.test(url.trim())) return {};

  // Fingerprint-only: the pin is the sole identity anchor. Chain auth is turned
  // off (a self-signed chain would otherwise fail BEFORE the pin runs, and
  // checkServerIdentity is ignored when auth is off); guardFingerprintPin then
  // verifies the exact cert by hand and fails closed. See the module doc.
  if (isFingerprintOnly(url, pin)) {
    return {
      rejectUnauthorized: false,
      agent: noResumptionAgent(false),
    };
  }

  // CA-pin / real-CA: never accept an unverified certificate.
  const opts: ClientOptions = { rejectUnauthorized: true };
  if (pin.caPem && pin.caPem.trim()) opts.ca = pin.caPem;

  if (pin.fingerprint && pin.fingerprint.trim()) {
    const expected = pin.fingerprint;
    // The pin must be checked on EVERY connection, so this mode owns its agent too.
    opts.agent = noResumptionAgent(true);
    // @types/ws types `checkServerIdentity` as `(servername, CertMeta) => boolean`,
    // but at runtime ws forwards it to Node's `tls.connect`, which uses the
    // standard `(host, cert: PeerCertificate) => Error | undefined` contract
    // (undefined = accept, Error = reject). Cast to the (inaccurate) ws signature.
    opts.checkServerIdentity = ((_servername: string, cert: PeerCertificate) =>
      verifyPinnedCert(expected, cert)) as unknown as NonNullable<
      ClientOptions["checkServerIdentity"]
    >;
  }
  return opts;
}

/**
 * The "no certificate" case we can actually explain. A **resumed** TLS session
 * carries no certificate, so the fingerprint cannot be checked and we fail closed
 * — but the pin is not wrong. {@link selfProvisionedPin} makes this unreachable in
 * normal operation (a fingerprint-only link is upgraded to a CA-pin, which the TLS
 * stack enforces even on a resumed session); it remains as the honest report if a
 * host ever manages to hand us a resumed, unvalidated session anyway.
 */
function resumedPinError(): Error {
  return new Error(
    "cloakcode: the gateway's TLS session was RESUMED, so it presented no " +
      "certificate and the fingerprint pin could not be checked (the pin itself " +
      "is not wrong). Set cloakcode.gatewayCaFile to the gateway's certificate — " +
      "CA-pinning is enforced by the TLS stack and is unaffected — or set " +
      'http.proxySupport to "on" so VS Code stops replacing CloakCode\'s ' +
      "connection agent.",
  );
}

/** DER (`cert.raw`) → the PEM text Node accepts as a `ca` trust anchor. */
function derToPem(der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return [
    "-----BEGIN CERTIFICATE-----",
    ...lines,
    "-----END CERTIFICATE-----",
    "",
  ].join("\n");
}

/**
 * Fetch the gateway's own certificate over a **direct** `tls.connect` and return
 * it as PEM — but only if it matches `expected`. The probe accepts an unvalidated
 * chain (there is nothing to validate a self-signed gateway against yet), so the
 * fingerprint check is the ONLY thing that makes the result trustworthy: it is
 * verified here, before the PEM is handed back, and a mismatch throws.
 */
async function fetchPinnedCertPem(
  url: string,
  expected: string,
  timeoutMs: number,
): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise<string>((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: hostname,
        port: Number(port || 443),
        // Nothing to validate against yet — the fingerprint below is the check.
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();
        const err = verifyPinnedCert(expected, cert);
        if (err) reject(err);
        else if (!cert.raw) reject(new Error("cloakcode: no certificate to pin"));
        else resolve(derToPem(cert.raw));
      },
    );
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(new Error(`cloakcode: no TLS answer from ${url}`)),
    );
    socket.on("error", reject);
  });
}

/**
 * Turn a **fingerprint-only** pin into a CA-pin, with no extra configuration.
 *
 * Fingerprint-only pinning has to *observe* the certificate on the wire, and a
 * resumed TLS session carries none — and we cannot prevent resumption, because
 * `@vscode/proxy-agent` discards an extension-supplied agent for every host except
 * `localhost`/`127.0.0.1` (an explicit carve-out for microsoft/vscode#120354) under
 * the default `http.proxySupport: "override"`. So a non-loopback gateway would work
 * on the first connect and fail every reconnect — including the sign-in reconnect,
 * which made provider sign-in unreachable.
 *
 * What the host *does* preserve is the request options (`ca`, `checkServerIdentity`,
 * `rejectUnauthorized`). So we fetch the gateway's cert ourselves, verify the
 * configured fingerprint against it, and pass it as the `ca` — moving the check
 * into the TLS stack, which treats a resumed session as already validated. The
 * trust decision is identical to fingerprint-only (the fingerprint, and nothing
 * else, is what makes the fetched cert acceptable) and the link is then strictly
 * stronger: full chain validation, plus the pin re-verified in
 * `checkServerIdentity` on every full handshake.
 *
 * A probe that cannot reach the gateway returns the pin unchanged — that is
 * "unreachable", handled by the caller's normal timeout, not a pin failure. A
 * probe that reaches a server presenting the WRONG cert throws: fail closed.
 */
export async function selfProvisionedPin(
  url: string,
  pin: GatewayPinConfig,
  timeoutMs = 4000,
): Promise<GatewayPinConfig> {
  if (!isFingerprintOnly(url, pin) || !pin.fingerprint) return pin;
  try {
    return { ...pin, caPem: await fetchPinnedCertPem(url, pin.fingerprint, timeoutMs) };
  } catch (err) {
    // A fingerprint mismatch is a real pin failure and must surface; anything
    // else (refused, timeout, reset) is unreachability — let the connect report it.
    if (err instanceof Error && err.message.includes("to pin")) throw err;
    return pin;
  }
}

/**
 * Wire fingerprint-only verification onto a freshly-created `ws` socket, then
 * signal readiness. In fingerprint-only mode Node did **not** validate the cert,
 * so we capture the peer cert on `upgrade` and, the instant the socket opens,
 * verify the exact SHA-256 fingerprint. On mismatch we **terminate** and call
 * `onReject` BEFORE any application frame is sent (fail closed); on match — or when
 * not in fingerprint-only mode (plain `ws://`, CA-pin, or real-CA, where the
 * transport already authenticated the server) — we call `onVerified`, from which
 * the caller sends its first frame. Keeps the manual-pin path in ONE audited place
 * (shared by the provider link and the TOTP code exchange).
 */
export function guardFingerprintPin(
  socket: WebSocket,
  url: string,
  pin: GatewayPinConfig,
  onVerified: () => void,
  onReject: (err: Error) => void,
): void {
  const fingerprint = pin.fingerprint;
  if (!fingerprint || !isFingerprintOnly(url, pin)) {
    socket.on("open", onVerified);
    return;
  }
  let peerCert: PeerCertificate | undefined;
  let resumed = false;
  socket.on("upgrade", (res: IncomingMessage) => {
    const tlsSocket = res.socket as TLSSocket;
    if (typeof tlsSocket.getPeerCertificate === "function") {
      peerCert = tlsSocket.getPeerCertificate();
    }
    if (typeof tlsSocket.isSessionReused === "function") {
      resumed = tlsSocket.isSessionReused() === true;
    }
  });
  socket.on("open", () => {
    const err = verifyPinnedCert(
      fingerprint,
      peerCert ?? { fingerprint256: "" },
    );
    if (err) {
      socket.terminate();
      onReject(resumed && !peerCert?.fingerprint256 ? resumedPinError() : err);
      return;
    }
    onVerified();
  });
}
