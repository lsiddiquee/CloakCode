import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import {
  cloakcodeHelloSchema,
  connectionHelloSchema,
  isAllowedUpgrade,
  MAX_WS_PAYLOAD_BYTES,
  OPERATOR_MSG_BURST,
  OPERATOR_MSG_RATE_PER_SEC,
  RateLimiter,
  rpcRequestSchema,
  type CloakcodeHello,
  type GatewayConnectInfo,
  type GatewayInfo,
  type Logger,
  type SessionSummary,
} from "@cloakcode/protocol";
import { ProviderRegistry } from "./registry.js";
import { WsProvider } from "./ws-provider.js";
import { Relay } from "./relay.js";
import { contentTypeFor, resolveStaticPath } from "./static-files.js";
import { connectionUrls } from "./connect-urls.js";
import { listenWithFallback } from "./listen.js";
import { silentLogger } from "./console-logger.js";
import { verifyProviderCredential } from "./auth.js";
import { OperatorGate, type OperatorAuth } from "./operator-auth.js";

export interface GatewayOptions {
  /**
   * Bind address of the **operator listener** (the PWA over HTTP + the operator/
   * phone WebSocket). Defaults to `127.0.0.1` — front it with the tunnel for
   * remote reach. Operators ONLY: a provider that knocks here is refused (it must
   * use the dedicated provider listener below).
   */
  host?: string;
  /** Operator-listener port; `0` (default) picks a free ephemeral port. */
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
  /**
   * Operator app-layer auth (docs/04, F2a). When set, every **operator** (phone)
   * connection must authenticate with a TOTP code (or a resumed session token)
   * via the `auth` op before any session RPC is served. Omit to disable — the
   * loopback-only default; slice-3 wiring enables it whenever the hub is exposed.
   */
  operatorAuth?: OperatorAuth;
  /**
   * Display name of this gateway — its instance id (`CLOAKCODE_INSTANCE_ID`, else
   * the machine hostname; {@link resolveInstanceId}). Returned to the operator in
   * the `sessions.list` response so the phone can show *which* gateway it's on
   * (e.g. office vs home). Omit for the embedded bridge.
   */
  instanceId?: string;
  /**
   * The dedicated **provider listener** — the endpoint extensions connect to
   * (docs/04 role split). ALWAYS bound (providers never share the operator
   * listener). Serves `wss://` when `tls` is supplied (the default the runner
   * always provides — a BYO or auto-generated cert), else an **insecure** plain
   * `ws://` (an explicit opt-in, warned in the console + UI). Providers ONLY: an
   * operator/PWA connection here is refused. Material comes from
   * {@link resolveTlsMaterial}.
   */
  provider?: {
    /** Provider-listener bind; default `127.0.0.1` (the runner sets `0.0.0.0`). */
    host?: string;
    /** Provider-listener port; `0` (default) picks a free ephemeral port. */
    port?: number;
    /** Fall back to an ephemeral port if `port` is busy. */
    fallbackToEphemeral?: boolean;
    /** wss material; omit for an INSECURE plain-`ws://` provider listener. */
    tls?: {
      /** PEM certificate served to providers. */
      cert: string;
      /** PEM private key — a secret; never logged. */
      key: string;
      /** SHA-256 fingerprint of the cert (the pin), surfaced to the operator. */
      fingerprint: string;
    };
  };
}

export interface Gateway {
  /** Bound port of the operator listener (PWA + operator WebSocket). */
  readonly port: number;
  /** Bound port of the dedicated provider listener (always present). */
  readonly providerPort: number;
  /** True when the provider listener is an INSECURE plain `ws://` (no TLS). */
  readonly providerInsecure: boolean;
  /** SHA-256 cert fingerprint (the pin) when the provider listener is `wss://`. */
  readonly fingerprint?: string;
  readonly registry: ProviderRegistry;
  /**
   * Publish the gateway's phone-reachable URL (the tunnel it owns) to every
   * connected provider, and to any that connect later, so an extension in client
   * mode can render the QR / “Show Phone Link” for the hub. `undefined` clears it.
   */
  setPhoneUrl(url: string | undefined): void;
  close(): Promise<void>;
}

/** Which role-scoped listener a WebSocket upgrade arrived on. */
type ConnectionRole = "operator" | "provider";

/**
 * The standalone **gateway hub** (docs/03 "Explicit gateway"): serves the PWA
 * and hosts TWO role-scoped WebSocket listeners (docs/04 role split) — an
 * **operator** listener (loopback HTTP + the phone WebSocket) and a dedicated,
 * always-on **provider** listener (extensions, `wss://` by default). Each refuses
 * the other role, so a provider never rides the operator bind and vice-versa.
 * Holds **no `vscode`** — providers supply the observer/actuator. The operator
 * bind is loopback; remote reach is via the tunnel the runner owns.
 *
 * M-slice: aggregates `sessions.list` across providers (de-duped). The streaming
 * `session.subscribe` + actuator relay land in the next slice.
 */
