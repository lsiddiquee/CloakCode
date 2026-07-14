import type { NetworkInterfaceInfo } from "node:os";

export interface ConnectUrl {
  /** The `ws://…` value an extension puts in `cloakcode.gatewayUrl`. */
  url: string;
  /** Who this URL is for (a human hint printed next to it). */
  label: string;
}

/**
 * Rank the URLs an extension could use to reach this gateway, from the bind
 * `host`, `port`, and the machine's network `interfaces`. Loopback first (always
 * works for a client on the *same* machine); then every non-internal IPv4 address
 * (LAN / other containers / WSL); plus a `host.docker.internal` hint when bound
 * wide. Pure — the runner prints the list so you can pick the right
 * `cloakcode.gatewayUrl`. When bound to a specific non-loopback address, that one
 * leads.
 */
export function connectionUrls(
  host: string,
  port: number,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): ConnectUrl[] {
  const wide = host === "0.0.0.0" || host === "::" || host === "::0";
  const urls: ConnectUrl[] = [
    { url: `ws://127.0.0.1:${port}`, label: "same machine" },
  ];

  if (wide) {
    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs ?? []) {
        if (addr.family === "IPv4" && !addr.internal) {
          urls.push({
            url: `ws://${addr.address}:${port}`,
            label: `LAN / other containers (${name})`,
          });
        }
      }
    }
    urls.push({
      url: `ws://host.docker.internal:${port}`,
      label: "Docker Desktop containers (if this host runs the gateway)",
    });
  } else if (host !== "127.0.0.1" && host !== "localhost") {
    urls.unshift({
      url: `ws://${host}:${port}`,
      label: "configured bind address",
    });
  }

  return urls;
}
