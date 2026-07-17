import * as http from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import {
  cloakcodeHelloSchema,
  connectionHelloSchema,
  MAX_WS_PAYLOAD_BYTES,
  OPERATOR_MSG_BURST,
  OPERATOR_MSG_RATE_PER_SEC,
  RateLimiter,
  rpcRequestSchema,
  type CloakcodeHello,
  type GatewayInfo,
  type Logger,
  type SessionSummary,
} from "@cloakcode/protocol";
import { ProviderRegistry } from "./registry.js";
import { WsProvider } from "./ws-provider.js";
import { Relay } from "./relay.js";
import { contentTypeFor, resolveStaticPath } from "./static-files.js";
import { listenWithFallback } from "./listen.js";
import { silentLogger } from "./console-logger.js";
import { verifyGatewayToken } from "./auth.js";

export interface GatewayOptions {
  /** Bind address. Defaults to `127.0.0.1` (front it with a tunnel for remote). */
  host?: string;
  /** Port; `0` (default) picks a free ephemeral port. */
  port?: number;
  /**
   * When `port` is a specific busy port, fall back to an ephemeral one instead
   * of failing (backs the unset-→-DEFAULT_PORT-then-ephemeral default via
   * `resolvePortPlan`). Off for a locked explicit port.
   */
  fallbackToEphemeral?: boolean;
  /** Directory of the built PWA to serve; omit to run WS-only (`426` on GET). */
  serveDir?: string;
  /**
   * Structured logger (the ILogger-style port, docs/03). The runner injects a
   * console-backed one; omit to stay silent (tests/embeds). Per-RPC detail is
   * logged at `debug` — raise the level to see it.
   */
  logger?: Logger;
  /**
   * Shared secret for the **provider↔gateway** link: an extension must present
   * it in its `provider` hello to register. Machine-to-machine only — never
   * exchanged with or shown to the operator (phone), whose auth is a separate
   * concern (docs/05 Q9). Omit (or empty) to disable — the loopback-dev default.
   * Verified timing-safe. A shared token is right-sized for a gateway you run;
   * mTLS is a post-MVP hardening (docs/04).
   */
  token?: string;
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
  const logger = opts.logger ?? silentLogger();
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
      (err: NodeJS.ErrnoException) => {
        // Missing file → 404; a real read error (permission/IO) → 500.
        res.writeHead(err?.code === "ENOENT" ? 404 : 500).end();
      },
    );
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES, // bound a single frame (F2b)
  });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });

  const relay = new Relay();

  // Register a provider once it completes the knock + full hello. We only reach
  // here after answering the provider's knock, so no provider info was exchanged
  // with a non-CloakCode peer.
  const addProvider = (text: string, socket: WebSocket): void => {
    const hello = parseHello(text);
    if (hello?.role !== "provider") {
      logger.debug("provider.hello_missing");
      socket.close(); // knocked as a provider but didn't complete the hello
      return;
    }
    // Provider↔gateway auth: the extension presents the shared secret in its
    // hello (machine-to-machine, never operator-facing). Rejected before it can
    // register or serve any RPC. No-op when no token is configured (loopback dev).
    if (!verifyGatewayToken(opts.token, hello.token)) {
      logger.warn("provider.auth_reject");
      socket.close();
      return;
    }
    const instanceId = hello.provider.instanceId;
    const provider = new WsProvider(instanceId, socket);
    registry.add(provider);
    logger.info("provider.connect", {
      instanceId,
      providers: registry.all().length,
    });
    // Tell the provider the hub's phone URL so its “Show Phone Link” reflects the
    // gateway's tunnel, not a local bridge it doesn't run (docs/03).
    send(socket, gatewayInfo(phoneUrl));
    socket.on("message", (m) => {
      const frame = m.toString();
      // A provider frame is either a relayed reply for an operator, or a response
      // to a gateway-initiated request (e.g. sessions.list).
      if (!relay.routeProviderFrame(frame)) provider.handleMessage(frame);
    });
    socket.on("close", () => {
      registry.remove(provider);
      relay.dropProvider(provider);
      provider.dispose();
      logger.info("provider.disconnect", {
        instanceId,
        providers: registry.all().length,
      });
    });
  };

  wss.on("connection", (socket: WebSocket) => {
    // Stay SILENT until we hear a valid knock (`cloakcode.hello`): a scanner that
    // connects and says nothing — or sends garbage — learns nothing. A `provider`
    // MUST knock (then we await its full hello); an `operator` (phone/PWA) may
    // knock, else its first frame is a normal RPC (the embedded bridge never
    // knocks). The phone URL is never revealed before a provider has identified.
    socket.once("message", (raw) => {
      const first = raw.toString();
      const knock = parseKnock(first);
      if (knock?.role === "provider") {
        send(socket, cloakcodeHello("gateway")); // answer the knock, no payload
        socket.once("message", (m) => addProvider(m.toString(), socket));
        return;
      }
      // Operator path: ack an operator knock, else treat the first frame as RPC.
      logger.info("operator.connect");
      // Per-connection rate limit: bound a flood of operator frames (F2b).
      const opLimit = new RateLimiter(
        OPERATOR_MSG_BURST,
        OPERATOR_MSG_RATE_PER_SEC,
      );
      const onOperatorFrame = (frame: string): void => {
        if (!opLimit.take()) {
          logger.debug("operator.rate_limited");
          return;
        }
        void handleOperator(socket, registry, relay, frame, logger);
      };
      socket.on("message", (m) => onOperatorFrame(m.toString()));
      socket.on("close", () => {
        relay.dropOperator(socket);
        logger.info("operator.disconnect");
      });
      if (knock?.role === "operator") {
        send(socket, cloakcodeHello("gateway"));
      } else {
        onOperatorFrame(first);
      }
    });
  });

  const boundPort = await listenWithFallback(
    server,
    host,
    port,
    opts.fallbackToEphemeral ?? false,
  );

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
function parseHello(text: string):
  | { role: "operator" }
  | {
      role: "provider";
      provider: { instanceId: string };
      token?: string | undefined;
    }
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

