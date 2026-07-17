import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { SessionSummary } from "@cloakcode/protocol";
import { startBridge, type BridgeDeps } from "./bridge.js";
import { parseSessionEvents } from "./session-observer.js";

const sample: SessionSummary[] = [
  {
    instanceId: "inst-test",
    sessionId: "sessA",
    workspace: "myrepo",
    workspaceHash: "hash-abc",
    title: "Refactor auth middleware",
    turns: 12,
    status: "blocked",
    idleSeconds: 3,
    owned: true,
    inTurn: false,
  },
];

const deps = (over: Partial<BridgeDeps> = {}): BridgeDeps => {
  const findTranscript = over.findTranscript ?? (async () => undefined);
  return {
    listSessions: async () => sample,
    findTranscript,
    // Default the conversation source to the transcript (parseSessionEvents) so
    // existing tests that set `findTranscript` keep driving the stream.
    findSessionLog: async (id) => {
      const file = await findTranscript(id);
      return file ? { file, parse: parseSessionEvents } : undefined;
    },
    ...over,
  };
};

function request(port: number, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => ws.send(JSON.stringify(payload)));
    ws.on("message", (data) => {
      resolve(JSON.parse(data.toString()));
      ws.close();
    });
    ws.on("error", reject);
  });
}

/** Send a RAW (already-serialized) frame so we can feed non-JSON / garbage. */
function rawRequest(port: number, raw: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => ws.send(raw));
    ws.on("message", (data) => {
      resolve(JSON.parse(data.toString()));
      ws.close();
    });
    ws.on("error", reject);
  });
}

