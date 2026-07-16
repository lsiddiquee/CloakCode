import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sessionLogSink } from "./session-log.js";
import type { LogRecord } from "@cloakcode/protocol";

const rec = (
  fields: LogRecord["fields"],
  event = "actuator.respond",
): LogRecord => ({
  ts: "2026-07-16T00:00:00.000Z",
  level: "info",
  event,
  fields,
});

// The sink is fire-and-forget; give the async appends a tick to flush.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

describe("sessionLogSink", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("appends session-scoped records to <dir>/<sessionId>.jsonl", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-sl-"));
    const sink = sessionLogSink(dir);
    sink(rec({ sessionId: "sessA", action: "steer" }));
    sink(rec({ sessionId: "sessA", action: "stop" }));
    sink(rec({ sessionId: "sessB", action: "respond" }));
    await settle();

    const a = (await fs.readFile(path.join(dir, "sessA.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as LogRecord);
    expect(a).toHaveLength(2);
    // Fire-and-forget: both records land, but back-to-back append order isn't
    // guaranteed (each call is its own mkdir→append chain), so assert the set.
    expect(a.map((r) => r.fields["action"]).sort()).toEqual(["steer", "stop"]);

    const b = JSON.parse(
      (await fs.readFile(path.join(dir, "sessB.jsonl"), "utf8")).trim(),
    ) as LogRecord;
    expect(b.fields["action"]).toBe("respond");
  });

  it("skips records with no sessionId (channel-only, no file written)", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-sl-"));
    sessionLogSink(dir)(rec({ port: 3543 }, "bridge.listen"));
    await settle();
    expect(await fs.readdir(dir).catch(() => [])).toEqual([]);
  });

  it("sanitizes a sessionId so it can't escape the dir", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-sl-"));
    sessionLogSink(dir)(rec({ sessionId: "../evil/x", action: "respond" }));
    await settle();
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/[/\\]/); // no path separators survived
  });
});
