/**
 * The pre-connect DECISION, computed purely from settings so it is testable
 * without an extension host. The async connect I/O stays in the extension
 * adapter (`extension.ts`); this only decides WHAT to do.
 */
export type ConnectionPlan =
  { kind: "gateway"; url: string } | { kind: "embedded" };

/**
 * Resolve the connection plan from the setting + env. Pure.
 *
 * - `CLOAKCODE_GATEWAY_URL` (env) then `gatewayUrl` (setting), first usable wins
 *   → connect OUT to that standalone gateway. A hostless `ws://:port` is skipped
 *   (an unfilled `${env:HOST_IP}`), so F5 on a non-WSL host still goes embedded.
 * - Else embedded (serve our own PWA + `/bridge`).
 */
export function resolveConnectionPlan(input: {
  gatewayUrl: string | undefined;
  envGatewayUrl?: string | undefined;
}): ConnectionPlan {
  const url =
    usableGatewayUrl(input.envGatewayUrl) ?? usableGatewayUrl(input.gatewayUrl);
  return url ? { kind: "gateway", url } : { kind: "embedded" };
}

/** A trimmed, non-empty `ws(s)://host…` URL (rejects a hostless `ws://:port`). */
function usableGatewayUrl(raw: string | undefined): string | undefined {
  const url = raw?.trim();
  if (!url) return undefined;
  return /^wss?:\/\/[^/:?#]/i.test(url) ? url : undefined;
}
