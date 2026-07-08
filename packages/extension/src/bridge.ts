import { WebSocketServer, type WebSocket } from "ws";
import { rpcRequestSchema, type SessionSummary } from "@cloakcode/protocol";
import { SessionFollower } from "./session-observer.js";

/**
 * The localhost bridge. Binds `127.0.0.1` only (security rule 3) and speaks the
 * `@cloakcode/protocol` RPC. I0 served `sessions.list`; I1 adds the streaming
 * `session.subscribe`. The actuator lands later.
 */

export interface BridgeDeps {
  listSessions: () => Promise<SessionSummary[]>;
  /** Resolve a sessionId to its on-disk transcript path in this environment. */
  findTranscript: (sessionId: string) => Promise<string | undefined>;
}

export interface BridgeOptions {
  /** Localhost only. Do not expose beyond 127.0.0.1 — remote access is via a tunnel. */
  host?: string;
  /** Fixed port for same-host convenience; `0` picks an ephemeral free port. */
  port?: number;
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

interface Connection {
  alive: boolean;
  /** One follower per subscribed sessionId; re-subscribe replaces (dedupe). */
  followers: Map<string, SessionFollower>;
}

export async function startBridge(
  deps: BridgeDeps,
  opts: BridgeOptions = {},
): Promise<Bridge> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 7801;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;

  const wss = new WebSocketServer({ host, port });
  const connections = new Map<WebSocket, Connection>();

  const cleanup = (socket: WebSocket, conn: Connection): void => {
    for (const follower of conn.followers.values()) follower.stop();
    conn.followers.clear();
    connections.delete(socket);
  };

  wss.on("connection", (socket) => {
    const conn: Connection = { alive: true, followers: new Map() };
    connections.set(socket, conn);
    socket.on("pong", () => {
      conn.alive = true;
    });
    socket.on("message", (raw) => {
      void handleMessage(socket, raw.toString(), deps, conn.followers);
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
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  const address = wss.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(heartbeat);
        for (const [socket, conn] of connections) cleanup(socket, conn);
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleMessage(
  socket: WebSocket,
  raw: string,
  deps: BridgeDeps,
  followers: Map<string, SessionFollower>,
): Promise<void> {
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
        const file = await deps.findTranscript(request.params.sessionId);
        if (!file) {
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
          file,
          (event) => {
            socket.send(
              JSON.stringify({
                id: request.id,
                op: "session.subscribe",
                event,
              }),
            );
          },
          request.params.sinceSeq,
        );
        followers.set(request.params.sessionId, follower);
        await follower.start();
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
