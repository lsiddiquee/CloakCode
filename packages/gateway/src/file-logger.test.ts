import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileLogSink } from "./file-logger.js";
import type { LogRecord } from "@cloakcode/protocol";

const rec = (event: string, fields: LogRecord["fields"] = {}): LogRecord => ({
  ts: "2026-07-16T00:00:00.000Z",
  level: "info",
  event,
  fields,
});

// The sink is fire-and-forget; give the async appends a tick to flush.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

describe("fileLogSink", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("appends each record as one JSON line, creating the parent dir", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-glog-"));
    const file = path.join(dir, "nested", "gateway.jsonl");
    const sink = fileLogSink(file);
    sink(rec("rpc.relay", { op: "session.respond", traceId: "t1" }));
    sink(rec("provider.connect", { instanceId: "i1" }));
    await settle();

    const lines = (await fs.readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as LogRecord);
    expect(lines).toHaveLength(2);
    // Fire-and-forget: both records land, but back-to-back append order isn't
    // guaranteed (each call is its own mkdir→append chain), so assert the set.
    const byEvent = new Map(lines.map((r) => [r.event, r]));
    expect(byEvent.get("rpc.relay")?.fields["op"]).toBe("session.respond");
    expect(byEvent.has("provider.connect")).toBe(true);
  });

  it("never throws on a bad path (best-effort — logging can't break the relay)", async () => {
    // A path whose parent can't be created (a file used as a directory).
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-glog-"));
    const asFile = path.join(dir, "blocker");
    await fs.writeFile(asFile, "x");
    const sink = fileLogSink(path.join(asFile, "cant", "log.jsonl"));
    expect(() => sink(rec("rpc.relay"))).not.toThrow();
    await settle();
  });
});
