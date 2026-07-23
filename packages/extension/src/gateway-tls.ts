import type { PeerCertificate } from "node:tls";
import type { ClientOptions } from "ws";

/**
 * Server-identity pinning for the extension's outbound provider link (drift
 * audit S4b; docs/04 "Closing the gap", docs/05). When the extension connects to
 * a gateway over `wss://`, it must verify **which** server it reached — otherwise
 * a redirected `gatewayUrl` (S4) or a MITM could impersonate the hub and request
 * env-wide session data. Pure so it unit-tests without an extension host.
 *
 * Model (the finalized CA-pin path): `rejectUnauthorized` stays **true** and is
 * never downgraded. For a **self-signed** gateway the operator supplies the cert
 * as a trusted CA (`cloakcode.gatewayCaFile`) so chain validation passes; the
 * optional `cloakcode.gatewayCertFingerprint` is then verified in
 * `checkServerIdentity` (which Node calls **only after** CA validation), and it
 * replaces the hostname check because a self-signed cert's identity is its pin,
 * not its (possibly bare-IP) SAN. For a **real-CA / BYO** gateway no CA file is
 * needed — the system trust store validates it and the default hostname check
 * applies (plus the fingerprint pin if provided). A fingerprint **alone** is not
 * a self-signed connect mode: without the cert, `rejectUnauthorized:true` fails
 * closed (we never fall back to an unverified socket).
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

  // Encrypted transport: never accept an unverified certificate.
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
