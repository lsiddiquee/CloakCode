import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Optional product-owned native TLS for the **direct provider link** (docs/04
 * "Closing the gap", docs/05). When enabled the gateway serves `wss://` on a
 * dedicated listener from a cert whose **SHA-256 fingerprint** is the pin the
 * extension verifies. This module is the cert source: bring-your-own, a
 * persisted self-signed pair, or a freshly generated one — plus the fingerprint.
 *
 * The private key is a **secret**: mode `0600`, never logged. The cert and its
 * fingerprint are **public** (integrity matters, not secrecy).
 */
export interface TlsMaterial {
  /** PEM certificate (public — its fingerprint is the pin). */
  cert: string;
  /** PEM private key — a mode-`0600` secret. NEVER log this. */
  key: string;
  /** SHA-256 fingerprint of the cert, uppercase colon-hex (the pin). */
  fingerprint: string;
  /** How the material was obtained (for a non-secret status line). */
  source: "byo" | "loaded" | "generated";
}

/** File names of the persisted self-signed pair inside the store dir. */
export const TLS_CERT_FILE = "tls-cert.pem";
export const TLS_KEY_FILE = "tls-key.pem";

/**
 * SHA-256 fingerprint of a PEM certificate — uppercase colon-separated hex, the
 * exact form Node's {@link X509Certificate.fingerprint256} yields. Both ends
 * compute it the same way (the gateway from its own cert, the extension from the
 * peer cert in `checkServerIdentity`), so the pin compares byte-for-byte.
 */
export function certFingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}

export interface TlsResolveOptions {
  /** BYO certificate PEM file — must be paired with {@link keyFile}. */
  certFile?: string | undefined;
  /** BYO private-key PEM file — must be paired with {@link certFile}. */
  keyFile?: string | undefined;
  /** Directory the auto self-signed pair persists in (mode-restricted). */
  storeDir: string;
  /** SAN host for a generated cert (loopback SANs are always included). */
  host?: string | undefined;
  /**
   * Injected in tests; defaults to an EC (P-256) self-signed generator. Returns
   * PEM `{ cert, key }`.
   */
  generateCert?: (host?: string) => Promise<{ cert: string; key: string }>;
}

/**
 * Resolve the TLS material for the `wss://` listener, in priority order:
 *
 * 1. **Bring-your-own** — both `certFile` and `keyFile` (real CA / mkcert /
 *    corporate PKI). Setting only one is a configuration error (fail loud).
 * 2. **Persisted self-signed** — a previous auto pair in `storeDir` (stable
 *    fingerprint across restarts, so a paired extension keeps trusting it).
 * 3. **Generate + persist** — a fresh EC self-signed pair, written with the key
 *    at `0600` and the dir at `0700` (umask-independent via explicit `chmod`).
 *
 * Never logs the key. The returned {@link TlsMaterial.fingerprint} is what the
 * PWA publishes for out-of-band pinning.
 */
export async function resolveTlsMaterial(
  opts: TlsResolveOptions,
): Promise<TlsMaterial> {
  // 1. Bring-your-own cert/key.
  if (opts.certFile !== undefined || opts.keyFile !== undefined) {
    if (!opts.certFile || !opts.keyFile) {
      throw new Error(
        "TLS: set BOTH CLOAKCODE_TLS_CERT_FILE and CLOAKCODE_TLS_KEY_FILE " +
          "(or neither, for an auto self-signed cert)",
      );
    }
    const cert = readFileSync(opts.certFile, "utf8");
    const key = readFileSync(opts.keyFile, "utf8");
    return { cert, key, fingerprint: certFingerprint(cert), source: "byo" };
  }

  // 2. Persisted self-signed pair.
  const certPath = join(opts.storeDir, TLS_CERT_FILE);
  const keyPath = join(opts.storeDir, TLS_KEY_FILE);
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, "utf8");
    const key = readFileSync(keyPath, "utf8");
    return { cert, key, fingerprint: certFingerprint(cert), source: "loaded" };
  }

  // 3. Generate + persist (dir 0700, key 0600, cert 0644). chmod after write so
  //    a lax umask can't leave the key group/other-readable.
  const gen = opts.generateCert ?? generateSelfSigned;
  const { cert, key } = await gen(opts.host);
  mkdirSync(opts.storeDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.storeDir, 0o700);
  writeFileSync(keyPath, key, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  writeFileSync(certPath, cert, { mode: 0o644 });
  chmodSync(certPath, 0o644);
  return { cert, key, fingerprint: certFingerprint(cert), source: "generated" };
}

/** `true` for a loopback host (skip it as a CN / duplicate SAN). */
function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** A rough IPv4/IPv6 test — good enough to pick the SAN entry type. */
function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * The default generator: an EC (P-256) self-signed cert with SANs for loopback
 * plus the bind host. `selfsigned` (+ its modern `@peculiar/x509` / `pkijs`
 * deps) is imported lazily so the no-TLS path never pays for it.
 */
async function generateSelfSigned(
  host?: string,
): Promise<{ cert: string; key: string }> {
  const { generate } = await import("selfsigned");
  const altNames: Array<{ type: 2 | 7; value?: string; ip?: string }> = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    { type: 7, ip: "::1" },
  ];
  const named = host && !isLoopback(host);
  if (named) {
    if (isIpAddress(host)) altNames.push({ type: 7, ip: host });
    else altNames.push({ type: 2, value: host });
  }
  const fiveYearsMs = 5 * 365 * 24 * 60 * 60 * 1000;
  const pems = await generate(
    [{ name: "commonName", value: named ? host : "cloakcode-gateway" }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notAfterDate: new Date(Date.now() + fiveYearsMs),
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames },
      ],
    },
  );
  return { cert: pems.cert, key: pems.private };
}
