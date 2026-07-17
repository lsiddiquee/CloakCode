import * as http from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import {
  rpcRequestSchema,
  DEFAULT_PORT,
  MAX_WS_PAYLOAD_BYTES,
  OPERATOR_MSG_BURST,
  OPERATOR_MSG_RATE_PER_SEC,
  RateLimiter,
  type Decision,
  type Logger,
  type QuestionAnswer,
  type SessionSummary,
} from "@cloakcode/protocol";
import { SessionFollower, type SessionLog } from "./session-observer.js";
import { SpoolFollower } from "./hook-spool.js";
import {
  contentTypeFor,
  listenWithFallback,
  resolveStaticPath,
} from "@cloakcode/gateway";

/**
 * The localhost bridge. Binds `127.0.0.1` only (security rule 3) and speaks the
 * `@cloakcode/protocol` RPC. I0 served `sessions.list`; I1 adds the streaming
 * `session.subscribe`. The actuator lands later.
 */

export interface BridgeDeps {
  listSessions: () => Promise<SessionSummary[]>;
  /**
   * Resolve a sessionId to the best on-disk log to tail (the complete debug-log
   * when present, else the transcript) plus the parser for its format.
   */
  findSessionLog: (sessionId: string) => Promise<SessionLog | undefined>;
  /** Resolve a sessionId to its on-disk transcript path in this environment. */
  findTranscript: (sessionId: string) => Promise<string | undefined>;
  /**
   * Whether the target session is OWNED (actuatable) by this window. Every
   * actuator RPC is gated on it: the web UI hides controls for foreign sessions,
   * but a direct RPC must be rejected here too (defense-in-depth — a
   * remote-operator action must never land in a window that doesn't own the
   * session; docs/04). Unset → no gating (the pure dev-server / tests).
   */
  isOwned?: (sessionId: string) => Promise<boolean>;
  /**
   * Absolute path to the hook spool DIRECTORY (the live-pending source; one
   * file per blocker). When unset, the observer still works fully — there is
   * just no live-pending overlay.
   */
  spoolDir?: string;
  /**
   * Debounce (ms) before a pending tool call is surfaced, so a fast auto-approve
   * never flickers a card. Optional; the follower applies its default when unset.
   * See docs/02 4.20.
   */
  surfaceDebounceMs?: number;
  /**
   * Local structured logger (docs/03). The bridge logs each RPC (`op` + the
   * client `traceId`) and threads the traceId into the actuator so one remote
   * action correlates end-to-end. Unset → the bridge logs nothing.
   */
  logger?: Logger;
  /**
   * Deliver a `remote-operator` answer into the target window (M3b question
   * channel). Provided ONLY by the extension host (it calls
   * `workbench.action.chat.open`); the pure dev-server leaves it unset, so the
   * bridge stays free of `vscode`. Unset → `session.respond` is unsupported.
   */
  respond?: (params: {
    sessionId: string;
    toolCallId?: string;
    text: string;
    traceId?: string;
  }) => Promise<void>;
  /**
   * Record the operator's allow/deny verdict for a held tool call (docs/04) by
   * writing the hook's on-disk decision file. Extension-host only; unset →
   * `session.decide` is unsupported.
   */
  decide?: (params: {
    sessionId: string;
    toolCallId: string;
    decision: Decision;
    traceId?: string;
  }) => Promise<void>;
  /**
   * Deliver the operator's structured answer to a pending `vscode_askQuestions`
   * carousel (docs/02 §4.16) via the extension host's
   * `_chat.notifyQuestionCarouselAnswer`. Extension-host only; unset →
   * `session.answer` is unsupported.
   */
  answer?: (params: {
    sessionId: string;
    toolCallId: string;
    answers: QuestionAnswer[];
    traceId?: string;
  }) => Promise<void>;
  /**
   * Steer the in-flight turn with a `remote-operator` redirect (docs/04): the
   * extension prefills the composer then fires `steerWithMessage` (docs/02
   * §4.28). Extension-host only; unset → `session.steer` is unsupported.
   */
  steer?: (params: {
    sessionId: string;
    text: string;
    traceId?: string;
  }) => Promise<void>;
  /**
   * Stop the in-flight turn (`chat.cancel`); with `text`, then send it as a
   * fresh prompt (stop-and-send). A `remote-operator` action (docs/04).
   * Extension-host only; unset → `session.stop` is unsupported.
   */
  stop?: (params: {
    sessionId: string;
    text?: string;
    traceId?: string;
  }) => Promise<void>;
}

