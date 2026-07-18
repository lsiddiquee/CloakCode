import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { SessionSummary } from "@cloakcode/protocol";
import {
  connectGateway,
  GatewayAuthRequiredError,
  type GatewayClient,
} from "./gateway-client.js";
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

/** Start a fake gateway that answers the knock, then runs `onProvider` on the hello.
 *  By default it also sends the `gateway.info` registration ack the real gateway
 *  sends on a successful register (the client's connect confirmation); pass
 *  `{ ack: false }` to model a token reject (no ack, gateway drops the socket). */
function startFakeGateway(
  onProvider: (ws: WsSocket, hello: Record<string, unknown>) => void = () => {},
  opts: { ack?: boolean } = {},
): Promise<number> {
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
          if (hello?.role !== "provider") return;
          if (opts.ack !== false) {
            ws.send(JSON.stringify({ type: "gateway.info" }));
          }
          onProvider(ws, hello);
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

  it("rejects (falls back to embedded) when the gateway drops after the hello", async () => {
    // No gateway.info ack + an immediate close models a rejected token: the
    // client must report auth failure, not report "connected" and reconnect-loop.
    const port = await startFakeGateway((ws) => ws.close(), { ack: false });
    await expect(
      connectGateway(
        `ws://127.0.0.1:${port}`,
        { instanceId: "i1" },
        deps,
        () => {},
        2000,
      ),
    ).rejects.toThrow(/rejected the provider/);
  });

  it("rejects with GatewayAuthRequiredError (and prompts) when the gateway needs provider sign-in", async () => {
    // The gateway answers the hello with `provider.auth_required` (no ack): the
    // client must reject with the DISTINCT auth error and fire the sign-in
    // prompt, so the caller can skip the embedded fallback and wait for sign-in.
    const port = await startFakeGateway(
      (ws) => ws.send(JSON.stringify({ type: "provider.auth_required" })),
      { ack: false },
    );
    let prompted = false;
    await expect(
      connectGateway(
        `ws://127.0.0.1:${port}`,
        { instanceId: "i1" },
        deps,
        () => {},
        2000,
        undefined,
        () => {
          prompted = true;
        },
      ),
    ).rejects.toBeInstanceOf(GatewayAuthRequiredError);
    expect(prompted).toBe(true);
  });

  it("presents the provider↔gateway token in its hello when configured", async () => {
    let seen: Record<string, unknown> | undefined;
    const port = await startFakeGateway((_ws, hello) => {
      seen = hello;
    });
    client = await connectGateway(
      `ws://127.0.0.1:${port}`,
      { instanceId: "i1" },
      deps,
      () => {},
      undefined,
      "s3cret",
    );
    await waitFor(() => seen !== undefined);
    expect(seen).toMatchObject({
      role: "provider",
      token: "s3cret",
      provider: { instanceId: "i1" },
    });
  });

  it("omits the token from the hello when none is configured", async () => {
    let seen: Record<string, unknown> | undefined;
    const port = await startFakeGateway((_ws, hello) => {
      seen = hello;
    });
    client = await connectGateway(
      `ws://127.0.0.1:${port}`,
      { instanceId: "i1" },
      deps,
      () => {},
    );
    await waitFor(() => seen !== undefined);
    expect(seen).not.toHaveProperty("token");
  });
});
