import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { DEFAULT_PORT } from "@cloakcode/protocol";
import { resolvePortPlan, listenWithFallback } from "./listen.js";

describe("resolvePortPlan", () => {
  it("nothing set → prefer DEFAULT_PORT with ephemeral fallback", () => {
    const plan = { port: DEFAULT_PORT, fallbackToEphemeral: true };
    expect(resolvePortPlan(undefined, undefined)).toEqual(plan);
    expect(resolvePortPlan(undefined, null)).toEqual(plan);
    expect(resolvePortPlan("   ", undefined)).toEqual(plan); // blank env
  });

  it("explicit 0 → ephemeral, no fallback", () => {
    expect(resolvePortPlan("0", undefined)).toEqual({
      port: 0,
      fallbackToEphemeral: false,
    });
    expect(resolvePortPlan(undefined, 0)).toEqual({
      port: 0,
      fallbackToEphemeral: false,
    });
  });

  it("explicit N (>0) → locked N, no fallback", () => {
    expect(resolvePortPlan("8080", undefined)).toEqual({
      port: 8080,
      fallbackToEphemeral: false,
    });
    expect(resolvePortPlan(undefined, 7801)).toEqual({
      port: 7801,
      fallbackToEphemeral: false,
    });
  });

  it("env wins over the setting", () => {
    expect(resolvePortPlan("8080", 7801).port).toBe(8080);
    expect(resolvePortPlan("0", 7801)).toEqual({
      port: 0,
      fallbackToEphemeral: false,
    });
  });

  it("invalid env falls through to the setting / default", () => {
    expect(resolvePortPlan("nope", 7801).port).toBe(7801);
    expect(resolvePortPlan("-5", undefined)).toEqual({
      port: DEFAULT_PORT,
      fallbackToEphemeral: true,
    });
  });
});

describe("listenWithFallback", () => {
  const mk = (): http.Server => http.createServer();

  it("binds the requested port and returns it", async () => {
    const s = mk();
    const p = await listenWithFallback(s, "127.0.0.1", 0, false); // ephemeral
    expect(p).toBeGreaterThan(0);
    await new Promise((r) => s.close(() => r(undefined)));
  });

  it("falls back to an ephemeral port when the port is taken (fallback on)", async () => {
    const a = mk();
    const pa = await listenWithFallback(a, "127.0.0.1", 0, false);
    const b = mk();
    const pb = await listenWithFallback(b, "127.0.0.1", pa, true); // pa is taken
    expect(pb).toBeGreaterThan(0);
    expect(pb).not.toBe(pa);
    await new Promise((r) => a.close(() => r(undefined)));
    await new Promise((r) => b.close(() => r(undefined)));
  });

  it("rejects with EADDRINUSE when the port is taken and fallback is off", async () => {
    const a = mk();
    const pa = await listenWithFallback(a, "127.0.0.1", 0, false);
    const b = mk();
    await expect(
      listenWithFallback(b, "127.0.0.1", pa, false),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    await new Promise((r) => a.close(() => r(undefined)));
  });
});