export interface BridgeOptions {
  /** Localhost only. Do not expose beyond 127.0.0.1 — remote access is via a tunnel. */
  host?: string;
  /** Fixed port for same-host convenience; `0` picks an ephemeral free port. */
  port?: number;
  /**
   * When `port` is a specific busy port, fall back to an ephemeral one instead
   * of failing (backs the unset-→-DEFAULT_PORT-then-ephemeral default via
   * `resolvePortPlan`). Off for a locked explicit port.
   */
  fallbackToEphemeral?: boolean;
  /**
   * Directory of the built PWA to serve over plain HTTP on the same port that
   * carries the `/bridge` WebSocket (the packaged gateway). Omit for dev/test —
   * Vite serves the app then, and the bridge answers plain HTTP with `426`.
   */
  serveDir?: string;
  /**
   * Ping/pong liveness interval (ms). A socket that misses a pong is terminated
   * so its followers (and their fs.watch handles) are reclaimed even when the
   * client never sends a close frame (crash, sleep, network/tunnel drop).
   */
  heartbeatMs?: number;
}

export interface Bridge {
  readonly port: number;
  close: () => Promise<void>;
}

export interface Connection {
  alive: boolean;
  /** One follower per subscribed sessionId; re-subscribe replaces (dedupe). */
  followers: Map<string, SessionFollower>;
  /** Live-pending overlay follower, paired 1:1 with `followers`. */
  spoolFollowers: Map<string, SpoolFollower>;
}

/** Stop + clear a connection's followers (subscription teardown). */
export function stopFollowers(conn: Connection): void {
  for (const follower of conn.followers.values()) follower.stop();
  for (const follower of conn.spoolFollowers.values()) follower.stop();
  conn.followers.clear();
  conn.spoolFollowers.clear();
}

