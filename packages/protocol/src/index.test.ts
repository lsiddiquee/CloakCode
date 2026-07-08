import { describe, it, expect } from "vitest";
import {
  sessionStatusSchema,
  sessionSummarySchema,
  sessionPartSchema,
  sessionEventSchema,
  sessionSubscribeEventSchema,
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
});

describe("sessionPartSchema", () => {
  it("parses each I1 part kind", () => {
    expect(
      sessionPartSchema.parse({ kind: "userMessage", id: "u1", text: "hi" }).kind,
    ).toBe("userMessage");
    expect(
      sessionPartSchema.parse({ kind: "markdown", id: "m1", text: "**x**" }).kind,
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

  it("rejects an unknown part kind", () => {
    expect(sessionPartSchema.safeParse({ kind: "diff", id: "d1" }).success).toBe(
      false,
    );
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
      event: {
        type: "append" as const,
        seq: 0,
        part: { kind: "userMessage" as const, id: "u1", text: "go" },
      },
    };
    expect(sessionSubscribeEventSchema.parse(frame)).toEqual(frame);
  });

  it("parses an error response", () => {
    const err = { id: "1", ok: false as const, error: { message: "boom" } };
    expect(rpcErrorSchema.parse(err)).toEqual(err);
  });
});
