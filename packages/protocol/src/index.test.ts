import { describe, it, expect } from "vitest";
import {
  sessionStatusSchema,
  sessionSummarySchema,
  sessionPartSchema,
  sessionEventSchema,
  sessionSubscribeEventSchema,
  pendingBlockerSchema,
  confirmationPartSchema,
  rpcRequestSchema,
  rpcErrorSchema,
  sessionsListResponseSchema,
  sessionDecideResponseSchema,
  sessionAnswerResponseSchema,
  sessionSteerResponseSchema,
  sessionStopResponseSchema,
  DEFAULT_PORT,
  MAX_RPC_TEXT_LEN,
  providerInfoSchema,
  cloakcodeHelloSchema,
  connectionHelloSchema,
  gatewayInfoSchema,
  type SessionSummary,
} from "./index.js";

const validSummary: SessionSummary = {
  instanceId: "inst-abc",
  sessionId: "56514ca7-1111",
  workspace: "myrepo",
  workspaceHash: "abc123def456",
  title: "Refactor auth middleware",
  turns: 12,
  status: "blocked",
  idleSeconds: 3,
  owned: true,
  inTurn: false,
};

describe("DEFAULT_PORT", () => {
  it("is the shared preferred loopback port (3543)", () => {
    expect(DEFAULT_PORT).toBe(3543);
  });
});

