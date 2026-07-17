import { describe, it, expect } from "vitest";
import { Secret } from "otpauth";
import {
  MAX_AUTH_ATTEMPTS,
  OperatorAuth,
  OperatorGate,
} from "./operator-auth.js";

// RFC 6238 seed → base32; code "287082" is valid at t=59s.
const SECRET = Secret.fromLatin1("12345678901234567890").base32;
const now = () => 59_000;
const auth = () => new OperatorAuth({ secret: SECRET, now });

describe("OperatorAuth", () => {
  it("accepts a valid code once and issues a token, then rejects the replay", () => {
    const a = auth();
    const first = a.submitCode("287082");
    expect(first.ok).toBe(true);
    expect(typeof first.token).toBe("string");
    expect(first.expiresAt).toBe(59_000 + 12 * 60 * 60 * 1000);
    const replay = a.submitCode("287082");
    expect(replay).toEqual({ ok: false, error: "code already used" });
  });

  it("rejects an invalid code", () => {
    expect(auth().submitCode("000000")).toEqual({
      ok: false,
      error: "invalid code",
    });
  });

  it("gives 'remember' a 30-day token", () => {
    const res = auth().submitCode("287082", true);
    expect(res.expiresAt).toBe(59_000 + 30 * 24 * 60 * 60 * 1000);
  });

  it("verifies a token it issued and rejects garbage", () => {
    const a = auth();
    const { token } = a.submitCode("287082");
    expect(a.verifyToken(token!)).toBe(true);
    expect(a.verifyToken("nope")).toBe(false);
  });
});

describe("OperatorGate — auth disabled", () => {
  it("is open: every frame proceeds", () => {
    const gate = new OperatorGate(undefined);
    expect(gate.authenticated).toBe(true);
    expect(gate.check({ id: "1", op: "sessions.list" })).toEqual({
      kind: "proceed",
    });
  });
});

describe("OperatorGate — auth enabled", () => {
  it("refuses a session op with needsAuth until authenticated", () => {
    const gate = new OperatorGate(auth());
    const d = gate.check({ id: "1", op: "sessions.list" });
    expect(d).toMatchObject({
      kind: "reply",
      response: { id: "1", ok: false, needsAuth: true },
    });
    expect(gate.authenticated).toBe(false);
  });

  it("authenticates on a valid code, returns a token, then proceeds", () => {
    const gate = new OperatorGate(auth());
    const d = gate.check({ id: "2", op: "auth", params: { code: "287082" } });
    expect(d).toMatchObject({
      kind: "reply",
      response: { id: "2", ok: true, op: "auth" },
    });
    expect(
      (d as { response: { token?: string } }).response.token,
    ).toBeDefined();
    expect(gate.authenticated).toBe(true);
    expect(gate.check({ id: "3", op: "sessions.list" })).toEqual({
      kind: "proceed",
    });
  });

  it("resumes with a valid session token (no code)", () => {
    const a = auth();
    const { token } = a.submitCode("287082");
    const gate = new OperatorGate(a);
    const d = gate.check({ id: "4", op: "auth", params: { token } });
    expect(d).toMatchObject({
      kind: "reply",
      response: { id: "4", ok: true, op: "auth" },
    });
    expect(gate.authenticated).toBe(true);
  });

  it("locks out after too many bad codes", () => {
    const gate = new OperatorGate(auth());
    for (let i = 1; i < MAX_AUTH_ATTEMPTS; i++) {
      expect(
        gate.check({ id: `${i}`, op: "auth", params: { code: "000000" } }).kind,
      ).toBe("reply");
    }
    const last = gate.check({
      id: "x",
      op: "auth",
      params: { code: "000000" },
    });
    expect(last.kind).toBe("close");
    expect(gate.authenticated).toBe(false);
  });

  it("re-acks an auth frame once already authenticated", () => {
    const gate = new OperatorGate(auth());
    gate.check({ id: "2", op: "auth", params: { code: "287082" } });
    expect(gate.check({ id: "5", op: "auth" })).toEqual({
      kind: "reply",
      response: { id: "5", ok: true, op: "auth" },
    });
  });
});
