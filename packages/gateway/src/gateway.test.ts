import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { startGateway, type Gateway } from "./gateway.js";
import type { SessionSummary } from "@cloakcode/protocol";

let gw: Gateway | undefined;

afterEach(async () => {
  await gw?.close();
  gw = undefined;
});

function summary(
  instanceId: string,
  sessionId: string,
  owned = false,
): SessionSummary {
  return {
    instanceId,
    sessionId,
    workspace: "repo",
    workspaceHash: "h",
    title: "t",
    turns: 1,
    status: "idle",
    idleSeconds: 0,
    owned,
  };
}

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) =>
    ws.once("message", (m) => resolve(JSON.parse(m.toString()))),
  );
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A fake provider: registers as `instanceId` and answers sessions.list. */
function fakeProvider(
  ws: WebSocket,
  instanceId: string,
  sessions: SessionSummary[],
): void {
  ws.send(
    JSON.stringify({
      type: "hello",
      role: "provider",
      provider: { instanceId },
    }),
  );
  ws.on("message", (raw) => {
    const req = JSON.parse(raw.toString());
    if (req.op === "sessions.list") {
      ws.send(
        JSON.stringify({
          id: req.id,
          ok: true,
          op: "sessions.list",
          result: sessions,
        }),
      );
    }
  });
}

describe("startGateway", () => {
  it("aggregates sessions.list across providers, de-duped (owned wins)", async () => {
    gw = await startGateway({ port: 0 });
    const url = `ws://127.0.0.1:${gw.port}`;

    const a = await open(url);
    fakeProvider(a, "i1", [summary("i1", "s1", true), summary("i1", "s2")]);
    const b = await open(url);
    fakeProvider(b, "i1", [summary("i1", "s1", false)]); // dup of s1, read-only

    await waitFor(() => gw!.registry.forInstance("i1").length === 2);

    const operator = await open(url);
    operator.send(JSON.stringify({ id: "1", op: "sessions.list", params: {} }));
    const res = await nextMessage(operator);

    expect(res["ok"]).toBe(true);
    const result = res["result"] as SessionSummary[];
    expect(result).toHaveLength(2); // s1 (de-duped) + s2
    expect(result.find((s) => s.sessionId === "s1")?.owned).toBe(true);

    a.close();
    b.close();
    operator.close();
  });

  it("drops a provider from the registry when it disconnects", async () => {
    gw = await startGateway({ port: 0 });
    const url = `ws://127.0.0.1:${gw.port}`;
    const a = await open(url);
    fakeProvider(a, "i9", []);
    await waitFor(() => gw!.registry.forInstance("i9").length === 1);
    a.close();
    await waitFor(() => gw!.registry.forInstance("i9").length === 0);
    expect(gw!.registry.all()).toHaveLength(0);
  });

  it("relays session.subscribe to the owning provider and pipes frames back", async () => {
    gw = await startGateway({ port: 0 });
    const url = `ws://127.0.0.1:${gw.port}`;
    const p = await open(url);
    p.send(
      JSON.stringify({
        type: "hello",
        role: "provider",
        provider: { instanceId: "i1" },
      }),
    );
    p.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.op === "session.subscribe") {
        // Echo one event frame back with the SAME (relay) id the gateway sent.
        p.send(
          JSON.stringify({
            id: req.id,
            op: "session.subscribe",
            kind: "event",
            event: {
              type: "append",
              seq: 0,
              part: { kind: "markdown", id: "m1", text: "hi" },
            },
          }),
        );
      }
    });
    await waitFor(() => gw!.registry.forInstance("i1").length === 1);

    const operator = await open(url);
    operator.send(
      JSON.stringify({
        id: "op-1",
        op: "session.subscribe",
        params: { instanceId: "i1", sessionId: "s1", sinceSeq: 0 },
      }),
    );
    const frame = await nextMessage(operator);
    expect(frame["id"]).toBe("op-1"); // rewritten back to the operator's id
    expect(frame["kind"]).toBe("event");

    p.close();
    operator.close();
  });

  it("errors when no provider serves the requested instance", async () => {
    gw = await startGateway({ port: 0 });
    const operator = await open(`ws://127.0.0.1:${gw.port}`);
    operator.send(
      JSON.stringify({
        id: "9",
        op: "session.subscribe",
        params: { instanceId: "ghost", sessionId: "s1", sinceSeq: 0 },
      }),
    );
    const res = await nextMessage(operator);
    expect(res["ok"]).toBe(false);
    operator.close();
  });
});
