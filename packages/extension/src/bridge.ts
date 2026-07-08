import { WebSocketServer, type WebSocket } from "ws";
import { rpcRequestSchema, type SessionSummary } from "@cloakcode/protocol";

/**
 * The localhost bridge. Binds `127.0.0.1` only (security rule 3) and speaks the
 * `@cloakcode/protocol` RPC. I0 serves read-only `sessions.list`; later slices
 * add `session.subscribe` and the actuator.
 */

export interface BridgeDeps {
  listSessions: () => Promise<SessionSummary[]>;
}

export interface BridgeOptions {
  /** Localhost only. Do not expose beyond 127.0.0.1 — remote access is via a tunnel. */
  host?: string;
  /** Fixed port for same-host convenience; `0` picks an ephemeral free port. */
  port?: number;
}

export interface Bridge {
  readonly port: number;
  close: () => Promise<void>;
}

export async function startBridge(
  deps: BridgeDeps,
  opts: BridgeOptions = {},
): Promise<Bridge> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 7801;

  const wss = new WebSocketServer({ host, port });
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      void handleMessage(socket, raw.toString(), deps);
    });
  });

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
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleMessage(
  socket: WebSocket,
  raw: string,
  deps: BridgeDeps,
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
