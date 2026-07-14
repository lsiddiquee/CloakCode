import { WebSocket } from "ws";
import {
  gatewayInfoSchema,
  type GatewayInfo,
  type ProviderInfo,
} from "@cloakcode/protocol";
import {
  handleMessage,
  stopFollowers,
  type BridgeDeps,
  type Connection,
} from "./bridge.js";
import { knockFrame, isGatewayKnock } from "./ws-knock.js";

export interface GatewayClient {
  /** The gateway URL this client connected to (`cloakcode.gatewayUrl`). */
  readonly url: string;
  /** The hub's phone URL if the gateway has pushed one (its tunnel), else undefined. */
  phoneUrl(): string | undefined;
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
    let phoneUrl: string | undefined;
    let socket: WebSocket | undefined;
    let conn: Connection | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const client: GatewayClient = {
      url,
      phoneUrl: () => phoneUrl,
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

      let knocked = false;
      s.on("open", () => {
        attempt = 0;
        // Phase 1: knock with no provider info — the gateway answers only if it
        // is a real CloakCode gateway; only then do we send the full hello.
        s.send(knockFrame("provider"));
      });
      s.on("message", (raw) => {
        const text = raw.toString();
        if (!knocked) {
          if (!isGatewayKnock(text)) {
            log(`gateway: ${url} did not answer the knock`);
            s.close();
            return;
          }
          knocked = true;
          // Phase 2: reveal the full provider hello.
          s.send(JSON.stringify({ type: "hello", role: "provider", provider }));
          log(`gateway: connected as provider (${provider.instanceId})`);
          if (!settled) {
            settled = true;
            clearTimeout(firstTimer);
            resolve(client);
          }
          return;
        }
        // The gateway pushes its phone URL as a `gateway.info` control frame;
        // capture it (so “Show Phone Link” reflects the hub) and don't route it
        // through the RPC handler.
        const info = tryGatewayInfo(text);
        if (info) {
          phoneUrl = info.phoneUrl;
          log(`gateway: phone URL ${phoneUrl ?? "(none yet)"}`);
          return;
        }
        void handleMessage(s, text, deps, c);
      });
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

/** Parse a frame as a gateway.info control message, or undefined if it isn't one. */
function tryGatewayInfo(text: string): GatewayInfo | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = gatewayInfoSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
