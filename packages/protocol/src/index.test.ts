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
  type SessionSummary,
} from "./index.js";

const validSummary: SessionSummary = {
  instanceId: "inst-abc",
  sessionId: "56514ca7-1111",
  workspace: "myrepo",
  title: "Refactor auth middleware",
  turns: 12,
  status: "blocked",
  idleSeconds: 3,
};

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

  it("parses a session.subscribe request and defaults sinceSeq", () => {
    const parsed = rpcRequestSchema.parse({
      id: "2",
      op: "session.subscribe",
      params: { instanceId: "inst", sessionId: "sessA" },
    });
    expect(parsed).toEqual({
      id: "2",
      op: "session.subscribe",
      params: { instanceId: "inst", sessionId: "sessA", sinceSeq: 0 },
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
        instanceId: "inst",
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

  it("parses a session.respond chat message with no toolCallId", () => {
    const parsed = rpcRequestSchema.parse({
      id: "4",
      op: "session.respond",
      params: { instanceId: "inst", sessionId: "sessA", text: "run the tests" },
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
          instanceId: "inst",
          sessionId: "sessA",
          toolCallId: "t1",
          text: "",
        },
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
});
