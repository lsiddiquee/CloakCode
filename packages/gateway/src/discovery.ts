/**
 * WebSocket URLs (`ws://host:port`) an extension should probe to auto-find a
 * gateway, given the gateway `port` and any user-configured `extraHosts`. Only
 * known-local candidates are built in: loopback (`127.0.0.1` — same host, and
 * host↔WSL via localhost forwarding) and `host.docker.internal` (a container
 * reaching the host). Cross-namespace cases (WSL↔container) aren't guessable, so
 * pass those hosts via `extraHosts` or set `cloakcode.gatewayUrl` explicitly. The
 * extension connects to each in order and keeps the first that identifies itself
 * with a `gateway.info` frame — no separate discovery API. Pure; order-stable and
 * de-duped.
 */
export function discoveryProbeUrls(
  port: number,
  extraHosts: string[] = [],
): string[] {
  const hosts = ["127.0.0.1", "host.docker.internal", ...extraHosts];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of hosts) {
    const host = raw.trim();
    if (host && !seen.has(host)) {
      seen.add(host);
      urls.push(`ws://${host}:${port}`);
    }
  }
  return urls;
}
