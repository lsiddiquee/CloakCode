import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DirectoryWatcher } from "./dir-watcher.js";

const dirs: string[] = [];
const watchers: DirectoryWatcher[] = [];

afterEach(async () => {
  for (const w of watchers.splice(0)) w.stop();
  for (const d of dirs.splice(0))
    await fs.rm(d, { recursive: true, force: true });
});

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "cc-dirw-"));
  dirs.push(d);
  return d;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await sleep(10);
}

function track(
  dir: string,
  onChange: () => void,
  opts: { debounceMs?: number; pollIntervalMs?: number },
): DirectoryWatcher {
  const w = new DirectoryWatcher(dir, onChange, opts);
  watchers.push(w);
  return w;
}

describe("DirectoryWatcher", () => {
  it("fires a debounced onChange when a new file appears", async () => {
    const dir = await tmpDir();
    let fires = 0;
    const w = track(dir, () => (fires += 1), {
      debounceMs: 20,
      pollIntervalMs: 15,
    });
    await w.start();
    expect(fires).toBe(0); // seeded — no fire for the pre-existing/empty state

    await fs.writeFile(path.join(dir, "s1.jsonl"), "x");
    await waitFor(() => fires >= 1);
    expect(fires).toBeGreaterThanOrEqual(1);
  });

  it("coalesces a burst of writes into a single onChange", async () => {
    const dir = await tmpDir();
    let fires = 0;
    const w = track(dir, () => (fires += 1), {
      debounceMs: 80,
      pollIntervalMs: 15,
    });
    await w.start();

    for (let i = 0; i < 5; i += 1) {
      await fs.writeFile(path.join(dir, `s${i}.jsonl`), "x");
      await sleep(10); // writes 10ms apart, well inside the 80ms debounce
    }
    await waitFor(() => fires >= 1);
    await sleep(150); // let any extra debounce windows settle
    expect(fires).toBe(1);
  });

  it("does not fire while the directory is unchanged", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "s0.jsonl"), "seed");
    let fires = 0;
    const w = track(dir, () => (fires += 1), {
      debounceMs: 20,
      pollIntervalMs: 15,
    });
    await w.start();
    await sleep(90); // several poll intervals, no changes
    expect(fires).toBe(0);
  });

  it("stops firing after stop()", async () => {
    const dir = await tmpDir();
    let fires = 0;
    const w = track(dir, () => (fires += 1), {
      debounceMs: 20,
      pollIntervalMs: 15,
    });
    await w.start();
    w.stop();
    await fs.writeFile(path.join(dir, "s1.jsonl"), "x");
    await sleep(90);
    expect(fires).toBe(0);
  });
});
