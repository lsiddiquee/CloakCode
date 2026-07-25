import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TailReader } from "./tail-reader.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0))
    await fs.rm(d, { recursive: true, force: true });
});

async function tmpFile(content = ""): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "cc-tail-"));
  dirs.push(d);
  const f = path.join(d, "log.jsonl");
  await fs.writeFile(f, content);
  return f;
}

describe("TailReader", () => {
  it("returns complete lines and buffers a partial trailing line", async () => {
    const f = await tmpFile("a\nb\nc"); // "c" has no trailing newline
    const r = new TailReader(f);
    expect((await r.read()).lines).toEqual(["a", "b"]); // "c" buffered
    expect(r.drainPartial()).toBe("c");
    expect(r.drainPartial()).toBeUndefined();
  });

  it("reads only the NEW lines on a subsequent read (append)", async () => {
    const f = await tmpFile("a\nb\n");
    const r = new TailReader(f);
    expect((await r.read()).lines).toEqual(["a", "b"]);
    await fs.appendFile(f, "c\nd\n");
    expect((await r.read()).lines).toEqual(["c", "d"]);
    expect((await r.read()).lines).toEqual([]); // nothing new
  });

  it("completes a buffered partial line when its newline arrives later", async () => {
    const f = await tmpFile("a\nhalf");
    const r = new TailReader(f);
    expect((await r.read()).lines).toEqual(["a"]); // "half" buffered
    await fs.appendFile(f, "-rest\nb\n");
    expect((await r.read()).lines).toEqual(["half-rest", "b"]);
  });

  it("reassembles lines split across small chunk boundaries", async () => {
    const f = await tmpFile("alpha\nbeta\ngamma\n");
    const r = new TailReader(f, 3); // tiny chunks split every line mid-way
    expect((await r.read()).lines).toEqual(["alpha", "beta", "gamma"]);
  });

  it("does not corrupt a multibyte UTF-8 char split across a chunk boundary", async () => {
    const f = await tmpFile("x🎉y\n"); // 🎉 is 4 bytes
    const r = new TailReader(f, 1); // 1-byte chunks split the emoji
    expect((await r.read()).lines).toEqual(["x🎉y"]);
  });

  it("resets on shrink (truncation/rotation) and re-reads from the start", async () => {
    const f = await tmpFile("a\nb\nc\n");
    const r = new TailReader(f);
    expect((await r.read()).lines).toEqual(["a", "b", "c"]);
    await fs.writeFile(f, "z\n"); // the file shrank (rotation)
    const { lines, reset } = await r.read();
    expect(reset).toBe(true);
    expect(lines).toEqual(["z"]);
    expect(r.position).toBe(2);
  });

  it("honors a caller-provided size (skips its own stat)", async () => {
    const f = await tmpFile("a\nb\nc\n");
    const r = new TailReader(f);
    // Only reveal the first 4 bytes ("a\nb\n") to the reader.
    expect((await r.read(4)).lines).toEqual(["a", "b"]);
    expect(r.position).toBe(4);
    expect((await r.read(6)).lines).toEqual(["c"]);
  });

  it("returns nothing for a missing file (no throw)", async () => {
    const r = new TailReader("/no/such/dir/log.jsonl");
    expect(await r.read()).toEqual({ lines: [], reset: false });
  });
});
