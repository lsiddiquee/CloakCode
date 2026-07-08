import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { SessionSummary } from "@cloakcode/protocol";
import { startBridge } from "./bridge.js";

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

describe("startBridge", () => {
  it("binds an ephemeral localhost port and answers sessions.list", async () => {
    const bridge = await startBridge(
      { listSessions: async () => sample },
      { port: 0 },
    );
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
    const bridge = await startBridge(
      { listSessions: async () => sample },
      { port: 0 },
    );
    try {
      const res = await request(bridge.port, { op: "not.a.real.op" });
      expect(res).toMatchObject({ ok: false, error: { message: expect.any(String) } });
    } finally {
      await bridge.close();
    }
  });
});
