import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Watches a directory and fires a **debounced** callback when its contents
 * change (a file appears/disappears, or an existing file's mtime/size moves).
 * Coalesces a burst — a rehydration flush or a turn-boundary write — into a
 * single notification.
 *
 * Uses `fs.watch` for immediacy AND a poll fallback: dev-container overlay
 * filesystems routinely drop inotify events (the same reason `SessionFollower`
 * watches + polls). Both triggers re-derive a cheap **signature** of the
 * directory (name + mtime + size per entry) and only schedule the callback when
 * it actually moved — so a spurious `fs.watch` fire or an idle poll never fires
 * `onChange`. Non-recursive (the immediate dir only) and safe to start on a dir
 * that does not exist yet (the poll picks it up when it appears).
 *
 * Pure node/fs — no `vscode` — so it is unit-testable without an extension host.
 */
export class DirectoryWatcher {
  private watcher: fsSync.FSWatcher | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSignature = "";
  private stopped = false;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void,
    options: { debounceMs?: number; pollIntervalMs?: number } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 300;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  /** Seed the current signature (so pre-existing files don't fire), then watch. */
  async start(): Promise<void> {
    this.lastSignature = await this.signature();
    if (this.stopped) return;
    try {
      this.watcher = fsSync.watch(this.dir, () => void this.check());
    } catch {
      // Dir missing / unwatchable — the poll fallback covers it (and retries
      // once the dir appears).
    }
    if (this.pollIntervalMs > 0) {
      this.poller = setInterval(() => void this.check(), this.pollIntervalMs);
      this.poller.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  /** Re-derive the signature; if it moved, (re)arm the debounce. */
  private async check(): Promise<void> {
    if (this.stopped) return;
    const sig = await this.signature();
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (!this.stopped) this.onChange();
    }, this.debounceMs);
  }

  /** A cheap content signature: `name:mtimeMs:size` per entry, order-stable. */
  private async signature(): Promise<string> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return ""; // dir absent — a stable "empty" signature
    }
    const parts = await Promise.all(
      names.sort().map(async (name) => {
        try {
          const s = await fs.stat(path.join(this.dir, name));
          return `${name}:${s.mtimeMs}:${s.size}`;
        } catch {
          return `${name}:?`;
        }
      }),
    );
    return parts.join("|");
  }
}
