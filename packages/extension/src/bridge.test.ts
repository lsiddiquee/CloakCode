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
    title: "Refactor auth middleware",
    turns: 12,
    status: "blocked",
    idleSeconds: 3,
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
      | { sessionId: string; toolCallId: string; text: string }
      | undefined;
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

  it("routes session.decide to the decide dep and acks", async () => {
    let got:
      | { sessionId: string; toolCallId: string; decision: string }
      | undefined;
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
      | { sessionId: string; toolCallId: string; answers: unknown }
      | undefined;
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
});
