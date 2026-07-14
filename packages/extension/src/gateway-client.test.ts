import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { SessionSummary } from "@cloakcode/protocol";
import { connectGateway, type GatewayClient } from "./gateway-client.js";
import type { BridgeDeps } from "./bridge.js";

const deps: BridgeDeps = {
  listSessions: async () => [] as SessionSummary[],
  findTranscript: async () => undefined,
  findSessionLog: async () => undefined,
};

let server: WebSocketServer | undefined;
let client: GatewayClient | undefined;

afterEach(() => {
  client?.close();
  client = undefined;
  server?.close();
  server = undefined;
});

/** Start a fake gateway that answers the knock, then runs `onProvider` on the hello. */
function startFakeGateway(onProvider: (ws: WsSocket) => void): Promise<number> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
    server = wss;
    wss.on("connection", (ws) => {
      ws.once("message", (raw) => {
        const knock = JSON.parse(raw.toString());
        if (knock?.type !== "cloakcode.hello" || knock?.role !== "provider")
          return;
        ws.send(JSON.stringify({ type: "cloakcode.hello", role: "gateway" }));
        ws.once("message", (raw2) => {
          const hello = JSON.parse(raw2.toString());
          if (hello?.role === "provider") onProvider(ws);
        });
      });
    });
  });
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("connectGateway", () => {
  it("connects as a provider and exposes the gateway url", async () => {
    const port = await startFakeGateway(() => {});
    const url = `ws://127.0.0.1:${port}`;
    client = await connectGateway(url, { instanceId: "i1" }, deps, () => {});
    expect(client.url).toBe(url);
    expect(client.phoneUrl()).toBeUndefined();
  });

  it("captures the gateway.info phone URL the hub pushes down", async () => {
    const phoneUrl = "https://hub-7900.euw.devtunnels.ms";
    const port = await startFakeGateway((ws) => {
      ws.send(JSON.stringify({ type: "gateway.info", phoneUrl }));
    });
    client = await connectGateway(
      `ws://127.0.0.1:${port}`,
      { instanceId: "i1" },
      deps,
      () => {},
    );
    await waitFor(() => client!.phoneUrl() === phoneUrl);
    expect(client.phoneUrl()).toBe(phoneUrl);
  });

  it("rejects when the gateway is unreachable (first-connect timeout)", async () => {
    await expect(
      connectGateway(
        "ws://127.0.0.1:1",
        { instanceId: "i1" },
        deps,
        () => {},
        200,
      ),
    ).rejects.toThrow(/unreachable/);
  });
});
