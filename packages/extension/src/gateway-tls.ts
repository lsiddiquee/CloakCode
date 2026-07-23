import type { IncomingMessage } from "node:http";
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
 */
export function verifyPinnedCert(
  expectedFingerprint: string,
  cert: Pick<PeerCertificate, "fingerprint256">,
): Error | undefined {
  const expected = normalizeFingerprint(expectedFingerprint);
  const actual = normalizeFingerprint(cert.fingerprint256 ?? "");
  return actual === expected
    ? undefined
    : new Error(
        "cloakcode: gateway certificate fingerprint does not match the configured pin",
      );
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
  if (isFingerprintOnly(url, pin)) return { rejectUnauthorized: false };

  // CA-pin / real-CA: never accept an unverified certificate.
  const opts: ClientOptions = { rejectUnauthorized: true };
  if (pin.caPem && pin.caPem.trim()) opts.ca = pin.caPem;

  if (pin.fingerprint && pin.fingerprint.trim()) {
    const expected = pin.fingerprint;
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
  socket.on("upgrade", (res: IncomingMessage) => {
    const tlsSocket = res.socket as TLSSocket;
    if (typeof tlsSocket.getPeerCertificate === "function") {
      peerCert = tlsSocket.getPeerCertificate();
    }
  });
  socket.on("open", () => {
    const err = verifyPinnedCert(
      fingerprint,
      peerCert ?? { fingerprint256: "" },
    );
    if (err) {
      socket.terminate();
      onReject(err);
      return;
    }
    onVerified();
  });
}
