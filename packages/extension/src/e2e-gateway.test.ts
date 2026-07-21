import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import {
  OperatorAuth,
  startGateway,
  silentLogger,
  type Gateway,
} from "@cloakcode/gateway";
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

/**
 * Authenticate an operator socket with a TOTP `code`, then run `list` +
 * `subscribe` on the SAME connection (one code — the replay guard rejects reuse
 * across sockets) and resolve with both replies.
 */
function authedListAndSubscribe(
  port: number,
  code: string,
  sessionId: string,
): Promise<{ list: Record<string, unknown>; event: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let list: Record<string, unknown> | undefined;
    ws.on("open", () =>
      ws.send(JSON.stringify({ id: "auth", op: "auth", params: { code } })),
    );
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "auth") {
        if (!msg.ok) return reject(new Error(`auth failed: ${data}`));
        ws.send(JSON.stringify({ id: "1", op: "sessions.list" }));
        return;
      }
      if (msg.id === "1") {
        list = msg;
        ws.send(
          JSON.stringify({
            id: "2",
            op: "session.subscribe",
            params: { sessionId },
          }),
        );
        return;
      }
      if (msg.id === "2") {
        ws.close();
        resolve({ list: list!, event: msg });
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

  it("gates the whole chain: provider TOTP token + operator TOTP", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-e2e-"));
    const file = path.join(dir, "sessE2E.jsonl");
    await fs.writeFile(
      file,
      JSON.stringify({ type: "user.message", data: { content: "go" } }),
    );
    const deps: BridgeDeps = {
      listSessions: async () => [summary],
      findTranscript: async () => file,
      findSessionLog: async () => ({ file, parse: parseSessionEvents }),
    };

    // RFC 6238 seed as base32; code "287082" is valid at t=59s. Public vector.
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow
    const now = () => 59_000;
    // The provider's stored token (issued by a code exchange), verified by the
    // gateway's operator secret — the extension never holds the secret itself.
    const providerToken = new OperatorAuth({
      secret,
      now,
      confirmed: true,
    }).submitCode("287082").token;

    gateway = await startGateway({
      host: "127.0.0.1",
      port: 0,
      fallbackToEphemeral: true,
      logger: silentLogger(),
      operatorAuth: new OperatorAuth({ secret, now, confirmed: true }),
    });
    client = await connectGateway(
      `ws://127.0.0.1:${gateway.port}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      providerToken,
    );

    // An UNauthenticated operator is refused — the relay is genuinely gated.
    const [refused] = await operator(
      gateway.port,
      { id: "0", op: "sessions.list" },
      1,
    );
    expect(refused).toMatchObject({ id: "0", ok: false, needsAuth: true });

    // A TOTP-authenticated operator lists + streams through the relay, proving
    // the provider registered with its token AND the operator gate lets it flow.
    const { list, event } = await authedListAndSubscribe(
      gateway.port,
      "287082",
      "sessE2E",
    );
    expect(list).toMatchObject({ id: "1", ok: true, op: "sessions.list" });
    expect((list.result as SessionSummary[])[0]?.sessionId).toBe("sessE2E");
    expect(event).toMatchObject({
      id: "2",
      event: { type: "append", part: { kind: "userMessage" } },
    });
  });

  it("streams every part kind (message, reasoning, question, tool call) through the relay", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-e2e-"));
    const file = path.join(dir, "sessE2E.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "user.message", data: { content: "go" } }),
        JSON.stringify({
          type: "assistant.message",
          data: { reasoningText: "planning", content: "On it." },
        }),
        JSON.stringify({
          type: "tool.execution_start",
          data: {
            toolCallId: "q1",
            toolName: "vscode_askQuestions",
            arguments: {
              questions: [
                {
                  question: "Proceed?",
                  options: [{ label: "Yes" }, { label: "No" }],
                },
              ],
            },
          },
        }),
        JSON.stringify({
          type: "tool.execution_complete",
          data: { toolCallId: "q1", success: true },
        }),
        JSON.stringify({
          type: "tool.execution_start",
          data: {
            toolCallId: "t2",
            toolName: "run_in_terminal",
            arguments: { command: "ls" },
          },
        }),
        JSON.stringify({
          type: "tool.execution_complete",
          data: { toolCallId: "t2", success: true },
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

    // The initial stream carries 7 conversation events + 1 `turn` frame (initial
    // inTurn=false), which can interleave with the events — collect all 8 and
    // filter to the `event` frames so the assertion is order-independent.
    const frames = await operator(
      gateway.port,
      {
        id: "2",
        op: "session.subscribe",
        params: { sessionId: "sessE2E" },
      },
      8,
    );
    const kinds = frames
      .filter((f) => f.kind === "event")
      .map((f) => {
        const ev = f.event as { type: string; part?: { kind: string } };
        return ev.type === "append" ? ev.part!.kind : ev.type;
      });
    expect(kinds).toEqual([
      "userMessage",
      "thinking",
      "markdown",
      "confirmation",
      "resolve",
      "toolCall",
      "updateStatus",
    ]);
  });
});
