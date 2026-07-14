/**
 * The pre-connect DECISION, computed purely from settings + env so it is testable
 * without an extension host. The async connect/probe I/O stays in the extension
 * adapter (`extension.ts`); this only decides WHAT to do.
 */
export type ConnectionPlan =
  | { kind: "gateway"; url: string }
  | { kind: "discover"; port: number; hosts: string[] }
  | { kind: "embedded" };

/**
 * Resolve the connection plan from the current settings + env. Pure.
 *
 * - An explicit, non-empty `gatewayUrl` (trimmed) → connect to it directly.
 * - Otherwise discovery runs when `gatewayDiscovery` is on **or** `envHosts`
 *   (`CLOAKCODE_GATEWAY_HOSTS`, comma-separated) supplies any host — the env var
 *   is an explicit "I trust this machine" opt-in (e.g. the dev-container F5 flow
 *   mapping `HOST_IP`). It probes `gatewayHosts` + env hosts (loopback +
 *   `host.docker.internal` are added later by `discoveryProbeUrls`).
 * - Else embedded.
 *
 * An empty/blank env value (e.g. an unset `HOST_IP`) contributes no hosts and
 * does not enable discovery.
 */
export function resolveConnectionPlan(input: {
  gatewayUrl: string | undefined;
  gatewayDiscovery: boolean;
  gatewayPort: number;
  gatewayHosts: string[];
  envHosts: string | undefined;
}): ConnectionPlan {
  const url = input.gatewayUrl?.trim();
  if (url) return { kind: "gateway", url };

  const envHosts = (input.envHosts ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  if (input.gatewayDiscovery || envHosts.length > 0) {
    return {
      kind: "discover",
      port: input.gatewayPort,
      hosts: [...input.gatewayHosts, ...envHosts],
    };
  }
  return { kind: "embedded" };
}
