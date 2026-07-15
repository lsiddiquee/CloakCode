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

/** Open a socket and complete the provider knock + full hello handshake. */
async function openProvider(
  url: string,
  instanceId: string,
): Promise<WebSocket> {
  const ws = await open(url);
  ws.send(JSON.stringify({ type: "cloakcode.hello", role: "provider" }));
  await nextMessage(ws); // the gateway's answering knock
  ws.send(
    JSON.stringify({
      type: "hello",
      role: "provider",
      provider: { instanceId },
    }),
  );
  return ws;
}

/** A fake provider: completes the handshake, then answers sessions.list. */
async function fakeProvider(
  url: string,
  instanceId: string,
  sessions: SessionSummary[],
): Promise<WebSocket> {
  const ws = await openProvider(url, instanceId);
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
  return ws;
}

describe("startGateway", () => {
  it("aggregates sessions.list across providers, de-duped (owned wins)", async () => {
    gw = await startGateway({ port: 0 });
    const url = `ws://127.0.0.1:${gw.port}`;

    const a = await fakeProvider(url, "i1", [
      summary("i1", "s1", true),
      summary("i1", "s2"),
    ]);
    const b = await fakeProvider(url, "i1", [summary("i1", "s1", false)]); // dup of s1, read-only

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
    const a = await fakeProvider(url, "i9", []);
    await waitFor(() => gw!.registry.forInstance("i9").length === 1);
    a.close();
    await waitFor(() => gw!.registry.forInstance("i9").length === 0);
    expect(gw!.registry.all()).toHaveLength(0);
  });

  it("relays session.subscribe to the owning provider (routed by sessionId)", async () => {
    gw = await startGateway({ port: 0 });
    const url = `ws://127.0.0.1:${gw.port}`;
    const p = await openProvider(url, "i1");
    p.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.op === "sessions.list") {
        // The gateway learns ownership from the list, then routes RPCs by id.
        p.send(
          JSON.stringify({
            id: req.id,
            ok: true,
            op: "sessions.list",
            result: [summary("i1", "s1", true)],
          }),
        );
      } else if (req.op === "session.subscribe") {
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
        params: { sessionId: "s1", sinceSeq: 0 },
      }),
    );
    const frame = await nextMessage(operator);
    expect(frame["id"]).toBe("op-1"); // rewritten back to the operator's id
    expect(frame["kind"]).toBe("event");

    p.close();
    operator.close();
  });

  it("errors when no provider serves the requested session", async () => {
    gw = await startGateway({ port: 0 });
    const operator = await open(`ws://127.0.0.1:${gw.port}`);
    operator.send(
      JSON.stringify({
        id: "9",
        op: "session.subscribe",
        params: { sessionId: "ghost", sinceSeq: 0 },
      }),
    );
    const res = await nextMessage(operator);
    expect(res["ok"]).toBe(false);
    operator.close();
  });

  it("errors (never hangs) on an operator request that fails validation", async () => {
    gw = await startGateway({ port: 0 });
    const operator = await open(`ws://127.0.0.1:${gw.port}`);
    // Well-formed JSON, invalid params (session.subscribe with no sessionId) —
    // e.g. a client built against a different protocol version. It must surface
    // as an error, not silently drop (which hangs the client on "Loading…").
    operator.send(
      JSON.stringify({ id: "bad-1", op: "session.subscribe", params: {} }),
    );
    const res = await nextMessage(operator);
    expect(res["id"]).toBe("bad-1");
    expect(res["ok"]).toBe(false);
    operator.close();
  });

  it("sends gateway.info to a provider on connect (no phone URL yet)", async () => {
    gw = await startGateway({ port: 0 });
    const p = await openProvider(`ws://127.0.0.1:${gw.port}`, "i1");
    expect(await nextMessage(p)).toEqual({ type: "gateway.info" });
    p.close();
  });

  it("broadcasts the phone URL to connected providers on setPhoneUrl", async () => {
    gw = await startGateway({ port: 0 });
    const p = await openProvider(`ws://127.0.0.1:${gw.port}`, "i1");
    const seen: Record<string, unknown>[] = [];
    p.on("message", (m) => seen.push(JSON.parse(m.toString())));
    await waitFor(() => gw!.registry.forInstance("i1").length === 1);
    const phoneUrl = "https://hub-7900.euw.devtunnels.ms";
    gw.setPhoneUrl(phoneUrl);
    await waitFor(() => seen.some((m) => m["phoneUrl"] === phoneUrl));
    expect(seen.at(-1)).toEqual({ type: "gateway.info", phoneUrl });
    p.close();
  });

  it("gives a provider connecting after setPhoneUrl the phone URL up front", async () => {
    gw = await startGateway({ port: 0 });
    const phoneUrl = "https://hub-7900.euw.devtunnels.ms";
    gw.setPhoneUrl(phoneUrl);
    const p = await openProvider(`ws://127.0.0.1:${gw.port}`, "i2");
    expect(await nextMessage(p)).toEqual({ type: "gateway.info", phoneUrl });
    p.close();
  });

  it("answers a provider knock with a gateway knock before any payload", async () => {
    gw = await startGateway({ port: 0 });
    const ws = await open(`ws://127.0.0.1:${gw.port}`);
    ws.send(JSON.stringify({ type: "cloakcode.hello", role: "provider" }));
    expect(await nextMessage(ws)).toEqual({
      type: "cloakcode.hello",
      role: "gateway",
    });
    ws.close();
  });

  it("stays silent to a peer that never sends a valid knock", async () => {
    gw = await startGateway({ port: 0 });
    const ws = await open(`ws://127.0.0.1:${gw.port}`);
    ws.send("not-a-knock");
    const outcome = await Promise.race([
      nextMessage(ws),
      new Promise((r) => setTimeout(() => r("silence"), 150)),
    ]);
    expect(outcome).toBe("silence");
    ws.close();
  });

  it("logs provider connect + disconnect via the log callback", async () => {
    const lines: string[] = [];
    gw = await startGateway({ port: 0, log: (l) => lines.push(l) });
    const p = await openProvider(`ws://127.0.0.1:${gw.port}`, "i7");
    await waitFor(() =>
      lines.some((l) => l.includes("provider connected: i7")),
    );
    p.close();
    await waitFor(() =>
      lines.some((l) => l.includes("provider disconnected: i7")),
    );
  });
});
