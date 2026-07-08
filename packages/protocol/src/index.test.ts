import { describe, it, expect } from "vitest";
import {
  sessionStatusSchema,
  sessionSummarySchema,
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

  it("rejects an unknown op", () => {
    expect(
      rpcRequestSchema.safeParse({ id: "1", op: "sessions.nope" }).success,
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

  it("parses an error response", () => {
    const err = { id: "1", ok: false as const, error: { message: "boom" } };
    expect(rpcErrorSchema.parse(err)).toEqual(err);
  });
});
