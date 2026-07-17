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

/**
 * Authorize a provider (extension) presenting a credential in its hello, across
 * the **two** accepted forms (docs/04, F2a slice 2):
 *
 * - a **TOTP→token** session token (the default interactive path) — the operator
 *   secret issued it after a human entered a code once in VS Code; verified via
 *   `verifyToken`; and/or
 * - the static **shared secret** (`CLOAKCODE_GATEWAY_TOKEN`) — the demoted
 *   headless/automation/bootstrap escape hatch; verified timing-safe.
 *
 * When **neither** is configured the gateway is open (loopback dev). When either
 * is configured a provider must satisfy one of them.
 */
export function verifyProviderCredential(
  presented: string | undefined,
  opts: {
    staticToken?: string | undefined;
    verifyToken?: ((token: string) => boolean) | undefined;
  },
): boolean {
  const { staticToken, verifyToken } = opts;
  if (!staticToken && !verifyToken) return true; // open (loopback dev)
  if (staticToken && verifyGatewayToken(staticToken, presented)) return true;
  if (verifyToken && presented && verifyToken(presented)) return true;
  return false;
}
