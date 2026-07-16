import { timingSafeEqual } from "node:crypto";

/**
 * Verify a presented shared secret against the gateway's configured one, in
 * **constant time**. Auth is **disabled** when no token is configured (empty /
 * undefined) — the loopback-dev default — so the gateway stays open on localhost
 * and only enforces once you set a token (for a shared bind / a tunnel). A
 * length mismatch short-circuits to `false` (a minor length oracle, acceptable
 * for a shared secret) so `timingSafeEqual` never throws on unequal buffers.
 */
export function verifyGatewayToken(
  configured: string | undefined,
  presented: string | undefined,
): boolean {
  if (!configured) return true; // no token set → auth disabled
  if (!presented) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
