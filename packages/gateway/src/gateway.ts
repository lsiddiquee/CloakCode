import * as http from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import {
  connectionHelloSchema,
  rpcRequestSchema,
  type GatewayInfo,
  type SessionSummary,
} from "@cloakcode/protocol";
import { ProviderRegistry } from "./registry.js";
import { WsProvider } from "./ws-provider.js";
import { Relay } from "./relay.js";
import { contentTypeFor, resolveStaticPath } from "./static-files.js";

export interface GatewayOptions {
  /** Bind address. Defaults to `127.0.0.1` (front it with a tunnel for remote). */
  host?: string;
  /** Port; `0` (default) picks a free ephemeral port. */
  port?: number;
  /** Directory of the built PWA to serve; omit to run WS-only (`426` on GET). */
  serveDir?: string;
}

export interface Gateway {
  readonly port: number;
  readonly registry: ProviderRegistry;
  /**
   * Publish the gateway's phone-reachable URL (the tunnel it owns) to every
   * connected provider, and to any that connect later, so an extension in client
   * mode can render the QR / “Show Phone Link” for the hub. `undefined` clears it.
   */
  setPhoneUrl(url: string | undefined): void;
  close(): Promise<void>;
}

/**
 * The standalone **gateway hub** (docs/03 "Explicit gateway"): serves the PWA
 * and multiplexes phone (**operator**) and extension (**provider**) WebSocket
 * connections on one `/bridge` endpoint, distinguished by a first `provider.hello`
 * frame. Holds **no `vscode`** — providers supply the observer/actuator. Binds
 * loopback; remote reach is via the tunnel the runner owns.
 *
 * M-slice: aggregates `sessions.list` across providers (de-duped). The streaming
 * `session.subscribe` + actuator relay land in the next slice.
 */
export async function startGateway(
  opts: GatewayOptions = {},
): Promise<Gateway> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const serveDir = opts.serveDir;
  const registry = new ProviderRegistry();
  // The hub's phone-reachable URL (its tunnel), pushed to providers as gateway.info.
  // Set by the runner once the tunnel is up (setPhoneUrl); absent until then.
  let phoneUrl: string | undefined;

  const server = http.createServer((req, res) => {
    if (!serveDir) {
      res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
      res.end("CloakCode gateway: WebSocket only");
      return;
    }
    const file = resolveStaticPath(serveDir, req.url ?? "/");
    if (!file) {
      res.writeHead(400).end();
      return;
    }
    readFile(file).then(
      (data) => {
        res.writeHead(200, { "content-type": contentTypeFor(file) });
        res.end(data);
      },
      () => res.writeHead(404).end(),
    );
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });

  const relay = new Relay();
  wss.on("connection", (socket: WebSocket) => {
    // The first frame decides the role: a `provider.hello` marks an extension in
    // client mode; anything else is treated as an operator (the phone/PWA), which
    // then speaks the usual client RPC.
    socket.once("message", (raw) => {
      const text = raw.toString();
      const hello = parseHello(text);
      if (hello?.role === "provider") {
        const provider = new WsProvider(hello.provider.instanceId, socket);
        registry.add(provider);
        // Tell the provider the hub's phone URL so its “Show Phone Link” reflects
        // the gateway's tunnel, not a local bridge it doesn't run (docs/03).
        send(socket, gatewayInfo(phoneUrl));
        socket.on("message", (m) => {
          const frame = m.toString();
          // A provider frame is either a relayed reply for an operator, or a
          // response to a gateway-initiated request (e.g. sessions.list).
          if (!relay.routeProviderFrame(frame)) provider.handleMessage(frame);
        });
        socket.on("close", () => {
          registry.remove(provider);
          provider.dispose();
        });
        return;
      }
      // Operator: wire the RPC handler + process this first frame unless it was
      // just an explicit operator hello; drop its relays when it disconnects.
      socket.on(
        "message",
        (m) => void handleOperator(socket, registry, relay, m.toString()),
      );
      socket.on("close", () => relay.dropOperator(socket));
      if (hello?.role !== "operator") {
        void handleOperator(socket, registry, relay, text);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;

  return {
    port: boundPort,
    registry,
    setPhoneUrl(url) {
      phoneUrl = url;
      const frame = JSON.stringify(gatewayInfo(phoneUrl));
      for (const p of registry.all()) {
        if (p instanceof WsProvider) p.send(frame);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

/** Parse a first frame as a connection hello, or `undefined` if it isn't one. */
function parseHello(
  text: string,
):
  | { role: "operator" }
  | { role: "provider"; provider: { instanceId: string } }
  | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = connectionHelloSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Handle one operator RPC frame: `sessions.list` is aggregated across providers;
 * every other (session-addressed) op is relayed to the owning provider by
 * `instanceId`, with its frames piped back through {@link Relay}.
 */
async function handleOperator(
  socket: WebSocket,
  registry: ProviderRegistry,
  relay: Relay,
  text: string,
): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  const req = rpcRequestSchema.safeParse(json);
  if (!req.success) return;
  const { id, op } = req.data;
  if (op === "sessions.list") {
    let result: SessionSummary[];
    try {
      result = await registry.listSessions();
    } catch {
      result = [];
    }
    send(socket, { id, ok: true, op: "sessions.list", result });
    return;
  }
  const instanceId = (req.data.params as { instanceId?: string }).instanceId;
  const provider = instanceId
    ? registry
        .forInstance(instanceId)
        .find((p): p is WsProvider => p instanceof WsProvider)
    : undefined;
  if (!provider) {
    send(socket, {
      id,
      ok: false,
      error: {
        message: `gateway: no provider for instance '${instanceId ?? "?"}'`,
      },
    });
    return;
  }
  relay.forward(socket, { id, op, params: req.data.params }, (t) =>
    provider.send(t),
  );
}

function send(socket: WebSocket, msg: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

/** Build a gateway.info control frame carrying the phone URL when known. */
function gatewayInfo(phoneUrl: string | undefined): GatewayInfo {
  return { type: "gateway.info", ...(phoneUrl ? { phoneUrl } : {}) };
}