/** Parse a first frame as a minimal CloakCode knock, or undefined if it isn't one. */
function parseKnock(text: string): CloakcodeHello | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = cloakcodeHelloSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Build the gateway's minimal knock frame (its answer to a client's knock). */
function cloakcodeHello(role: CloakcodeHello["role"]): CloakcodeHello {
  return { type: "cloakcode.hello", role };
}

/**
 * Handle one operator RPC frame: `sessions.list` is aggregated across providers;
 * every other (session-addressed) op is relayed to the owning provider by
 * `sessionId` (learned from the aggregated list), with its frames piped back
 * through {@link Relay}.
 */
async function handleOperator(
  socket: WebSocket,
  registry: ProviderRegistry,
  relay: Relay,
  text: string,
  logger: Logger,
): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return; // not even JSON — nothing to correlate an error to
  }
  const req = rpcRequestSchema.safeParse(json);
  if (!req.success) {
    // Never silently drop a well-formed-but-invalid request: a schema mismatch
    // (e.g. a client built against a different protocol version than this
    // gateway) must surface as an error, not hang the operator forever on
    // "Loading…". Correlate it to the request id when the frame carried one.
    const badId = (json as { id?: unknown } | null)?.id;
    if (typeof badId === "string") {
      send(socket, {
        id: badId,
        ok: false,
        error: { message: "gateway: invalid request (protocol mismatch?)" },
      });
    }
    logger.debug("rpc.invalid");
    return;
  }
  const { id, op } = req.data;
  if (op === "sessions.list") {
    let result: SessionSummary[];
    try {
      result = await registry.listSessions();
    } catch {
      result = [];
    }
    send(socket, { id, ok: true, op: "sessions.list", result });
    logger.debug("rpc.sessions_list", { sessions: result.length });
    return;
  }
  // Route by sessionId: the gateway learned each session's owning provider from
  // the aggregated list. instanceId is a display label only and is NOT used here.
  const sessionId = (req.data.params as { sessionId?: string }).sessionId;
  let owner = sessionId ? registry.providerForSession(sessionId) : undefined;
  if (!owner && sessionId) {
    // Cold start / a session created since the last list: refresh ownership once.
    await registry.listSessions().catch(() => []);
    owner = registry.providerForSession(sessionId);
  }
  const provider = owner instanceof WsProvider ? owner : undefined;
  if (!provider) {
    send(socket, {
      id,
      ok: false,
      error: {
        message: `gateway: no provider for session '${sessionId ?? "?"}'`,
      },
    });
    logger.warn("rpc.no_provider", { op, sessionId: sessionId ?? "?" });
    return;
  }
  logger.debug("rpc.relay", {
    op,
    sessionId: sessionId ?? "?",
    ...(req.data.traceId !== undefined ? { traceId: req.data.traceId } : {}),
  });
  relay.forward(
    socket,
    {
      id,
      op,
      params: req.data.params,
      ...(req.data.traceId !== undefined ? { traceId: req.data.traceId } : {}),
    },
    provider,
    (t) => provider.send(t),
  );
}

function send(socket: WebSocket, msg: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

/** Build a gateway.info control frame carrying the phone URL when known. */
function gatewayInfo(phoneUrl: string | undefined): GatewayInfo {
  return { type: "gateway.info", ...(phoneUrl ? { phoneUrl } : {}) };
}
