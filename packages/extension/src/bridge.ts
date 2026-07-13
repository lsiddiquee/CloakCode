import * as http from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import {
  rpcRequestSchema,
  type Decision,
  type QuestionAnswer,
  type SessionSummary,
} from "@cloakcode/protocol";
import { SessionFollower, type SessionLog } from "./session-observer.js";
import { SpoolFollower } from "./hook-spool.js";
import { contentTypeFor, resolveStaticPath } from "@cloakcode/gateway";

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
   * Deliver a `remote-operator` answer into the target window (M3b question
   * channel). Provided ONLY by the extension host (it calls
   * `workbench.action.chat.open`); the pure dev-server leaves it unset, so the
   * bridge stays free of `vscode`. Unset → `session.respond` is unsupported.
   */
  respond?: (params: {
    sessionId: string;
    toolCallId?: string;
    text: string;
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
  }) => Promise<void>;
}

export interface BridgeOptions {
  /** Localhost only. Do not expose beyond 127.0.0.1 — remote access is via a tunnel. */
  host?: string;
  /** Fixed port for same-host convenience; `0` picks an ephemeral free port. */
  port?: number;
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
  const port = opts.port ?? 7801;
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
  const wss = new WebSocketServer({ noServer: true });
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
    socket.on("pong", () => {
      conn.alive = true;
    });
    socket.on("message", (raw) => {
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;

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
        id: "unknown",
        ok: false,
        error: { message: "invalid request" },
      }),
    );
    return;
  }

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
          { parse: log.parse },
        );
        followers.set(request.params.sessionId, follower);
        await follower.start();

        // Live-pending overlay (separate replace-snapshot channel). Optional:
        // only when a spool source is configured for this environment.
        spoolFollowers.get(request.params.sessionId)?.stop();
        if (deps.spoolDir) {
          // The pending dedup joins on the TRANSCRIPT's tool ids (its format),
          // independent of which log drives the conversation; fall back to the
          // conversation log if no transcript exists (dedup then no-ops).
          const transcript =
            (await deps.findTranscript(request.params.sessionId)) ?? log.file;
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
