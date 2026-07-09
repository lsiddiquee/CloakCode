import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { PendingBlocker } from "@cloakcode/protocol";
import { isInteractiveTool, toConfirmations } from "./session-observer.js";

/**
 * The extension↔hook contract written by the `cloakcode` PreToolUse/PostToolUse
 * hook to a local spool file (localhost/fs only — never the network). Each line
 * is one record. `pending` marks a live blocker (the hook fired before the tool
 * ran); `resolved` clears it (the tool completed / the human answered). See
 * docs/03 "the non-intrusive live-pending notifier".
 */
export const spoolRecordSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("pending"),
    sessionId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown().optional(),
    ts: z.string(),
  }),
  z.object({
    phase: z.literal("resolved"),
    sessionId: z.string(),
    toolCallId: z.string(),
    ts: z.string(),
  }),
]);
export type SpoolRecord = z.infer<typeof spoolRecordSchema>;

/** Default spool location, shared by the hook command and the bridge. */
export function defaultSpoolFile(): string {
  return path.join(os.homedir(), ".cloakcode", "hook-spool.jsonl");
}

/**
 * Map a Copilot hook invocation (event name + stdin payload) to a spool record,
 * or `undefined` when the event is not one we notify on / lacks routing keys.
 * Pure so the hook command's I/O shell stays trivial and this stays tested.
 */
export function buildSpoolRecord(
  event: string,
  stdin: unknown,
  ts: string,
): SpoolRecord | undefined {
  const s = (typeof stdin === "object" && stdin ? stdin : {}) as Record<
    string,
    unknown
  >;
  const sessionId = String(s["session_id"] ?? "");
  const toolCallId = String(s["tool_use_id"] ?? "");
  if (!sessionId || !toolCallId) return undefined;
  if (event === "PreToolUse") {
    return {
      phase: "pending",
      sessionId,
      toolCallId,
      toolName: String(s["tool_name"] ?? ""),
      input: s["tool_input"] ?? null,
      ts,
    };
  }
  if (event === "PostToolUse") {
    return { phase: "resolved", sessionId, toolCallId, ts };
  }
  return undefined;
}

/**
 * Strip the `__vscode-<n>` suffix the hook receives so the id matches the
 * transcript's `toolCallId` (docs/02 §4.6 — this is the dedup join key).
 */
export function baseToolCallId(raw: string): string {
  const i = raw.indexOf("__vscode-");
  return i === -1 ? raw : raw.slice(0, i);
}

/** Parse a spool JSONL body into valid records, tolerant of blank/garbage lines. */
export function parseSpool(content: string): SpoolRecord[] {
  const out: SpoolRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = spoolRecordSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Collect the base `toolCallId`s already present in a transcript body. */
export function transcriptToolCallIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: { type?: string; data?: { toolCallId?: unknown } };
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (raw.type === "tool.execution_start" && raw.data?.toolCallId != null) {
      ids.add(baseToolCallId(String(raw.data.toolCallId)));
    }
  }
  return ids;
}

/**
 * Compute the live-pending overlay for one session: base `toolCallId`s that are
 * `pending`, minus those later `resolved`, minus any already on disk in the
 * transcript (belt-and-suspenders dedup so a missed `resolved` can never strand
 * a card). Replace-snapshot semantics — the caller pushes the whole list.
 */
export function computePendingBlockers(
  records: readonly SpoolRecord[],
  sessionId: string,
  transcriptIds: ReadonlySet<string> = new Set(),
): PendingBlocker[] {
  const pending = new Map<string, PendingBlocker>();
  const resolved = new Set<string>();

  for (const r of records) {
    if (r.sessionId !== sessionId) continue;
    const base = baseToolCallId(r.toolCallId);
    if (r.phase === "resolved") {
      resolved.add(base);
      pending.delete(base);
      continue;
    }
    if (resolved.has(base)) continue;
    pending.set(base, {
      toolCallId: base,
      toolName: r.toolName,
      createdAt: r.ts,
      ...(isInteractiveTool(r.toolName)
        ? { confirmations: toConfirmations(`conf-${base}`, r.input) }
        : { input: r.input ?? null }),
    });
  }

  for (const base of transcriptIds) pending.delete(base);
  return [...pending.values()];
}

export type PendingSink = (blockers: PendingBlocker[]) => void;

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Tails the (global) hook spool and the subscribed session's transcript, and
 * emits the live-pending overlay as a replace-snapshot for that session. Mirrors
 * `SessionFollower`'s hybrid `fs.watch` + poll strategy (dev-container overlays
 * drop inotify events) and serializes on a promise queue. Emits only when the
 * snapshot changes, so redundant flushes never spam the client. Recompute is
 * triggered by EITHER file changing — a transcript flush can retire a blocker
 * via the dedup subtraction just as a `resolved` spool line can.
 */
export class SpoolFollower {
  private watchers: fsSync.FSWatcher[] = [];
  private poller: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private last: string | undefined;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly spoolFile: string,
    private readonly transcriptFile: string,
    private readonly sessionId: string,
    private readonly sink: PendingSink,
    options: { pollIntervalMs?: number } = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
  }

  async start(): Promise<void> {
    await this.refresh();
    if (this.stopped) return;
    for (const file of [this.spoolFile, this.transcriptFile]) {
      try {
        this.watchers.push(fsSync.watch(file, () => void this.refresh()));
      } catch {
        // file may not exist yet; the poll fallback covers it
      }
    }
    if (this.pollIntervalMs > 0) {
      this.poller = setInterval(() => void this.refresh(), this.pollIntervalMs);
      this.poller.unref();
    }
  }

  refresh(): Promise<void> {
    this.queue = this.queue.then(() => this.pump());
    return this.queue;
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    const [spool, transcript] = await Promise.all([
      readOrEmpty(this.spoolFile),
      readOrEmpty(this.transcriptFile),
    ]);
    if (this.stopped) return;
    const blockers = computePendingBlockers(
      parseSpool(spool),
      this.sessionId,
      transcriptToolCallIds(transcript),
    );
    const snapshot = JSON.stringify(blockers);
    if (snapshot === this.last) return;
    this.last = snapshot;
    this.sink(blockers);
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = undefined;
    }
  }
}
