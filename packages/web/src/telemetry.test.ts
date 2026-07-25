import { describe, expect, it } from "vitest";
import type { SessionPart } from "@cloakcode/protocol";
import { compactTokens, formatAiu, interleaveTurnUsage } from "./telemetry";

const usage = (over: Partial<Extract<SessionPart, { kind: "usage" }>>) =>
  ({
    kind: "usage",
    id: "usage-0",
    model: "claude-opus-4.8",
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 80,
    ...over,
  }) satisfies SessionPart;

const md = (id: string): SessionPart => ({ kind: "markdown", id, text: "hi" });
const user = (id: string): SessionPart => ({
  kind: "userMessage",
  id,
  text: "go",
});

describe("compactTokens", () => {
  it("formats small, K, and M ranges", () => {
    expect(compactTokens(178)).toBe("178");
    expect(compactTokens(1250)).toBe("1.3K");
    expect(compactTokens(364615)).toBe("365K");
    expect(compactTokens(1_250_000)).toBe("1.3M");
    expect(compactTokens(12_000_000)).toBe("12M");
  });
});

describe("formatAiu", () => {
  it("scales precision by magnitude", () => {
    expect(formatAiu(0.42)).toBe("0.42");
    expect(formatAiu(18.9)).toBe("18.9");
    expect(formatAiu(1204)).toBe((1204).toLocaleString());
  });
});

describe("interleaveTurnUsage", () => {
  it("collapses a turn's usage spans into one badge at the end of the turn", () => {
    const rows = interleaveTurnUsage([
      user("u0"),
      usage({ id: "usage-0", outputTokens: 20, nanoAiu: 1_000_000_000 }),
      usage({ id: "usage-1", outputTokens: 30, nanoAiu: 500_000_000 }),
      md("m0"),
      user("u1"),
      usage({ id: "usage-2", outputTokens: 5 }),
      md("m1"),
    ]);
    // u0 · m0 · [turn0 badge] · u1 · m1 · [turn1 badge]
    expect(rows.map((r) => r.kind)).toEqual([
      "part",
      "part",
      "turnUsage",
      "part",
      "part",
      "turnUsage",
    ]);
    const turn0 = rows[2];
    if (turn0?.kind !== "turnUsage") throw new Error("expected turnUsage");
    expect(turn0.usage.requests).toBe(2);
    expect(turn0.usage.outputTokens).toBe(50);
    expect(turn0.usage.aiu).toBeCloseTo(1.5, 5);
    const turn1 = rows[5];
    if (turn1?.kind !== "turnUsage") throw new Error("expected turnUsage");
    expect(turn1.usage.requests).toBe(1);
  });

  it("emits no badge for a turn with no telemetry (transcript history)", () => {
    const rows = interleaveTurnUsage([user("tx-u0"), md("tx-m0")]);
    expect(rows.every((r) => r.kind === "part")).toBe(true);
  });
});