describe("startBridge", () => {
  it("binds an ephemeral localhost port and answers sessions.list", async () => {
    const bridge = await startBridge(deps(), { port: 0 });
    try {
      expect(bridge.port).toBeGreaterThan(0);
      const res = await request(bridge.port, { id: "1", op: "sessions.list" });
      expect(res).toMatchObject({
        id: "1",
        ok: true,
        op: "sessions.list",
        result: sample,
      });
    } finally {
      await bridge.close();
    }
  });

  it("rejects a malformed request with an error envelope", async () => {
    const bridge = await startBridge(deps(), { port: 0 });
    try {
      const res = await request(bridge.port, { op: "not.a.real.op" });
      expect(res).toMatchObject({
        ok: false,
        error: { message: expect.any(String) },
      });
    } finally {
      await bridge.close();
    }
  });

  it("preserves the request id on a validation error (so the client can correlate)", async () => {
    const bridge = await startBridge(deps(), { port: 0 });
    try {
      // Valid `id`, invalid `op` → the error reply must echo the id, not "unknown".
      const res = await request(bridge.port, { id: "abc-42", op: "nope" });
      expect(res).toMatchObject({ id: "abc-42", ok: false });
    } finally {
      await bridge.close();
    }
  });

  it('falls back to "unknown" id when the payload has no salvageable id', async () => {
    const bridge = await startBridge(deps(), { port: 0 });
    try {
      const res = await rawRequest(bridge.port, "}{ not json at all");
      expect(res).toMatchObject({ id: "unknown", ok: false });
    } finally {
      await bridge.close();
    }
  });

  it("rejects non-JSON garbage (input is parsed, never trusted raw)", async () => {
    const bridge = await startBridge(deps(), { port: 0 });
    try {
      const res = await rawRequest(bridge.port, "}{ not json at all");
      expect(res).toMatchObject({
        ok: false,
        error: { message: expect.any(String) },
      });
    } finally {
      await bridge.close();
    }
  });

  it("rejects a valid op with invalid params (zod validates PARAMS, not just op)", async () => {
    // Guards against a refactor silently dropping `rpcRequestSchema.parse`:
    // session.respond REQUIRES params.text, so omitting it must be rejected AND
    // must never reach the actuator.
    let respondCalled = false;
    const bridge = await startBridge(
      deps({ respond: async () => void (respondCalled = true) }),
      { port: 0 },
    );
    try {
      const res = await request(bridge.port, {
        id: "9",
        op: "session.respond",
        params: { instanceId: "i", sessionId: "s" },
      });
      expect(res).toMatchObject({
        ok: false,
        error: { message: expect.any(String) },
      });
      expect(respondCalled).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it("passes untrusted answer text through VERBATIM (data, never interpreted/sanitized)", async () => {
    // A well-formed frame carrying shell metacharacters + emoji is valid DATA:
    // accepted and delivered to the actuator byte-for-byte (no expansion, no
    // stripping). The bridge must only ever treat the payload as an opaque string.
    let got: string | undefined;
    const bridge = await startBridge(
      deps({ respond: async (p) => void (got = p.text) }),
      { port: 0 },
    );
    try {
      const payload =
        'it\'s "$cool" `whoami` $(id); rm -rf / && echo \uD83D\uDE80';
      const res = await request(bridge.port, {
        id: "9",
        op: "session.respond",
        params: { instanceId: "i", sessionId: "s", text: payload },
      });
      expect(res).toMatchObject({ id: "9", ok: true, op: "session.respond" });
      expect(got).toBe(payload);
    } finally {
      await bridge.close();
    }
  });

  it("streams session.subscribe events from the transcript", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-sub-"));
    const file = path.join(dir, "sessA.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "user.message", data: { content: "go" } }),
        JSON.stringify({
          type: "tool.execution_start",
          data: { toolCallId: "t1", toolName: "read_file" },
        }),
      ].join("\n"),
    );
    const bridge = await startBridge(
      deps({ findTranscript: async () => file }),
      {
        port: 0,
      },
    );
    try {
      const frames = await new Promise<Array<Record<string, unknown>>>(
        (resolve, reject) => {
          const got: Array<Record<string, unknown>> = [];
          const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
          ws.on("open", () =>
            ws.send(
              JSON.stringify({
                id: "9",
                op: "session.subscribe",
                params: { instanceId: "inst-test", sessionId: "sessA" },
              }),
            ),
          );
          ws.on("message", (data) => {
            got.push(JSON.parse(data.toString()));
            if (got.length === 2) {
              ws.close();
              resolve(got);
            }
          });
          ws.on("error", reject);
        },
      );
      expect(frames[0]).toMatchObject({
        id: "9",
        op: "session.subscribe",
        event: { type: "append", seq: 0, part: { kind: "userMessage" } },
      });
      expect(frames[1]).toMatchObject({
        event: { type: "append", seq: 1, part: { kind: "toolCall" } },
      });
    } finally {
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("streams a live inTurn frame from the transcript turn state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-turn-"));
    const file = path.join(dir, "sessA.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "user.message", data: { content: "go" } }),
        JSON.stringify({
          type: "assistant.turn_start",
          data: { turnId: "t1" },
          timestamp: "2026-07-16T00:00:01.000Z",
        }),
        JSON.stringify({
          type: "assistant.message",
          data: { content: "working" },
        }),
      ].join("\n"),
    );
    const bridge = await startBridge(
      deps({ findTranscript: async () => file }),
      { port: 0 },
    );
    try {
      const turnFrame = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
          ws.on("open", () =>
            ws.send(
              JSON.stringify({
                id: "7",
                op: "session.subscribe",
                params: { instanceId: "i", sessionId: "sessA" },
              }),
            ),
          );
          ws.on("message", (data) => {
            const frame = JSON.parse(data.toString());
            if (frame.kind === "turn") {
              ws.close();
              resolve(frame);
            }
          });
          ws.on("error", reject);
        },
      );
      expect(turnFrame).toMatchObject({
        id: "7",
        op: "session.subscribe",
        kind: "turn",
        inTurn: true,
      });
    } finally {
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("errors when the subscribed session is not found", async () => {
    const bridge = await startBridge(deps(), { port: 0 });
    try {
      const res = await request(bridge.port, {
        id: "5",
        op: "session.subscribe",
        params: { instanceId: "i", sessionId: "missing" },
      });
      expect(res).toMatchObject({
        id: "5",
        ok: false,
        error: { message: "session not found" },
      });
    } finally {
      await bridge.close();
    }
  });

  it("dedupes a re-subscribe to the same session on one connection", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-dedupe-"));
    const file = path.join(dir, "sessA.jsonl");
    await fs.writeFile(
      file,
      JSON.stringify({ type: "user.message", data: { content: "go" } }),
    );
    const bridge = await startBridge(
      deps({ findTranscript: async () => file }),
      {
        port: 0,
      },
    );
    try {
      // Second subscribe (id "b") must replace the first and replay from seq 0.
      const replayed = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
          const sub = (id: string) =>
            ws.send(
              JSON.stringify({
                id,
                op: "session.subscribe",
                params: { instanceId: "i", sessionId: "sessA" },
              }),
            );
          ws.on("open", () => {
            sub("a");
            sub("b");
          });
          ws.on("message", (data) => {
            const frame = JSON.parse(data.toString());
            if (frame.id === "b") {
              ws.close();
              resolve(frame);
            }
          });
          ws.on("error", reject);
        },
      );
      expect(replayed).toMatchObject({
        id: "b",
        op: "session.subscribe",
        event: { type: "append", seq: 0, part: { kind: "userMessage" } },
      });
    } finally {
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("streams a live-pending snapshot from the hook spool", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-pending-"));
    const file = path.join(dir, "sessA.jsonl");
    const spoolDir = path.join(dir, "spool");
    await fs.writeFile(
      file,
      JSON.stringify({ type: "user.message", data: { content: "go" } }),
    );
    await fs.mkdir(spoolDir, { recursive: true });
    await fs.writeFile(
      path.join(spoolDir, "toolu_ABC.json"),
      JSON.stringify({
        sessionId: "sessA",
        toolCallId: "toolu_ABC",
        toolName: "run_in_terminal",
        input: { command: "rm -v /tmp/x" },
        ts: "2026-07-09T12:00:00.000Z",
      }),
    );
    const bridge = await startBridge(
      deps({ findTranscript: async () => file, spoolDir }),
      { port: 0 },
    );
    try {
      const pending = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
          ws.on("open", () =>
            ws.send(
              JSON.stringify({
                id: "7",
                op: "session.subscribe",
                params: { instanceId: "i", sessionId: "sessA" },
              }),
            ),
          );
          ws.on("message", (data) => {
            const frame = JSON.parse(data.toString());
            if (frame.kind === "pending") {
              ws.close();
              resolve(frame);
            }
          });
          ws.on("error", reject);
        },
      );
      expect(pending).toMatchObject({
        id: "7",
        op: "session.subscribe",
        kind: "pending",
        blockers: [
          {
            toolCallId: "toolu_ABC",
            toolName: "run_in_terminal",
            input: { command: "rm -v /tmp/x" },
          },
        ],
      });
    } finally {
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("routes session.respond to the respond dep and acks", async () => {
    let got:
      { sessionId: string; toolCallId: string; text: string } | undefined;
    const bridge = await startBridge(
      deps({
        respond: async (p) => {
          got = p;
        },
      }),
      { port: 0 },
    );
    try {
      const res = await request(bridge.port, {
        id: "9",
        op: "session.respond",
        params: {
          instanceId: "i",
          sessionId: "sessA",
          toolCallId: "t1",
          text: "1. scratch.txt\n2. Overwrite",
        },
      });
      expect(res).toMatchObject({ id: "9", ok: true, op: "session.respond" });
      expect(got).toEqual({
        sessionId: "sessA",
        toolCallId: "t1",
        text: "1. scratch.txt\n2. Overwrite",
      });
    } finally {
      await bridge.close();
    }
  });

  it("threads the client traceId through to the actuator dep", async () => {
    let got: { sessionId: string; text: string; traceId?: string } | undefined;
    const bridge = await startBridge(
      deps({
        respond: async (p) => {
          got = p;
        },
      }),
      { port: 0 },
    );
    try {
      await request(bridge.port, {
        id: "20",
        op: "session.respond",
        traceId: "trace-xyz",
        params: { sessionId: "sessA", text: "hi" },
      });
      expect(got?.traceId).toBe("trace-xyz");
    } finally {
      await bridge.close();
    }
  });

  it("errors session.respond when no respond dep is configured", async () => {
    const bridge = await startBridge(deps(), { port: 0 });
    try {
      const res = await request(bridge.port, {
        id: "9",
        op: "session.respond",
        params: {
          instanceId: "i",
          sessionId: "sessA",
          toolCallId: "t1",
          text: "x",
        },
      });
      expect(res).toMatchObject({
        ok: false,
        error: { message: expect.any(String) },
      });
    } finally {
      await bridge.close();
    }
  });

  it("rejects an actuator targeting a session this window does not own (F3)", async () => {
    // Defense-in-depth: even a direct RPC (bypassing the UI gating) must not
    // actuate a foreign session — the respond dep must never be called.
    let respondCalled = false;
    const bridge = await startBridge(
      deps({
        isOwned: async () => false,
        respond: async () => void (respondCalled = true),
      }),
      { port: 0 },
    );
    try {
      const res = await request(bridge.port, {
        id: "9",
        op: "session.respond",
        params: { instanceId: "i", sessionId: "foreign", text: "hi" },
      });
      expect(res).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("not owned") },
      });
      expect(respondCalled).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it("allows an actuator when the session IS owned (F3)", async () => {
    let respondCalled = false;
    const bridge = await startBridge(
      deps({
        isOwned: async () => true,
        respond: async () => void (respondCalled = true),
      }),
      { port: 0 },
    );
    try {
      const res = await request(bridge.port, {
        id: "9",
        op: "session.respond",
        params: { instanceId: "i", sessionId: "sessA", text: "hi" },
      });
      expect(res).toMatchObject({ id: "9", ok: true, op: "session.respond" });
      expect(respondCalled).toBe(true);
    } finally {
      await bridge.close();
    }
  });

  it("serializes a non-Error throw without '[object Object]' (F8)", async () => {
    const bridge = await startBridge(
      deps({
        isOwned: async () => true,
        respond: async () => {
          throw { code: "EBUSY" }; // a plain object, not an Error
        },
      }),
      { port: 0 },
    );
    try {
      const res = (await request(bridge.port, {
        id: "9",
        op: "session.respond",
        params: { instanceId: "i", sessionId: "sessA", text: "hi" },
      })) as { ok: boolean; error: { message: string } };
      expect(res.ok).toBe(false);
      expect(res.error.message).toContain("EBUSY");
      expect(res.error.message).not.toContain("[object Object]");
    } finally {
      await bridge.close();
    }
  });

  it("routes session.decide to the decide dep and acks", async () => {
    let got:
      { sessionId: string; toolCallId: string; decision: string } | undefined;
    const bridge = await startBridge(
      deps({
        decide: async (p) => {
          got = p;
        },
      }),
      { port: 0 },
    );
    try {
      const res = await request(bridge.port, {
        id: "11",
        op: "session.decide",
        params: {
          instanceId: "i",
          sessionId: "sessA",
          toolCallId: "t1",
          decision: "allow",
        },
      });
      expect(res).toMatchObject({ id: "11", ok: true, op: "session.decide" });
      expect(got).toEqual({
        sessionId: "sessA",
        toolCallId: "t1",
        decision: "allow",
      });
    } finally {
      await bridge.close();
    }
  });

  it("errors session.decide when no decide dep is configured", async () => {
    const bridge = await startBridge(deps(), { port: 0 });
    try {
      const res = await request(bridge.port, {
        id: "11",
        op: "session.decide",
        params: {
          instanceId: "i",
          sessionId: "sessA",
          toolCallId: "t1",
          decision: "deny",
        },
      });
      expect(res).toMatchObject({
        ok: false,
        error: { message: expect.any(String) },
      });
    } finally {
      await bridge.close();
    }
  });

  it("routes session.answer to the answer dep and acks", async () => {
    let got:
      { sessionId: string; toolCallId: string; answers: unknown } | undefined;
    const bridge = await startBridge(
      deps({
        answer: async (p) => {
          got = p;
        },
      }),
      { port: 0 },
    );
    try {
      const res = await request(bridge.port, {
        id: "12",
        op: "session.answer",
        params: {
          instanceId: "i",
          sessionId: "sessA",
          toolCallId: "toolu_X__vscode-9",
          answers: [{ selected: ["Overwrite"], freeText: null }],
        },
      });
      expect(res).toMatchObject({ id: "12", ok: true, op: "session.answer" });
      expect(got?.toolCallId).toBe("toolu_X__vscode-9");
    } finally {
      await bridge.close();
    }
  });

  it("routes session.steer to the steer dep and acks", async () => {
    let got: { sessionId: string; text: string } | undefined;
    const bridge = await startBridge(
      deps({
        steer: async (p) => {
          got = p;
        },
      }),
      { port: 0 },
    );
    try {
      const res = await request(bridge.port, {
        id: "13",
        op: "session.steer",
        params: { sessionId: "sessA", text: "use zod" },
      });
      expect(res).toMatchObject({ id: "13", ok: true, op: "session.steer" });
      expect(got).toEqual({ sessionId: "sessA", text: "use zod" });
    } finally {
      await bridge.close();
    }
  });

  it("errors session.steer when no steer dep is configured", async () => {
    const bridge = await startBridge(deps(), { port: 0 });
    try {
      const res = await request(bridge.port, {
        id: "13",
        op: "session.steer",
        params: { sessionId: "sessA", text: "x" },
      });
      expect(res).toMatchObject({
        ok: false,
        error: { message: expect.any(String) },
      });
    } finally {
      await bridge.close();
    }
  });

  it("routes session.stop (stop-and-send and pure stop) to the stop dep", async () => {
    const seen: Array<{ sessionId: string; text?: string }> = [];
    const bridge = await startBridge(
      deps({
        stop: async (p) => {
          seen.push(p);
        },
      }),
      { port: 0 },
    );
    try {
      const withText = await request(bridge.port, {
        id: "14",
        op: "session.stop",
        params: { sessionId: "sessA", text: "start over" },
      });
      expect(withText).toMatchObject({
        id: "14",
        ok: true,
        op: "session.stop",
      });
      const pure = await request(bridge.port, {
        id: "15",
        op: "session.stop",
        params: { sessionId: "sessA" },
      });
      expect(pure).toMatchObject({ id: "15", ok: true, op: "session.stop" });
      expect(seen).toEqual([
        { sessionId: "sessA", text: "start over" },
        { sessionId: "sessA" },
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("errors session.stop when no stop dep is configured", async () => {
    const bridge = await startBridge(deps(), { port: 0 });
    try {
      const res = await request(bridge.port, {
        id: "14",
        op: "session.stop",
        params: { sessionId: "sessA" },
      });
      expect(res).toMatchObject({
        ok: false,
        error: { message: expect.any(String) },
      });
    } finally {
      await bridge.close();
    }
  });
});

describe("startBridge static gateway", () => {
  it("serves the built PWA over HTTP and still upgrades the WebSocket on the same port", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-web-"));
    await fs.writeFile(
      path.join(dir, "index.html"),
      "<!doctype html><title>CloakCode</title>",
    );
    await fs.mkdir(path.join(dir, "assets"));
    await fs.writeFile(path.join(dir, "assets", "app.js"), "console.log(1)");
    const bridge = await startBridge(deps(), { port: 0, serveDir: dir });
    try {
      const index = await fetch(`http://127.0.0.1:${bridge.port}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(await index.text()).toContain("CloakCode");

      const asset = await fetch(
        `http://127.0.0.1:${bridge.port}/assets/app.js`,
      );
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");

      const missing = await fetch(`http://127.0.0.1:${bridge.port}/nope.js`);
      expect(missing.status).toBe(404);

      // The live stream still works on the very same port.
      const res = await request(bridge.port, { id: "1", op: "sessions.list" });
      expect(res).toMatchObject({ ok: true, op: "sessions.list" });
    } finally {
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("answers plain HTTP with 426 when no PWA is bundled (dev/test WS-only)", async () => {
    const bridge = await startBridge(deps(), { port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${bridge.port}/`);
      expect(res.status).toBe(426);
    } finally {
      await bridge.close();
    }
  });
});

describe("bridge teardown / re-establish (reconnect contract)", () => {
  // The mobile-reconnect flow depends on TWO server guarantees, exercised end to
  // end here against the real bridge: (1) closing the bridge (the extension's
  // `CloakCode: Reconnect` / a settings hot-apply) actually TERMINATES live
  // subscribers — otherwise the client "doesn't flinch" and never reconnects;
  // and (2) a fresh subscribe with `sinceSeq` resumes past what was already seen,
  // so no missed events are dropped and none are replayed. The web client's
  // backoff/resume loop is unit-tested separately (web `bridge.test.ts`).
  it("terminates live subscribers on close, then resumes from sinceSeq on re-subscribe", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-recon-"));
    const file = path.join(dir, "sessA.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "user.message", data: { content: "one" } }),
        JSON.stringify({ type: "user.message", data: { content: "two" } }),
      ].join("\n"),
    );

    const bridge1 = await startBridge(
      deps({ findTranscript: async () => file }),
      { port: 0 },
    );
    const ws1 = new WebSocket(`ws://127.0.0.1:${bridge1.port}`);
    // The 'close' the client's reconnect loop keys off — must fire on teardown.
    const closed = new Promise<void>((resolve) =>
      ws1.on("close", () => resolve()),
    );
    const backlog: number[] = [];
    await new Promise<void>((resolve, reject) => {
      ws1.on("open", () =>
        ws1.send(
          JSON.stringify({
            id: "r",
            op: "session.subscribe",
            params: { instanceId: "i", sessionId: "sessA" },
          }),
        ),
      );
      ws1.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.kind === "event") {
          backlog.push(frame.event.seq);
          if (backlog.length === 2) resolve();
        }
      });
      ws1.on("error", reject);
    });
    expect(backlog).toEqual([0, 1]);

    // Teardown must terminate the live subscriber (else it never reconnects).
    await bridge1.close();
    await closed; // hangs if close() leaves the socket open ("did not flinch")

    // New activity lands while the client is disconnected.
    await fs.appendFile(
      file,
      `\n${JSON.stringify({ type: "user.message", data: { content: "three" } })}`,
    );

    // Re-establish on a fresh bridge and resume from where the client left off.
    const bridge2 = await startBridge(
      deps({ findTranscript: async () => file }),
      { port: 0 },
    );
    try {
      const resumed: number[] = [];
      const got = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const ws2 = new WebSocket(`ws://127.0.0.1:${bridge2.port}`);
          ws2.on("open", () =>
            ws2.send(
              JSON.stringify({
                id: "r2",
                op: "session.subscribe",
                params: { instanceId: "i", sessionId: "sessA", sinceSeq: 2 },
              }),
            ),
          );
          ws2.on("message", (data) => {
            const frame = JSON.parse(data.toString());
            if (frame.kind === "event") {
              resumed.push(frame.event.seq);
              ws2.close();
              resolve(frame);
            }
          });
          ws2.on("error", reject);
        },
      );
      // Only the event past sinceSeq replays — 0 and 1 are NOT re-sent.
      expect(resumed).toEqual([2]);
      expect(got).toMatchObject({
        event: { part: { kind: "userMessage", text: "three" } },
      });
    } finally {
      await bridge2.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
