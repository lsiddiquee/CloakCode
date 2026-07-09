import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type {
  SessionEvent,
  SessionPart,
  ToolStatus,
} from "@cloakcode/protocol";

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

/** Convert a transcript's JSONL body into the ordered session event log. */
export function parseSessionEvents(content: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  const append = (part: SessionPart): void => {
    events.push({ type: "append", seq: events.length, part });
  };
  const updateStatus = (id: string, status: ToolStatus): void => {
    events.push({ type: "updateStatus", seq: events.length, id, status });
  };

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
        append({
          kind: "toolCall",
          id: toolPartId(data.toolCallId),
          name: String(data.toolName),
          input: data.arguments ?? null,
          status: "running",
        });
        break;
      }
      case "tool.execution_complete": {
        updateStatus(
          toolPartId(data.toolCallId),
          data.success === false ? "error" : "done",
        );
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
 * then re-emits the growing tail on each change. Refreshes are serialized on a
 * promise queue, so awaiting `refresh()` always reflects the latest file and no
 * event is dropped or double-emitted under rapid writes.
 */
export class SessionFollower {
  private emitted: number;
  private watcher: fsSync.FSWatcher | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly filePath: string,
    private readonly sink: SessionEventSink,
    sinceSeq = 0,
  ) {
    this.emitted = sinceSeq;
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
  }
}