export async function startGateway(
  opts: GatewayOptions = {},
): Promise<Gateway> {
  const operatorHost = opts.host ?? "127.0.0.1";
  const operatorPort = opts.port ?? 0;
  const providerHost = opts.provider?.host ?? "127.0.0.1";
  const providerTls = opts.provider?.tls;
  const serveDir = opts.serveDir;
  const logger = opts.logger ?? silentLogger();
  const registry = new ProviderRegistry();
  // The hub's phone-reachable URL (its tunnel), pushed to providers as gateway.info.
  // Set by the runner once the tunnel is up (setPhoneUrl); absent until then.
  let phoneUrl: string | undefined;
  // Connect-info the authenticated operator fetches to pair an extension with the
  // provider listener (C4). Populated after that listener binds (a `let` so the
  // post-bind value is visible to the operator handler).
  let connectInfo: GatewayConnectInfo = {
    available: false,
    urls: [],
    insecure: false,
  };

  const requestListener = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    if (!serveDir) {
      res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
      res.end("CloakCode gateway: WebSocket only");
      return;
    }
    const resolved = resolveStaticPath(serveDir, req.url ?? "/");
    if (!resolved) {
      res.writeHead(400).end();
      return;
    }
    // Re-assert containment at the sink with the path.relative idiom so static
    // analysis sees the traversal barrier resolveStaticPath already enforces.
    const root = path.resolve(serveDir);
    const file = path.resolve(root, resolved);
    const rel = path.relative(root, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
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
  };

  const wsOnlyListener = (
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
    res.end("CloakCode gateway: provider WebSocket only");
  };

  // The OPERATOR listener: PWA over HTTP + the operator (phone) WebSocket. The
  // PROVIDER listener is WebSocket-only (extensions never fetch the PWA) and is
  // `wss://` when provider TLS material is supplied, else an insecure plain `ws://`.
  const operatorServer = http.createServer(requestListener);
  const providerServer = providerTls
    ? https.createServer(
        { cert: providerTls.cert, key: providerTls.key },
        wsOnlyListener,
      )
    : http.createServer(wsOnlyListener);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES, // bound a single frame (F2b)
  });
  // Per-listener upgrade gate. The origin/host check (S1) is shared; the ROLE is
  // fixed by WHICH listener the upgrade arrived on — so a provider can never be
  // served on the operator bind, nor an operator on the provider bind.
  const upgradeHandler =
    (role: ConnectionRole) =>
    (
      req: http.IncomingMessage,
      socket: import("node:stream").Duplex,
      head: Buffer,
    ): void => {
      if (
        !isAllowedUpgrade({
          origin: req.headers.origin,
          host: req.headers.host,
          // The gateway's own tunnel URL (set once the tunnel is up) is trusted,
          // so the tunnelled PWA is allowed even if the tunnel rewrites `Host`.
          allowedOrigins: phoneUrl ? [phoneUrl] : [],
        })
      ) {
        socket.destroy(); // cross-site WS attempt (S1) — refuse the handshake
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Role is fixed by the listener — dispatch directly (no shared
        // "connection" multiplexing), so neither role can leak onto the other bind.
        if (role === "provider") handleProviderConnection(ws);
        else handleOperatorConnection(ws);
      });
    };
  operatorServer.on("upgrade", upgradeHandler("operator"));
  providerServer.on("upgrade", upgradeHandler("provider"));

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
    // Provider↔gateway auth: the extension presents a credential in its hello —
    // a TOTP-issued session token (the default, from a code entered once in VS
    // Code) and/or the static shared secret (the demoted escape hatch). Rejected
    // before it can register. When neither is configured it's open (loopback dev).
    // On reject, signal `provider.auth_required` so the extension prompts + retries
    // instead of reconnect-looping (docs/04, F2a slice 2).
    if (
      !verifyProviderCredential(hello.token, {
        staticToken: opts.token,
        verifyToken: opts.operatorAuth
          ? // A provider must present a PROVIDER-scoped token (drift audit S3) —
            // an operator token is rejected here.
            (t) => opts.operatorAuth!.verifyToken(t, "provider")
          : undefined,
      })
    ) {
      logger.warn("provider.auth_reject");
      send(socket, { type: "provider.auth_required" });
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
      if (!relay.routeProviderFrame(frame, provider))
        provider.handleMessage(frame);
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

  // A connection on the PROVIDER listener: the first frame MUST be a provider
  // knock; anything else (an operator RPC, a browser, garbage) is refused — this
  // listener serves providers ONLY.
  function handleProviderConnection(socket: WebSocket): void {
    socket.once("message", (raw) => {
      const knock = parseKnock(raw.toString());
      if (knock?.role !== "provider") {
        logger.debug("provider.reject_non_provider");
        socket.close(); // provider listener: only providers may connect
        return;
      }
      send(socket, cloakcodeHello("gateway")); // answer the knock, no payload
      socket.once("message", (m) => addProvider(m.toString(), socket));
    });
  }

  // A connection on the OPERATOR listener: an operator (phone/PWA) may knock,
  // else its first frame is a normal RPC (the embedded bridge never knocks). A
  // provider knock here is refused — providers must use the provider listener
  // (docs/04 role split; removes the old provider-on-operator-bind duplication).
  function handleOperatorConnection(socket: WebSocket): void {
    // Stay SILENT until we hear a valid first frame: a scanner that connects and
    // says nothing — or sends garbage — learns nothing. The phone URL is never
    // revealed to an unidentified peer.
    socket.once("message", (raw) => {
      const first = raw.toString();
      const knock = parseKnock(first);
      if (knock?.role === "provider") {
        logger.debug("operator.reject_provider");
        socket.close(); // operator listener: no providers here
        return;
      }
      logger.info("operator.connect");
      // Per-connection rate limit: bound a flood of operator frames (F2b).
      const opLimit = new RateLimiter(
        OPERATOR_MSG_BURST,
        OPERATOR_MSG_RATE_PER_SEC,
      );
      // Per-connection auth gate (F2a). Open when operatorAuth is unset.
      const gate = new OperatorGate(opts.operatorAuth);
      const onOperatorFrame = (frame: string): void => {
        if (!opLimit.take()) {
          logger.debug("operator.rate_limited");
          return;
        }
        void handleOperator(
          socket,
          registry,
          relay,
          frame,
          logger,
          gate,
          opts.instanceId,
          connectInfo,
        );
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
  }

  const operatorBoundPort = await listenWithFallback(
    operatorServer,
    operatorHost,
    operatorPort,
    opts.fallbackToEphemeral ?? false,
  );

  // Bind the provider listener after the operator one so a provider-side failure
  // never takes down the (proven) tunnelled-PWA path.
  const providerBoundPort = await listenWithFallback(
    providerServer,
    providerHost,
    opts.provider?.port ?? 0,
    opts.provider?.fallbackToEphemeral ?? false,
  );

  // Connect-info the authenticated operator (PWA) fetches to pair an extension
  // with the provider listener (C4). All public — the fingerprint is a pin, the
  // cert is public; the key is never included. When the provider listener is an
  // insecure plain `ws://` there is no cert/fingerprint (the operator is warned
  // separately) and the URLs keep the `ws://` scheme.
  connectInfo = {
    available: true,
    insecure: !providerTls,
    urls: connectionUrls(
      providerHost,
      providerBoundPort,
      networkInterfaces(),
    ).map(({ url }) => (providerTls ? url.replace(/^ws:/i, "wss:") : url)),
    ...(providerTls
      ? { fingerprint: providerTls.fingerprint, certPem: providerTls.cert }
      : {}),
  };

  return {
    port: operatorBoundPort,
    providerPort: providerBoundPort,
    providerInsecure: !providerTls,
    ...(providerTls ? { fingerprint: providerTls.fingerprint } : {}),
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
        wss.close(() => {
          operatorServer.close(() => {
            providerServer.close(() => resolve());
          });
        });
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
  gate: OperatorGate,
  instanceId?: string,
  connectInfo?: GatewayConnectInfo,
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
  // Operator app-layer auth gate (F2a): until this connection authenticates, the
  // `auth` op is processed here and every other op is refused with `needsAuth`.
  // No-op (always "proceed") when operatorAuth is unset.
  const decision = gate.check(req.data);
  if (decision.kind !== "proceed") {
    send(socket, decision.response);
    if (decision.kind === "close") {
      logger.warn("operator.auth_lockout");
      socket.close();
    }
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
    send(socket, {
      id,
      ok: true,
      op: "sessions.list",
      result,
      ...(instanceId ? { gateway: instanceId } : {}),
    });
    logger.debug("rpc.sessions_list", { sessions: result.length });
    return;
  }
  if (op === "gateway.connectInfo") {
    // How to pair an EXTENSION with this gateway's wss provider listener (C4).
    // Served only after the operator gate passed above; all fields are public.
    send(socket, {
      id,
      ok: true,
      op: "gateway.connectInfo",
      result: connectInfo ?? { available: false, urls: [] },
    });
    logger.debug("rpc.connect_info", {
      available: connectInfo?.available ?? false,
    });
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
