import { describe, expect, it } from "vitest";
import { humanAge, statusLabel } from "./format";

describe("humanAge", () => {
  it("formats seconds, minutes, hours, days", () => {
    expect(humanAge(0)).toBe("0s");
    expect(humanAge(45)).toBe("45s");
    expect(humanAge(6 * 60)).toBe("6m");
    expect(humanAge(2 * 3600)).toBe("2h");
    expect(humanAge(3 * 86400)).toBe("3d");
  });

  it("never returns a negative age", () => {
    expect(humanAge(-5)).toBe("0s");
  });
});

describe("statusLabel", () => {
  it("labels each status", () => {
    expect(statusLabel("active", 0)).toBe("active");
    expect(statusLabel("blocked", 180)).toBe("blocked 3m");
    expect(statusLabel("idle", 7200)).toBe("idle 2h");
  });
});