describe("sessionStatusSchema", () => {
  it("accepts the three known statuses", () => {
    for (const s of ["active", "blocked", "idle"]) {
      expect(sessionStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects an unknown status", () => {
    expect(sessionStatusSchema.safeParse("running").success).toBe(false);
  });
});

describe("sessionSummarySchema", () => {
  it("parses a valid summary", () => {
    expect(sessionSummarySchema.parse(validSummary)).toEqual(validSummary);
  });

  it("rejects a negative turn count", () => {
    expect(
      sessionSummarySchema.safeParse({ ...validSummary, turns: -1 }).success,
    ).toBe(false);
  });

  it("rejects a bad status", () => {
    expect(
      sessionSummarySchema.safeParse({ ...validSummary, status: "nope" })
        .success,
    ).toBe(false);
  });
});

describe("rpcRequestSchema", () => {
  it("parses a sessions.list request and defaults params", () => {
    const parsed = rpcRequestSchema.parse({ id: "1", op: "sessions.list" });
    expect(parsed).toEqual({ id: "1", op: "sessions.list", params: {} });
  });

  it("carries an optional traceId on the envelope", () => {
    const withTrace = rpcRequestSchema.parse({
      id: "1",
      op: "session.respond",
      traceId: "abc123",
      params: { sessionId: "s1", text: "hi" },
    });
    expect(withTrace.traceId).toBe("abc123");
    // Optional: a request without a traceId still parses.
    const without = rpcRequestSchema.parse({
      id: "2",
      op: "sessions.list",
    });
    expect(without.traceId).toBeUndefined();
  });

  it("parses a session.subscribe request and defaults sinceSeq", () => {
    const parsed = rpcRequestSchema.parse({
      id: "2",
      op: "session.subscribe",
      params: { sessionId: "sessA" },
    });
    expect(parsed).toEqual({
      id: "2",
      op: "session.subscribe",
      params: { sessionId: "sessA", sinceSeq: 0 },
    });
  });

  it("rejects an unknown op", () => {
    expect(
      rpcRequestSchema.safeParse({ id: "1", op: "sessions.nope" }).success,
    ).toBe(false);
  });

  it("parses a session.respond request", () => {
    const parsed = rpcRequestSchema.parse({
      id: "3",
      op: "session.respond",
      params: {
        sessionId: "sessA",
        toolCallId: "toolu_017o4WdwEJb2ruJ2PawLoPyH",
        text: "1. scratch.txt\n2. Overwrite",
      },
    });
    expect(parsed.op).toBe("session.respond");
    if (parsed.op === "session.respond") {
      expect(parsed.params.text).toContain("scratch.txt");
    }
  });

  it("rejects operator text over MAX_RPC_TEXT_LEN (F2b input bound)", () => {
    const tooLong = "x".repeat(MAX_RPC_TEXT_LEN + 1);
    const res = rpcRequestSchema.safeParse({
      id: "3",
      op: "session.respond",
      params: { sessionId: "sessA", text: tooLong },
    });
    expect(res.success).toBe(false);
    // A value exactly at the bound is accepted.
    expect(
      rpcRequestSchema.safeParse({
        id: "3",
        op: "session.respond",
        params: { sessionId: "sessA", text: "x".repeat(MAX_RPC_TEXT_LEN) },
      }).success,
    ).toBe(true);
  });

  it("parses a session.respond chat message with no toolCallId", () => {
    const parsed = rpcRequestSchema.parse({
      id: "4",
      op: "session.respond",
      params: { sessionId: "sessA", text: "run the tests" },
    });
    expect(parsed.op).toBe("session.respond");
    if (parsed.op === "session.respond") {
      expect(parsed.params.toolCallId).toBeUndefined();
      expect(parsed.params.text).toBe("run the tests");
    }
  });

  it("rejects a session.respond with empty text", () => {
    expect(
      rpcRequestSchema.safeParse({
        id: "3",
        op: "session.respond",
        params: {
          sessionId: "sessA",
          toolCallId: "t1",
          text: "",
        },
      }).success,
    ).toBe(false);
  });

  it("parses a session.decide request", () => {
    const parsed = rpcRequestSchema.parse({
      id: "6",
      op: "session.decide",
      params: {
        sessionId: "sessA",
        toolCallId: "toolu_014s9ftYke93xQX364HyyaVo",
        decision: "allow",
      },
    });
    expect(parsed.op).toBe("session.decide");
    if (parsed.op === "session.decide") {
      expect(parsed.params.decision).toBe("allow");
    }
  });

  it("rejects a session.decide with an unknown decision", () => {
    expect(
      rpcRequestSchema.safeParse({
        id: "6",
        op: "session.decide",
        params: {
          sessionId: "sessA",
          toolCallId: "t1",
          decision: "maybe",
        },
      }).success,
    ).toBe(false);
  });

  it("parses a session.answer request with structured answers", () => {
    const parsed = rpcRequestSchema.parse({
      id: "7",
      op: "session.answer",
      params: {
        sessionId: "sessA",
        toolCallId: "toolu_016e9uTUd8Cid5XYn9FYHUKG__vscode-1783582363189",
        answers: [
          { selected: ["tool-call-demo.txt"], freeText: null },
          { selected: ["Overwrite"] },
        ],
      },
    });
    expect(parsed.op).toBe("session.answer");
    if (parsed.op === "session.answer") {
      expect(parsed.params.answers).toHaveLength(2);
      expect(parsed.params.answers[0]?.selected).toEqual([
        "tool-call-demo.txt",
      ]);
    }
  });

  it("rejects a session.answer whose selected is not an array", () => {
    expect(
      rpcRequestSchema.safeParse({
        id: "7",
        op: "session.answer",
        params: {
          instanceId: "inst",
          sessionId: "sessA",
          toolCallId: "t1",
          answers: [{ selected: "Overwrite" }],
        },
      }).success,
    ).toBe(false);
  });

  it("parses a session.steer request", () => {
    const parsed = rpcRequestSchema.parse({
      id: "8",
      op: "session.steer",
      params: { sessionId: "sessA", text: "actually use zod" },
    });
    expect(parsed.op).toBe("session.steer");
    if (parsed.op === "session.steer") {
      expect(parsed.params.text).toBe("actually use zod");
    }
  });

  it("rejects a session.steer with empty text", () => {
    expect(
      rpcRequestSchema.safeParse({
        id: "8",
        op: "session.steer",
        params: { sessionId: "sessA", text: "" },
      }).success,
    ).toBe(false);
  });

  it("parses a session.stop request with and without a follow-up message", () => {
    const stopAndSend = rpcRequestSchema.parse({
      id: "9",
      op: "session.stop",
      params: { sessionId: "sessA", text: "start over" },
    });
    expect(stopAndSend.op).toBe("session.stop");
    if (stopAndSend.op === "session.stop") {
      expect(stopAndSend.params.text).toBe("start over");
    }
    const pureStop = rpcRequestSchema.parse({
      id: "10",
      op: "session.stop",
      params: { sessionId: "sessA" },
    });
    if (pureStop.op === "session.stop") {
      expect(pureStop.params.text).toBeUndefined();
    }
  });

  it("rejects a session.stop with empty (present but blank) text", () => {
    expect(
      rpcRequestSchema.safeParse({
        id: "9",
        op: "session.stop",
        params: { sessionId: "sessA", text: "" },
      }).success,
    ).toBe(false);
  });
});

describe("sessionPartSchema", () => {
  it("parses each I1 part kind", () => {
    expect(
      sessionPartSchema.parse({ kind: "userMessage", id: "u1", text: "hi" })
        .kind,
    ).toBe("userMessage");
    expect(
      sessionPartSchema.parse({ kind: "markdown", id: "m1", text: "**x**" })
        .kind,
    ).toBe("markdown");
    expect(
      sessionPartSchema.parse({ kind: "thinking", id: "t1", text: "…" }).kind,
    ).toBe("thinking");
    expect(
      sessionPartSchema.parse({
        kind: "toolCall",
        id: "c1",
        name: "read_file",
        input: { path: "x" },
        status: "running",
      }).kind,
    ).toBe("toolCall");
  });

  it("parses a confirmation (blocker) part with choices", () => {
    const part = sessionPartSchema.parse({
      kind: "confirmation",
      id: "conf-1",
      prompt: "How should expired tokens be handled?",
      options: [
        {
          id: "1",
          label: "Return 401",
          detail: "matches client",
          recommended: true,
        },
        { id: "2", label: "Silently refresh" },
      ],
      allowFreeform: true,
    });
    expect(part.kind).toBe("confirmation");
    if (part.kind === "confirmation") {
      expect(part.options).toHaveLength(2);
      expect(part.options[0]?.recommended).toBe(true);
    }
  });

  it("rejects an unknown part kind", () => {
    expect(
      sessionPartSchema.safeParse({ kind: "diff", id: "d1" }).success,
    ).toBe(false);
  });
});

describe("sessionEventSchema", () => {
  it("parses append and updateStatus frames", () => {
    expect(
      sessionEventSchema.parse({
        type: "append",
        seq: 0,
        part: { kind: "markdown", id: "m1", text: "hello" },
      }).type,
    ).toBe("append");
    expect(
      sessionEventSchema.parse({
        type: "updateStatus",
        seq: 3,
        id: "c1",
        status: "done",
      }).type,
    ).toBe("updateStatus");
  });

  it("parses a resolve frame", () => {
    expect(
      sessionEventSchema.parse({ type: "resolve", seq: 5, id: "conf-1" }).type,
    ).toBe("resolve");
  });
});

describe("pendingBlockerSchema", () => {
  it("parses a question blocker carrying confirmations", () => {
    const blocker = {
      toolCallId: "toolu_017o4WdwEJb2ruJ2PawLoPyH",
      toolName: "vscode_askQuestions",
      createdAt: "2026-07-09T11:30:25.455Z",
      confirmations: [
        {
          kind: "confirmation" as const,
          id: "conf-toolu_017o4WdwEJb2ruJ2PawLoPyH-1",
          prompt: "If the file already exists, should I overwrite or append?",
          options: [
            { id: "Overwrite", label: "Overwrite", recommended: true },
            { id: "Append", label: "Append" },
          ],
        },
      ],
    };
    const parsed = pendingBlockerSchema.parse(blocker);
    expect(parsed.toolName).toBe("vscode_askQuestions");
    expect(confirmationPartSchema.parse(parsed.confirmations?.[0]).kind).toBe(
      "confirmation",
    );
  });

  it("parses an approval blocker carrying raw input", () => {
    const blocker = {
      toolCallId: "toolu_014s9ftYke93xQX364HyyaVo",
      toolName: "run_in_terminal",
      createdAt: "2026-07-09T11:42:24.584Z",
      input: { command: "rm -v /tmp/scratch.txt", explanation: "delete it" },
    };
    const parsed = pendingBlockerSchema.parse(blocker);
    expect(parsed.toolName).toBe("run_in_terminal");
    expect(parsed.confirmations).toBeUndefined();
  });

  it("rejects a blocker missing its toolCallId", () => {
    expect(
      pendingBlockerSchema.safeParse({
        toolName: "run_in_terminal",
        createdAt: "2026-07-09T11:42:24.584Z",
      }).success,
    ).toBe(false);
  });

  it("parses an approval blocker awaiting a remote decision", () => {
    const parsed = pendingBlockerSchema.parse({
      toolCallId: "toolu_014s9ftYke93xQX364HyyaVo",
      toolName: "run_in_terminal",
      createdAt: "2026-07-09T11:42:24.584Z",
      input: { command: "rm -rf build" },
      awaitingDecision: true,
    });
    expect(parsed.awaitingDecision).toBe(true);
  });

  it("parses a question blocker carrying the raw resolveId", () => {
    const parsed = pendingBlockerSchema.parse({
      toolCallId: "toolu_016e9uTUd8Cid5XYn9FYHUKG",
      toolName: "vscode_askQuestions",
      createdAt: "2026-07-09T11:42:24.584Z",
      resolveId: "toolu_016e9uTUd8Cid5XYn9FYHUKG__vscode-1783582363189",
    });
    expect(parsed.resolveId).toContain("__vscode-");
  });
});

describe("response schemas", () => {
  it("parses a successful sessions.list response", () => {
    const res = {
      id: "1",
      ok: true as const,
      op: "sessions.list" as const,
      result: [validSummary],
    };
    expect(sessionsListResponseSchema.parse(res)).toEqual(res);
  });

  it("parses a session.subscribe event frame", () => {
    const frame = {
      id: "2",
      op: "session.subscribe" as const,
      kind: "event" as const,
      event: {
        type: "append" as const,
        seq: 0,
        part: { kind: "userMessage" as const, id: "u1", text: "go" },
      },
    };
    expect(sessionSubscribeEventSchema.parse(frame)).toEqual(frame);
  });

  it("parses a session.subscribe pending snapshot frame", () => {
    const frame = {
      id: "2",
      op: "session.subscribe" as const,
      kind: "pending" as const,
      blockers: [
        {
          toolCallId: "toolu_01WPDniPbR4LTHgVs6UVj7bk",
          toolName: "vscode_askQuestions",
          createdAt: "2026-07-09T11:32:49.006Z",
          confirmations: [
            {
              kind: "confirmation" as const,
              id: "conf-toolu_01WPDniPbR4LTHgVs6UVj7bk-0",
              prompt: "Which file name should I use in /tmp/?",
              options: [
                {
                  id: "cloakcode-test.txt",
                  label: "cloakcode-test.txt",
                  recommended: true,
                },
              ],
              allowFreeform: true,
            },
          ],
        },
      ],
    };
    expect(sessionSubscribeEventSchema.parse(frame)).toEqual(frame);
  });

  it("parses a session.subscribe turn frame (live inTurn)", () => {
    const frame = {
      id: "2",
      op: "session.subscribe" as const,
      kind: "turn" as const,
      inTurn: true,
    };
    expect(sessionSubscribeEventSchema.parse(frame)).toEqual(frame);
  });

  it("discriminates subscribe frames by kind", () => {
    expect(
      sessionSubscribeEventSchema.safeParse({
        id: "2",
        op: "session.subscribe",
        kind: "pending",
        // missing blockers
      }).success,
    ).toBe(false);
  });

  it("parses an error response", () => {
    const err = { id: "1", ok: false as const, error: { message: "boom" } };
    expect(rpcErrorSchema.parse(err)).toEqual(err);
  });

  it("parses a session.decide ack", () => {
    const res = { id: "6", ok: true as const, op: "session.decide" as const };
    expect(sessionDecideResponseSchema.parse(res)).toEqual(res);
  });

  it("parses a session.answer ack", () => {
    const res = { id: "7", ok: true as const, op: "session.answer" as const };
    expect(sessionAnswerResponseSchema.parse(res)).toEqual(res);
  });

  it("parses a session.steer ack", () => {
    const res = { id: "8", ok: true as const, op: "session.steer" as const };
    expect(sessionSteerResponseSchema.parse(res)).toEqual(res);
  });

  it("parses a session.stop ack", () => {
    const res = { id: "9", ok: true as const, op: "session.stop" as const };
    expect(sessionStopResponseSchema.parse(res)).toEqual(res);
  });
});

describe("cloakcodeHelloSchema", () => {
  it("parses a provider knock", () => {
    const k = { type: "cloakcode.hello" as const, role: "provider" as const };
    expect(cloakcodeHelloSchema.parse(k)).toEqual(k);
  });

  it("parses the gateway's answering knock", () => {
    const k = { type: "cloakcode.hello" as const, role: "gateway" as const };
    expect(cloakcodeHelloSchema.parse(k)).toEqual(k);
  });

  it("rejects a frame that is not a cloakcode knock", () => {
    expect(
      cloakcodeHelloSchema.safeParse({ type: "hello", role: "provider" })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown role", () => {
    expect(
      cloakcodeHelloSchema.safeParse({
        type: "cloakcode.hello",
        role: "intruder",
      }).success,
    ).toBe(false);
  });
});

describe("connectionHelloSchema", () => {
  it("parses an operator hello", () => {
    const hello = { type: "hello" as const, role: "operator" as const };
    expect(connectionHelloSchema.parse(hello)).toEqual(hello);
  });

  it("parses a provider hello with instance info", () => {
    const hello = {
      type: "hello" as const,
      role: "provider" as const,
      provider: {
        instanceId: "devcontainer:cloakcode",
        version: "0.1.0",
        workspaceHashes: ["abc123", "def456"],
      },
    };
    const parsed = connectionHelloSchema.parse(hello);
    expect(parsed.role).toBe("provider");
    if (parsed.role === "provider") {
      expect(parsed.provider.instanceId).toBe("devcontainer:cloakcode");
    }
  });

  it("accepts a minimal provider info (instanceId only)", () => {
    expect(
      providerInfoSchema.parse({ instanceId: "local:myrepo" }).instanceId,
    ).toBe("local:myrepo");
  });

  it("rejects a provider hello with no instanceId", () => {
    expect(
      connectionHelloSchema.safeParse({
        type: "hello",
        role: "provider",
        provider: {},
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown role", () => {
    expect(
      connectionHelloSchema.safeParse({ type: "hello", role: "phone" }).success,
    ).toBe(false);
  });
});

describe("gatewayInfoSchema", () => {
  it("parses gateway info carrying a phone URL", () => {
    const info = {
      type: "gateway.info" as const,
      phoneUrl: "https://cloakcode-abc-7900.euw.devtunnels.ms",
    };
    expect(gatewayInfoSchema.parse(info)).toEqual(info);
  });

  it("parses gateway info without a phone URL (no tunnel yet)", () => {
    const info = { type: "gateway.info" as const };
    expect(gatewayInfoSchema.parse(info)).toEqual(info);
  });

  it("rejects a non-URL phone URL", () => {
    expect(
      gatewayInfoSchema.safeParse({
        type: "gateway.info",
        phoneUrl: "not a url",
      }).success,
    ).toBe(false);
  });
});
