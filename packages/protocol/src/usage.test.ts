import { describe, expect, it } from "vitest";
import { sumUsage, summarizeUsage, type UsagePart } from "./index.js";

const usage = (over: Partial<UsagePart>): UsagePart => ({
  kind: "usage",
  id: "usage-0",
  model: "claude-opus-4.8",
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 80,
  ...over,
});

describe("sumUsage", () => {
  it("sums tokens + AIU + requests and collects distinct models in first-seen order", () => {
    const t = sumUsage([
      usage({
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 80,
        nanoAiu: 1_500_000_000,
      }),
      usage({
        model: "gpt-5",
        inputTokens: 200,
        outputTokens: 30,
        cachedTokens: 0,
        nanoAiu: 500_000_000,
      }),
    ]);
    expect(t.requests).toBe(2);
    expect(t.inputTokens).toBe(300);
    expect(t.outputTokens).toBe(50);
    expect(t.cachedTokens).toBe(80);
    expect(t.aiu).toBeCloseTo(2, 5);
    expect(t.models).toEqual(["claude-opus-4.8", "gpt-5"]);
  });

  it("omits aiu/credits when none reported", () => {
    const t = sumUsage([usage({})]);
    expect(t.aiu).toBeUndefined();
    expect(t.credits).toBeUndefined();
  });

  it("treats a 0 cost (custom / BYO model) as unavailable — no misleading 0 AIU", () => {
    const t = sumUsage([
      usage({ id: "usage-0", nanoAiu: 0 }),
      usage({ id: "usage-1" }), // no nanoAiu at all
    ]);
    expect(t.aiu).toBeUndefined();
    expect(t.inputTokens).toBe(200); // token counts still aggregate
  });

  it("sums credits when reported (Windows store)", () => {
    const t = sumUsage([usage({ credits: 3 }), usage({ credits: 4 })]);
    expect(t.credits).toBe(7);
  });
});

describe("summarizeUsage", () => {
  it("returns null when there is no telemetry (a pure-transcript session)", () => {
    expect(summarizeUsage([], false)).toBeNull();
  });

  it("attaches the server-computed partial flag to the total", () => {
    const partialTrue = summarizeUsage([usage({})], true)!;
    expect(partialTrue.partial).toBe(true);
    expect(partialTrue.requests).toBe(1);

    const partialFalse = summarizeUsage([usage({})], false)!;
    expect(partialFalse.partial).toBe(false);
  });
});
