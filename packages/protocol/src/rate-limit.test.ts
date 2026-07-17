import { describe, it, expect } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("allows up to the burst capacity, then blocks", () => {
    const rl = new RateLimiter(3, 1, () => 0); // frozen clock
    expect(rl.take()).toBe(true);
    expect(rl.take()).toBe(true);
    expect(rl.take()).toBe(true);
    expect(rl.take()).toBe(false); // bucket empty
  });

  it("refills over time at refillPerSec", () => {
    let now = 0;
    const rl = new RateLimiter(2, 2, () => now); // 2/sec
    expect(rl.take()).toBe(true);
    expect(rl.take()).toBe(true);
    expect(rl.take()).toBe(false);
    now = 500; // +0.5s -> +1 token
    expect(rl.take()).toBe(true);
    expect(rl.take()).toBe(false);
    now = 5000; // long gap -> refills, but capped at capacity
    expect(rl.take()).toBe(true);
    expect(rl.take()).toBe(true);
    expect(rl.take()).toBe(false);
  });
});
