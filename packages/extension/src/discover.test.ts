import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { discoverGateway } from "./discover.js";

let server: WebSocketServer | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  server = undefined;
});

/**
 * Start a fake WS server on loopback; `onKnock` runs when a probe sends its
 * knock, deciding how the “gateway” replies. Resolves the bound port.
 */
function serve(onKnock: (ws: WebSocket) => void): Promise<number> {
  return new Promise((resolve) => {
    const s = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      const addr = s.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
    server = s;
    s.on("connection", (ws) => ws.once("message", () => onKnock(ws)));
  });
}

describe("discoverGateway", () => {
  it("returns the ws URL of a gateway that answers the knock", async () => {
    const port = await serve((ws) =>
      ws.send(JSON.stringify({ type: "cloakcode.hello", role: "gateway" })),
    );
    expect(await discoverGateway(port, [], 300)).toBe(`ws://127.0.0.1:${port}`);
  });

  it("ignores a WS server that never answers with the gateway knock", async () => {
    const port = await serve((ws) =>
      ws.send(JSON.stringify({ hello: "not a gateway" })),
    );
    expect(await discoverGateway(port, [], 200)).toBeUndefined();
  });

  it("returns undefined when nothing answers", async () => {
    // A loopback port with no listener → the candidate is refused quickly.
    expect(await discoverGateway(59237, [], 200)).toBeUndefined();
  });
});
