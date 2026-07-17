import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { startGateway, silentLogger, type Gateway } from "@cloakcode/gateway";
import type { SessionSummary } from "@cloakcode/protocol";
import { connectGateway, type GatewayClient } from "./gateway-client.js";
import { parseSessionEvents } from "./session-observer.js";
import type { BridgeDeps } from "./bridge.js";

// End-to-end (F14): a REAL transcript file on disk → the extension connected as a
// PROVIDER (connectGateway) → a REAL gateway → an operator subscribing THROUGH the
// gateway. Exercises transcript parsing + the provider's serve path + the gateway
// relay + the operator round-trip in one wired flow — the seam no unit test spans.

let gateway: Gateway | undefined;
let client: GatewayClient | undefined;
let dir: string | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  await gateway?.close();
  gateway = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const summary: SessionSummary = {
  instanceId: "i1",
  sessionId: "sessE2E",
  workspace: "repo",
  workspaceHash: "H",
  title: "e2e",
  turns: 1,
  status: "blocked",
  idleSeconds: 0,
  owned: true,
  inTurn: false,
};

/** Open an operator socket, send `req`, resolve once `count` frames arrive. */
function operator(
  port: number,
  req: unknown,
  count: number,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const frames: Record<string, unknown>[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => ws.send(JSON.stringify(req)));
    ws.on("message", (data) => {
      frames.push(JSON.parse(data.toString()));
      if (frames.length >= count) {
        ws.close();
        resolve(frames);
      }
    });
    ws.on("error", reject);
  });
}

describe("e2e: transcript → provider → gateway → operator", () => {
  it("lists and streams a session's events through the gateway", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-e2e-"));
    const file = path.join(dir, "sessE2E.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "user.message", data: { content: "go" } }),
        JSON.stringify({
          type: "tool.execution_start",
          data: {
            toolCallId: "tc1",
            toolName: "run_in_terminal",
            arguments: {},
          },
        }),
      ].join("\n"),
    );

    const deps: BridgeDeps = {
      listSessions: async () => [summary],
      findTranscript: async () => file,
      findSessionLog: async () => ({ file, parse: parseSessionEvents }),
    };

    gateway = await startGateway({
      host: "127.0.0.1",
      port: 0,
      fallbackToEphemeral: true,
      logger: silentLogger(),
    });
    client = await connectGateway(
      `ws://127.0.0.1:${gateway.port}`,
      { instanceId: "i1" },
      deps,
      () => {},
    );

    // sessions.list flows provider → gateway → operator.
    const [list] = await operator(
      gateway.port,
      { id: "1", op: "sessions.list" },
      1,
    );
    expect(list).toMatchObject({ id: "1", ok: true, op: "sessions.list" });
    expect((list.result as SessionSummary[])[0]?.sessionId).toBe("sessE2E");

    // subscribe streams the parsed transcript events back through the relay.
    const frames = await operator(
      gateway.port,
      {
        id: "2",
        op: "session.subscribe",
        params: { sessionId: "sessE2E" },
      },
      2,
    );
    expect(frames[0]).toMatchObject({
      id: "2",
      event: { type: "append", part: { kind: "userMessage" } },
    });
    expect(frames[1]).toMatchObject({
      event: { type: "append", part: { kind: "toolCall" } },
    });
  });
});
