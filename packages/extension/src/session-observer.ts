import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type {
  Choice,
  SessionEvent,
  SessionPart,
  ToolStatus,
} from "@cloakcode/protocol";
import { INTERACTIVE_TOOL_HINTS } from "./scanner.js";

/**
 * Port of `research/inspect_session.py`, mapping the on-disk event stream onto
 * `SessionPart`s (docs/03 mapping table). Pure + deterministic: the derived
 * event sequence is a stable prefix as the append-only transcript grows, so a
 * client can resume from any `seq`.
 */

interface RawEvent {
  type?: string;
  data?: {
    content?: unknown;
    reasoningText?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    arguments?: unknown;
    success?: unknown;
  };
}

const toolPartId = (toolCallId: unknown): string =>
  `tool-${String(toolCallId)}`;
const confPartId = (toolCallId: unknown): string =>
  `conf-${String(toolCallId)}`;

function isInteractiveTool(toolName: unknown): boolean {
  const name = String(toolName ?? "").toLowerCase();
  return INTERACTIVE_TOOL_HINTS.some((hint) => name.includes(hint));
}

/**
 * Build a `confirmation` part from an interactive tool's `arguments`. Tolerant
 * of shape (the blocker payload carries the full question + options) — see
 * docs/02 §3.2.
 */
function toConfirmation(
  id: string,
  args: unknown,
): Extract<SessionPart, { kind: "confirmation" }> {
  const a = (typeof args === "object" && args ? args : {}) as Record<
    string,
    unknown
  >;
  const prompt = String(
    a["question"] ?? a["prompt"] ?? a["message"] ?? a["title"] ?? "Confirm",
  );
  const rawOptions = Array.isArray(a["options"])
    ? a["options"]
    : Array.isArray(a["choices"])
      ? a["choices"]
      : [];
  const options: Choice[] = rawOptions.map((o: unknown, i: number) => {
    const oo = (typeof o === "object" && o ? o : {}) as Record<string, unknown>;
    const detailRaw = oo["detail"] ?? oo["description"];
    return {
      id: String(oo["id"] ?? oo["value"] ?? oo["label"] ?? i),
      label: String(oo["label"] ?? oo["title"] ?? oo["name"] ?? oo["value"] ?? o),
      ...(detailRaw !== undefined && detailRaw !== null
        ? { detail: String(detailRaw) }
        : {}),
      ...(oo["recommended"] ? { recommended: true } : {}),
    };
  });
  return { kind: "confirmation", id, prompt, options, allowFreeform: true };
}

/** Convert a transcript's JSONL body into the ordered session event log. */
export function parseSessionEvents(content: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  const append = (part: SessionPart): void => {
    events.push({ type: "append", seq: events.length, part });
  };
  const updateStatus = (id: string, status: ToolStatus): void => {
    events.push({ type: "updateStatus", seq: events.length, id, status });
  };
  const resolve = (id: string): void => {
    events.push({ type: "resolve", seq: events.length, id });
  };
  /** toolCallIds whose start was an interactive (blocker) call. */
  const interactiveIds = new Set<string>();

  let userIdx = 0;
  let msgIdx = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: RawEvent;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const data = raw.data ?? {};

    switch (raw.type) {
      case "user.message": {
        append({
          kind: "userMessage",
          id: `user-${userIdx++}`,
          text: String(data.content ?? ""),
        });
        break;
      }
      case "assistant.message": {
        const reasoning = String(data.reasoningText ?? "").trim();
        if (reasoning) {
          append({ kind: "thinking", id: `think-${msgIdx}`, text: reasoning });
        }
        const text = String(data.content ?? "").trim();
        if (text) {
          append({ kind: "markdown", id: `msg-${msgIdx}`, text });
        }
        msgIdx += 1;
        break;
      }
      case "tool.execution_start": {
        const cid = String(data.toolCallId);
        if (isInteractiveTool(data.toolName)) {
          interactiveIds.add(cid);
          append(toConfirmation(confPartId(cid), data.arguments));
        } else {
          append({
            kind: "toolCall",
            id: toolPartId(cid),
            name: String(data.toolName),
            input: data.arguments ?? null,
            status: "running",
          });
        }
        break;
      }
      case "tool.execution_complete": {
        const cid = String(data.toolCallId);
        if (interactiveIds.has(cid)) {
          resolve(confPartId(cid));
        } else {
          updateStatus(
            toolPartId(cid),
            data.success === false ? "error" : "done",
          );
        }
        break;
      }
      default:
        break;
    }
  }

  return events;
}

/** Locate a session's transcript file under one environment's storage root. */
export async function findTranscript(
  root: string,
  sessionId: string,
): Promise<string | undefined> {
  let hashDirs: string[];
  try {
    hashDirs = await fs.readdir(root);
  } catch {
    return undefined;
  }
  for (const hashDir of hashDirs) {
    const candidate = path.join(
      root,
      hashDir,
      "GitHub.copilot-chat",
      "transcripts",
      `${sessionId}.jsonl`,
    );
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export type SessionEventSink = (event: SessionEvent) => void;

/**
 * Tails a single transcript file: emits every event past `sinceSeq` on start,
 * then re-emits the growing tail on each change. Uses BOTH `fs.watch` (for
 * immediacy) AND a short poll fallback — in dev containers the vscode-server
 * storage often sits on an overlay/volume where inotify events are missed or
 * delayed, which would otherwise stall the live mirror. Refreshes are serialized
 * on a promise queue, so watch + poll never double-emit or drop an event.
 */
export class SessionFollower {
  private emitted: number;
  private watcher: fsSync.FSWatcher | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly filePath: string,
    private readonly sink: SessionEventSink,
    sinceSeq = 0,
    options: { pollIntervalMs?: number } = {},
  ) {
    this.emitted = sinceSeq;
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
  }

  async start(): Promise<void> {
    await this.refresh();
    if (this.stopped) return;
    try {
      this.watcher = fsSync.watch(this.filePath, () => {
        void this.refresh();
      });
    } catch {
      // file removed between read and watch; nothing to tail
    }
    // Poll fallback: catches flushes when inotify events are missed/delayed.
    if (this.pollIntervalMs > 0) {
      this.poller = setInterval(() => {
        void this.refresh();
      }, this.pollIntervalMs);
      this.poller.unref();
    }
  }

  /** Re-read the file and emit any events beyond what has been emitted. */
  refresh(): Promise<void> {
    this.queue = this.queue.then(() => this.pump());
    return this.queue;
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf8");
    } catch {
      return; // transient read error; a later change will retrigger
    }
    const events = parseSessionEvents(content);
    for (let i = this.emitted; i < events.length; i += 1) {
      if (this.stopped) return;
      const event = events[i];
      if (event) this.sink(event);
    }
    if (events.length > this.emitted) this.emitted = events.length;
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = undefined;
    }
  }
}