export async function startBridge(
  deps: BridgeDeps,
  opts: BridgeOptions = {},
): Promise<Bridge> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? DEFAULT_PORT;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const serveDir = opts.serveDir;

  // One http server: plain GETs serve the built PWA (prod gateway), and the
  // `upgrade` handshake becomes the bridge WebSocket — so a single tunnelled
  // port carries both the app and the live stream (same-origin `/bridge`).
  const server = http.createServer((req, res) => {
    if (!serveDir) {
      res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
      res.end("CloakCode bridge: WebSocket only");
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
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES, // bound a single frame (F2b)
  });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  const connections = new Map<WebSocket, Connection>();

  const cleanup = (socket: WebSocket, conn: Connection): void => {
    stopFollowers(conn);
    connections.delete(socket);
  };

  wss.on("connection", (socket) => {
    const conn: Connection = {
      alive: true,
      followers: new Map(),
      spoolFollowers: new Map(),
    };
    connections.set(socket, conn);
    // Per-connection rate limit: bound a flood of operator frames (F2b).
    const limit = new RateLimiter(
      OPERATOR_MSG_BURST,
      OPERATOR_MSG_RATE_PER_SEC,
    );
    socket.on("pong", () => {
      conn.alive = true;
    });
    socket.on("message", (raw) => {
      if (!limit.take()) {
        deps.logger?.debug("operator.rate_limited");
        return;
      }
      void handleMessage(socket, raw.toString(), deps, conn);
    });
    socket.on("close", () => cleanup(socket, conn));
  });

  // Reap half-open connections: ping the living, terminate the unresponsive.
  const heartbeat = setInterval(() => {
    for (const [socket, conn] of connections) {
      if (!conn.alive) {
        socket.terminate(); // fires 'close' -> cleanup
        continue;
      }
      conn.alive = false;
      socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref(); // never keep the process alive for the heartbeat alone

  const boundPort = await listenWithFallback(
    server,
    host,
    port,
    opts.fallbackToEphemeral ?? false,
  );

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(heartbeat);
        for (const [socket, conn] of connections) {
          cleanup(socket, conn);
          socket.terminate();
        }
        wss.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Best-effort recovery of the client's request `id` from a payload that FAILED
 * full RPC validation, so the error reply still correlates to the pending call
 * on the web client (which keys replies by `id`). Returns `"unknown"` only when
 * the payload is not JSON or carries no string `id`.
 */
export function salvageRequestId(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      return (parsed as { id: string }).id;
    }
  } catch {
    // not JSON at all → fall through to the sentinel
  }
  return "unknown";
}

export async function handleMessage(
  socket: WebSocket,
  raw: string,
  deps: BridgeDeps,
  conn: Connection,
): Promise<void> {
  const { followers, spoolFollowers } = conn;
  let request;
  try {
    request = rpcRequestSchema.parse(JSON.parse(raw));
  } catch {
    socket.send(
      JSON.stringify({
        id: salvageRequestId(raw),
        ok: false,
        error: { message: "invalid request" },
      }),
    );
    return;
  }

  // One structured line per RPC (op + the client traceId), correlating this hop
  // with the web send + the actuator log for the same action.
  deps.logger?.debug("rpc", {
    op: request.op,
    ...(request.traceId !== undefined ? { traceId: request.traceId } : {}),
  });

  // Gate every actuator on ownership: reject an action aimed at a session this
  // window does not own (defense-in-depth beyond the UI hiding the controls).
  const requireOwned = async (sessionId: string): Promise<boolean> => {
    if (!deps.isOwned || (await deps.isOwned(sessionId))) return true;
    socket.send(
      JSON.stringify({
        id: request.id,
        ok: false,
        error: { message: "session is read-only in this window (not owned)" },
      }),
    );
    return false;
  };

  try {
    switch (request.op) {
      case "sessions.list": {
        const result = await deps.listSessions();
        socket.send(
          JSON.stringify({
            id: request.id,
            ok: true,
            op: "sessions.list",
            result,
          }),
        );
        break;
      }
      case "session.subscribe": {
        const log = await deps.findSessionLog(request.params.sessionId);
        if (!log) {
          socket.send(
            JSON.stringify({
              id: request.id,
              ok: false,
              error: { message: "session not found" },
            }),
          );
          break;
        }
        // Dedupe: a re-subscribe for the same session replaces its follower.
        followers.get(request.params.sessionId)?.stop();
        // The transcript carries the turn boundaries (§4.6) even when the
        // conversation is sourced from the debug-log; resolve it once and reuse
        // it for both live turn-tracking and the pending-overlay dedup. Fall
        // back to the conversation log if no transcript exists yet.
        const transcript =
          (await deps.findTranscript(request.params.sessionId)) ?? log.file;
        const follower = new SessionFollower(
          log.file,
          (event) => {
            socket.send(
              JSON.stringify({
                id: request.id,
                op: "session.subscribe",
                kind: "event",
                event,
              }),
            );
          },
          request.params.sinceSeq,
          {
            parse: log.parse,
            turnFile: transcript,
            onTurn: (inTurn) => {
              socket.send(
                JSON.stringify({
                  id: request.id,
                  op: "session.subscribe",
                  kind: "turn",
                  inTurn,
                }),
              );
            },
          },
        );
        followers.set(request.params.sessionId, follower);
        await follower.start();

        // Live-pending overlay (separate replace-snapshot channel). Optional:
        // only when a spool source is configured for this environment.
        spoolFollowers.get(request.params.sessionId)?.stop();
        if (deps.spoolDir) {
          // The pending dedup joins on the TRANSCRIPT's tool ids (its format),
          // independent of which log drives the conversation.
          const spoolFollower = new SpoolFollower(
            deps.spoolDir,
            transcript,
            request.params.sessionId,
            (blockers) => {
              socket.send(
                JSON.stringify({
                  id: request.id,
                  op: "session.subscribe",
                  kind: "pending",
                  blockers,
                }),
              );
            },
            {
              ...(deps.surfaceDebounceMs !== undefined
                ? { debounceMs: deps.surfaceDebounceMs }
                : {}),
            },
          );
          spoolFollowers.set(request.params.sessionId, spoolFollower);
          await spoolFollower.start();
        }
        break;
      }
      case "session.respond": {
        if (!(await requireOwned(request.params.sessionId))) break;
        // A remote-operator answer (docs/04) — delivered via the extension
        // host's `respond` (chat.open). Never treated as genuine-local intent.
        if (!deps.respond) {
          socket.send(
            JSON.stringify({
              id: request.id,
              ok: false,
              error: { message: "answering not supported on this bridge" },
            }),
          );
          break;
        }
        await deps.respond({
          sessionId: request.params.sessionId,
          ...(request.params.toolCallId !== undefined
            ? { toolCallId: request.params.toolCallId }
            : {}),
          text: request.params.text,
          ...(request.traceId !== undefined
            ? { traceId: request.traceId }
            : {}),
        });
        socket.send(
          JSON.stringify({
            id: request.id,
            ok: true,
            op: "session.respond",
          }),
        );
        break;
      }
      case "session.decide": {
        if (!(await requireOwned(request.params.sessionId))) break;
        // A remote-operator allow/deny for a held tool call (docs/04), recorded
        // as the hook's on-disk decision file. Never genuine-local intent.
        if (!deps.decide) {
          socket.send(
            JSON.stringify({
              id: request.id,
              ok: false,
              error: { message: "approvals not supported on this bridge" },
            }),
          );
          break;
        }
        await deps.decide({
          sessionId: request.params.sessionId,
          toolCallId: request.params.toolCallId,
          decision: request.params.decision,
          ...(request.traceId !== undefined
            ? { traceId: request.traceId }
            : {}),
        });
        socket.send(
          JSON.stringify({
            id: request.id,
            ok: true,
            op: "session.decide",
          }),
        );
        break;
      }
      case "session.answer": {
        if (!(await requireOwned(request.params.sessionId))) break;
        // A remote-operator structured answer to a pending question carousel
        // (docs/02 §4.16) — resolves the tool with `{answers}`, never chat text.
        if (!deps.answer) {
          socket.send(
            JSON.stringify({
              id: request.id,
              ok: false,
              error: {
                message: "answering questions not supported on this bridge",
              },
            }),
          );
          break;
        }
        await deps.answer({
          sessionId: request.params.sessionId,
          toolCallId: request.params.toolCallId,
          answers: request.params.answers,
          ...(request.traceId !== undefined
            ? { traceId: request.traceId }
            : {}),
        });
        socket.send(
          JSON.stringify({
            id: request.id,
            ok: true,
            op: "session.answer",
          }),
        );
        break;
      }
      case "session.steer": {
        if (!(await requireOwned(request.params.sessionId))) break;
        // A remote-operator redirect injected INTO the running turn (docs/04),
        // via the extension host's `steer`. Never genuine-local intent.
        if (!deps.steer) {
          socket.send(
            JSON.stringify({
              id: request.id,
              ok: false,
              error: { message: "steering not supported on this bridge" },
            }),
          );
          break;
        }
        await deps.steer({
          sessionId: request.params.sessionId,
          text: request.params.text,
          ...(request.traceId !== undefined
            ? { traceId: request.traceId }
            : {}),
        });
        socket.send(
          JSON.stringify({ id: request.id, ok: true, op: "session.steer" }),
        );
        break;
      }
      case "session.stop": {
        if (!(await requireOwned(request.params.sessionId))) break;
        // A remote-operator cancel (optionally cancel-then-send), via the
        // extension host's `stop`. Never genuine-local intent.
        if (!deps.stop) {
          socket.send(
            JSON.stringify({
              id: request.id,
              ok: false,
              error: { message: "stopping not supported on this bridge" },
            }),
          );
          break;
        }
        await deps.stop({
          sessionId: request.params.sessionId,
          ...(request.params.text !== undefined
            ? { text: request.params.text }
            : {}),
          ...(request.traceId !== undefined
            ? { traceId: request.traceId }
            : {}),
        });
        socket.send(
          JSON.stringify({ id: request.id, ok: true, op: "session.stop" }),
        );
        break;
      }
    }
  } catch (err) {
    socket.send(
      JSON.stringify({
        id: request.id,
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      }),
    );
  }
}
