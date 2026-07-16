import { describe, it, expect, vi } from "vitest";
import {
  createLogger,
  newTraceId,
  shouldLog,
  LOG_LEVELS,
  type LogRecord,
} from "./logger.js";

describe("shouldLog", () => {
  it("emits at or above the minimum, drops below", () => {
    expect(shouldLog("info", "warn")).toBe(true);
    expect(shouldLog("info", "info")).toBe(true);
    expect(shouldLog("info", "debug")).toBe(false);
    expect(shouldLog("error", "warn")).toBe(false);
    expect(shouldLog("trace", "trace")).toBe(true);
  });

  it("orders levels trace<debug<info<warn<error", () => {
    expect(LOG_LEVELS).toEqual(["trace", "debug", "info", "warn", "error"]);
  });
});

describe("createLogger", () => {
  it("filters by minimum level (default info)", () => {
    const records: LogRecord[] = [];
    const log = createLogger({ sink: (r) => records.push(r) });
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(records.map((r) => r.level)).toEqual(["info", "warn", "error"]);
  });

  it("stamps ts + event + merges base and call fields", () => {
    const records: LogRecord[] = [];
    const log = createLogger({
      sink: (r) => records.push(r),
      level: "trace",
      base: { component: "gateway" },
    });
    log.info("bridge.listen", { port: 3543 });
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.event).toBe("bridge.listen");
    expect(r.fields).toEqual({ component: "gateway", port: 3543 });
    expect(typeof r.ts).toBe("string");
    expect(() => new Date(r.ts).toISOString()).not.toThrow();
  });

  it("child() binds extra context (e.g. traceId) without mutating the parent", () => {
    const records: LogRecord[] = [];
    const log = createLogger({
      sink: (r) => records.push(r),
      level: "trace",
      base: { component: "extension" },
    });
    const scoped = log.child({ traceId: "abc123", sessionId: "s1" });
    scoped.info("actuator.respond", { action: "respond" });
    log.info("plain");
    expect(records[0]!.fields).toEqual({
      component: "extension",
      traceId: "abc123",
      sessionId: "s1",
      action: "respond",
    });
    expect(records[1]!.fields).toEqual({ component: "extension" }); // parent unchanged
  });

  it("re-reads a dynamic level so a host can change it at runtime", () => {
    const records: LogRecord[] = [];
    let level: "debug" | "warn" = "warn";
    const log = createLogger({
      sink: (r) => records.push(r),
      level: () => level,
    });
    log.debug("d1"); // dropped (min warn)
    level = "debug";
    log.debug("d2"); // now emitted
    expect(records.map((r) => r.event)).toEqual(["d2"]);
    expect(log.level).toBe("debug");
  });

  it("never calls the sink for a filtered record", () => {
    const sink = vi.fn();
    const log = createLogger({ sink, level: "error" });
    log.info("dropped");
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("newTraceId", () => {
  it("mints a short, unique-ish, hyphen-free id", () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).toMatch(/^[a-z0-9]+$/i);
    expect(a).not.toContain("-");
    expect(a.length).toBeLessThanOrEqual(12);
    expect(a).not.toBe(b);
  });
});
