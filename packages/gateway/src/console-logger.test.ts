import { describe, it, expect, vi } from "vitest";
import {
  formatRecord,
  parseLogLevel,
  createConsoleLogger,
} from "./console-logger.js";

describe("parseLogLevel", () => {
  it("accepts known levels case-insensitively, rejects others", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel(" WARN ")).toBe("warn");
    expect(parseLogLevel("nope")).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });
});

describe("formatRecord", () => {
  it("renders `ts LEVEL event k=v`, quoting spaced values", () => {
    const line = formatRecord({
      ts: "2026-07-16T00:00:00.000Z",
      level: "info",
      event: "provider.connect",
      fields: { instanceId: "i7", providers: 2, note: "two now" },
    });
    expect(line).toContain("INFO ");
    expect(line).toContain("provider.connect");
    expect(line).toContain("instanceId=i7");
    expect(line).toContain("providers=2");
    expect(line).toContain('note="two now"'); // spaced value quoted
  });

  it("drops undefined fields", () => {
    const line = formatRecord({
      ts: "t",
      level: "warn",
      event: "e",
      fields: { a: 1, b: undefined },
    });
    expect(line).not.toContain("b=");
  });
});

describe("createConsoleLogger", () => {
  it("routes by level and filters below the minimum", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createConsoleLogger({
        level: "info",
        base: { component: "gateway" },
      });
      logger.debug("d"); // filtered (min info)
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      expect(log).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).toContain("component=gateway");
    } finally {
      log.mockRestore();
      warn.mockRestore();
      err.mockRestore();
    }
  });
});
