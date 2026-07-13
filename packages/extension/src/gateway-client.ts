import { WebSocket } from "ws";
import type { ProviderInfo } from "@cloakcode/protocol";
import {
  handleMessage,
  stopFollowers,
  type BridgeDeps,
  type Connection,
} from "./bridge.js";

export interface GatewayClient {
  close(): void;
}

/**
 * Client mode (docs/03 "Explicit gateway"): connect OUT to a standalone gateway
 * as a **provider** instead of hosting a local bridge. Announces `provider.hello`,
 * then serves the gateway's forwarded RPCs with the *same* per-connection handler
 * the embedded bridge uses (it echoes each `request.id`, which the gateway's relay
 * maps back to the operator). Reconnects with capped backoff on drops.
 *
 * Resolves once the first connection is established, or rejects after
 * `firstConnectTimeoutMs` — so the caller can fall back to the embedded bridge
 * when the hub is unreachable.
 */
export function connectGateway(
  url: string,
  provider: ProviderInfo,
  deps: BridgeDeps,
  log: (line: string) => void,
  firstConnectTimeoutMs = 4000,
): Promise<GatewayClient> {
  return new Promise((resolve, reject) => {
    let closed = false;
    let settled = false;
    let attempt = 0;
    let socket: WebSocket | undefined;
    let conn: Connection | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const client: GatewayClient = {
      close: () => {
        closed = true;
        if (retry) clearTimeout(retry);
        if (conn) stopFollowers(conn);
        socket?.close();
      },
    };

    const firstTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.close();
      reject(new Error(`gateway ${url} unreachable`));
    }, firstConnectTimeoutMs);

    const connect = (): void => {
      const s = new WebSocket(url);
      const c: Connection = {
        alive: true,
        followers: new Map(),
        spoolFollowers: new Map(),
      };
      socket = s;
      conn = c;

      s.on("open", () => {
        attempt = 0;
        s.send(JSON.stringify({ type: "hello", role: "provider", provider }));
        log(`gateway: connected as provider (${provider.instanceId})`);
        if (!settled) {
          settled = true;
          clearTimeout(firstTimer);
          resolve(client);
        }
      });
      s.on("message", (raw) => void handleMessage(s, raw.toString(), deps, c));
      s.on("error", () => {
        /* a 'close' event always follows; handle reconnect there */
      });
      s.on("close", () => {
        stopFollowers(c);
        if (closed) return;
        const delay = Math.min(1000 * 2 ** attempt++, 15_000);
        retry = setTimeout(connect, delay);
      });
    };

    connect();
  });
}
