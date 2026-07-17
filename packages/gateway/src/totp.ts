import { createHmac, timingSafeEqual } from "node:crypto";
import { Secret, TOTP } from "otpauth";

/**
 * Operator app-layer auth crypto (docs/04, F2a): RFC 6238 TOTP via the vetted
 * `otpauth` library (bundles the audited `@noble/hashes`), plus a small
 * node:crypto HMAC bearer **session token** so a re-authenticated operator needn't
 * re-enter a code on every reconnect. Server-side only (gateway + embedded
 * bridge, both Node); the web client only submits the typed code and stores the
 * token string. No `vscode`, no I/O — a pure, unit-testable module.
 */

const ISSUER = "CloakCode";

/** A configured RFC-6238 TOTP for a base32 secret (SHA1 / 6 digits / 30s). */
function totpFor(secretBase32: string, account = "gateway"): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label: account,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

/** A fresh random 160-bit base32 TOTP secret — unique per install (CSPRNG). */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** The `otpauth://` provisioning URI an authenticator app scans from the QR. */
export function otpauthUri(secretBase32: string, account = "gateway"): string {
  return totpFor(secretBase32, account).toString();
}

/**
 * Verify a submitted `code` against `secret` within ±`window` steps (default ±1
 * = ±30s drift). Returns `{ ok, step }` — `step` is the accepted counter so the
 * caller can REJECT REPLAYS by refusing a step it already accepted. (`otpauth`
 * does a constant-time compare internally.)
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { window?: number; now?: () => number } = {},
): { ok: boolean; step?: number } {
  const window = opts.window ?? 1;
  const timestamp = opts.now?.() ?? Date.now();
  const delta = totpFor(secretBase32).validate({
    token: code.trim(),
    timestamp,
    window,
  });
  if (delta === null) return { ok: false };
  return { ok: true, step: Math.floor(timestamp / 1000 / 30) + delta };
}

function hmac(secretBase32: string, payload: string): Buffer {
  const key = Buffer.from(Secret.fromBase32(secretBase32).bytes);
  return createHmac("sha256", key).update(payload).digest();
}

/**
 * Issue a short-lived bearer session token (`<exp>.<hmac>`, HMAC-SHA256 over the
 * expiry, keyed by the TOTP secret). Bound to the secret, so rotating it
 * invalidates every token. NB: a bearer token — carry it only over the TLS
 * tunnel (plain-`ws` LAN needs `wss`, docs/04).
 */
export function issueSessionToken(
  secretBase32: string,
  ttlMs: number,
  now: () => number = () => Date.now(),
): string {
  const exp = now() + ttlMs;
  return `${exp}.${hmac(secretBase32, String(exp)).toString("base64url")}`;
}

/** Verify a session token: well-formed, unexpired, and a valid signature. */
export function verifySessionToken(
  secretBase32: string,
  token: string,
  now: () => number = () => Date.now(),
): boolean {
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < now()) return false;
  const got = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = hmac(secretBase32, String(exp));
  return got.length === expected.length && timingSafeEqual(got, expected);
}
