import { describe, it, expect } from "vitest";
import { createOutputChannelLogger } from "./logger.js";

describe("createOutputChannelLogger", () => {
  it("writes formatted lines to the channel and honours a dynamic level", () => {
    const lines: string[] = [];
    const channel = { appendLine: (l: string) => lines.push(l) };
    let level: "debug" | "info" = "info";
    const log = createOutputChannelLogger(channel, () => level, {
      component: "extension",
    });

    log.debug("obs.scan"); // filtered at info
    log.info("bridge.listen", { port: 3543 });
    level = "debug";
    log.debug("actuator.steer", { sessionId: "s1" });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("INFO ");
    expect(lines[0]).toContain("bridge.listen");
    expect(lines[0]).toContain("component=extension");
    expect(lines[0]).toContain("port=3543");
    expect(lines[1]).toContain("DEBUG");
    expect(lines[1]).toContain("actuator.steer");
    expect(lines[1]).toContain("sessionId=s1");
  });
});
