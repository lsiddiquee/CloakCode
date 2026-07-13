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

export function isInteractiveTool(toolName: unknown): boolean {
  const name = String(toolName ?? "").toLowerCase();
  return INTERACTIVE_TOOL_HINTS.some((hint) => name.includes(hint));
}

/**
 * Extract `Choice[]` from a question's raw `options`. Tolerant of shape.
 */
function optionsFrom(rawOptions: unknown): Choice[] {
  const arr = Array.isArray(rawOptions) ? rawOptions : [];
  return arr.map((o: unknown, i: number) => {
    const oo = (typeof o === "object" && o ? o : {}) as Record<string, unknown>;
    const detailRaw = oo["detail"] ?? oo["description"];
    return {
      id: String(oo["id"] ?? oo["value"] ?? oo["label"] ?? i),
      label: String(
        oo["label"] ?? oo["title"] ?? oo["name"] ?? oo["value"] ?? o,
      ),
      ...(detailRaw !== undefined && detailRaw !== null
        ? { detail: String(detailRaw) }
        : {}),
      ...(oo["recommended"] ? { recommended: true } : {}),
    };
  });
}

type ConfirmationPart = Extract<SessionPart, { kind: "confirmation" }>;

/**
 * Build `confirmation` parts from an interactive tool's `arguments`. Real
 * `vscode_askQuestions` sends a `questions[]` array (verified 2026-07-09) — one
 * confirmation per question, ids `${baseId}-${i}`. Falls back to a single
 * question/options shape. See docs/02 §3.2.
 */
export function toConfirmations(
  baseId: string,
  args: unknown,
): ConfirmationPart[] {
  const a = (typeof args === "object" && args ? args : {}) as Record<
    string,
    unknown
  >;
  // The VS Code picker offers "Enter custom answer" by DEFAULT — freeform is on
  // unless a question explicitly sets allowFreeformInput:false (verified
  // 2026-07-09: an unset question still showed the custom field). Match that so
  // the overlay never drops the custom option the picker shows.
  const freeform = (r: Record<string, unknown>): boolean =>
    r["allowFreeformInput"] !== false && r["allowFreeform"] !== false;

  // Multi-select lets the user pick more than one option ("select all that
  // apply"); the answer must be delivered as `selectedValues`, and the client
  // renders a multi-toggle instead of single-choice buttons.
  const multi = (r: Record<string, unknown>): boolean =>
    r["multiSelect"] === true || r["multiselect"] === true;

  const questions = Array.isArray(a["questions"]) ? a["questions"] : null;
  if (questions) {
    return questions.map((q: unknown, i: number): ConfirmationPart => {
      const qq = (typeof q === "object" && q ? q : {}) as Record<
        string,
        unknown
      >;
      return {
        kind: "confirmation",
        id: `${baseId}-${i}`,
        prompt: String(
          qq["question"] ??
            qq["message"] ??
            qq["header"] ??
            qq["prompt"] ??
            "Confirm",
        ),
        options: optionsFrom(qq["options"]),
        ...(freeform(qq) ? { allowFreeform: true } : {}),
        ...(multi(qq) ? { multiSelect: true } : {}),
      };
    });
  }

  return [
    {
      kind: "confirmation",
      id: baseId,
      prompt: String(
        a["question"] ?? a["prompt"] ?? a["message"] ?? a["title"] ?? "Confirm",
      ),
      options: optionsFrom(a["options"] ?? a["choices"]),
      ...(freeform(a) ? { allowFreeform: true } : {}),
      ...(multi(a) ? { multiSelect: true } : {}),
    },
  ];
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
  /** toolCallId -> the confirmation part ids emitted for it (interactive). */
  const interactiveIds = new Map<string, string[]>();

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
          const confs = toConfirmations(confPartId(cid), data.arguments);
          interactiveIds.set(
            cid,
            confs.map((c) => c.id),
          );
          for (const conf of confs) append(conf);
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
        const confIds = interactiveIds.get(cid);
        if (confIds) {
          for (const id of confIds) resolve(id);
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

interface RawSpan {
  type?: string;
  name?: string;
  spanId?: string;
  attrs?: Record<string, unknown>;
}

/** Parse a JSON-encoded attribute string, tolerant of a plain value. */
function parseAttr(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * Best-effort recovery of assistant text when `agent_response.response` is a
 * TRUNCATED/invalid JSON string. VS Code caps that debug-log attr at ~5 KB and
 * appends a `[truncated]` marker, so it no longer parses to the message array
 * (docs/02) and `parseAttr` returns the raw string. Rather than dump the raw
 * `[{"role":…,"parts":[{"type":"text","content":"…"}]}]` blob into the
 * transcript, pull the `text` part bodies out directly; `tool_call` parts are
 * skipped (their args render from the separate `tool_call` spans).
 */
function salvageAssistantText(rawResponse: string): string {
  const out: string[] = [];
  const re = /"type":"text","content":"((?:[^"\\]|\\.)*)/g;
  for (let m = re.exec(rawResponse); m; m = re.exec(rawResponse)) {
    const body = m[1];
    if (body === undefined) continue;
    let text = body;
    try {
      text = JSON.parse(`"${body}"`) as string;
    } catch {
      // truncated mid-escape — keep the raw captured body
    }
    if (text.trim()) out.push(text);
  }
  return out.join("\n\n").trim();
}

/**
 * Pull the assistant's markdown out of an `agent_response` span. Its `response`
 * is `[{ role, parts: [{type:'text', content} | {type:'tool_call', …}] }]`
 * (the LM message shape). We keep the `text` parts — tool calls are rendered
 * from the separate `tool_call` spans (which carry status/result).
 */
function assistantText(response: unknown): string {
  const arr = parseAttr(response);
  if (typeof arr === "string") return salvageAssistantText(arr);
  if (!Array.isArray(arr)) return "";
  const out: string[] = [];
  for (const msg of arr) {
    const parts =
      msg && typeof msg === "object"
        ? (msg as Record<string, unknown>)["parts"]
        : null;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (
        p &&
        typeof p === "object" &&
        (p as Record<string, unknown>)["type"] === "text"
      ) {
        const c = (p as Record<string, unknown>)["content"];
        if (typeof c === "string" && c.trim()) out.push(c);
      }
    }
  }
  return out.join("\n\n").trim();
}

/**
 * Convert a Copilot **debug-log** (`debug-logs/<id>/main.jsonl`, OTel spans)
 * into the same event log as `parseSessionEvents`. This is the PREFERRED source:
 * unlike the transcript it stays complete for editor-hosted sessions (docs/02).
 * Relevant spans: `user_message` (attrs.content), `agent_response`
 * (attrs.reasoning + attrs.response parts), `tool_call` (one COMPLETED span —
 * `name` is the tool, attrs.args the input, attrs.error a failure). Other spans
 * (llm_request telemetry, hook, discovery, turn_*, child_session_ref) are not
 * conversation parts here.
 */
export function parseDebugLogEvents(content: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  const append = (part: SessionPart): void => {
    events.push({ type: "append", seq: events.length, part });
  };
  const resolve = (id: string): void => {
    events.push({ type: "resolve", seq: events.length, id });
  };
  let userIdx = 0;
  let msgIdx = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: RawSpan;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const attrs = (
      typeof raw.attrs === "object" && raw.attrs ? raw.attrs : {}
    ) as Record<string, unknown>;

    switch (raw.type) {
      case "user_message": {
        append({
          kind: "userMessage",
          id: `user-${userIdx++}`,
          text: String(attrs["content"] ?? ""),
        });
        break;
      }
      case "agent_response": {
        const reasoning = String(attrs["reasoning"] ?? "").trim();
        if (reasoning) {
          append({ kind: "thinking", id: `think-${msgIdx}`, text: reasoning });
        }
        const text = assistantText(attrs["response"]);
        if (text) {
          append({ kind: "markdown", id: `msg-${msgIdx}`, text });
        }
        msgIdx += 1;
        break;
      }
      case "tool_call": {
        const cid = String(raw.spanId ?? `span-${events.length}`);
        const toolName = String(raw.name ?? "");
        if (isInteractiveTool(toolName)) {
          const confs = toConfirmations(
            confPartId(cid),
            parseAttr(attrs["args"]),
          );
          for (const conf of confs) append(conf);
          for (const conf of confs) resolve(conf.id);
        } else {
          append({
            kind: "toolCall",
            id: toolPartId(cid),
            name: toolName,
            input: parseAttr(attrs["args"]) ?? null,
            status: attrs["error"] ? "error" : "done",
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return events;
}

/** The first user-message text in an event list — the turn the log opens on. */
function firstUserText(events: SessionEvent[]): string | undefined {
  for (const e of events) {
    if (e.type === "append" && e.part.kind === "userMessage")
      return e.part.text;
  }
  return undefined;
}

/**
 * Namespace part/target ids and renumber seq for a merged stream. Both parsers
 * restart their ids (`user-0`, `msg-0`, ...), so without a per-source tag the
 * client (which de-dupes parts by id) would drop the debug-log's turns.
 */
function retag(
  events: SessionEvent[],
  tag: string,
  base: number,
): SessionEvent[] {
  return events.map((e, i): SessionEvent => {
    const seq = base + i;
    if (e.type === "append")
      return { ...e, seq, part: { ...e.part, id: `${tag}${e.part.id}` } };
    return { ...e, seq, id: `${tag}${e.id}` }; // resolve | updateStatus
  });
}

/**
 * When both a transcript and a debug-log exist, the debug-log LEADS (its recent
 * turns are authoritative) but may be missing early history after a recycle /
 * restart (docs/02 §4.22; docs/05 source strategy). Find where the debug-log
 * opens in the transcript — its first user message — and append everything before
 * it as history; the debug-log leads from there. Falls back to the debug-log
 * alone when it already starts at the transcript's beginning or its opening turn
 * isn't in the transcript yet, and to the transcript when the debug-log has no
 * turns to lead with.
 */
export function stitchEvents(
  transcript: SessionEvent[],
  debugLog: SessionEvent[],
): SessionEvent[] {
  const anchor = firstUserText(debugLog);
  if (anchor === undefined) return transcript;
  const boundary = transcript.findIndex(
    (e) =>
      e.type === "append" &&
      e.part.kind === "userMessage" &&
      e.part.text === anchor,
  );
  if (boundary <= 0) return debugLog;
  const prefix = retag(transcript.slice(0, boundary), "tx-", 0);
  return [...prefix, ...retag(debugLog, "dl-", prefix.length)];
}

/** A resolved session log: the file to tail and the parser for its format. */
export interface SessionLog {
  file: string;
  parse: (content: string) => SessionEvent[];
}

/**
 * Locate the best log for a session under one environment's storage root,
 * PREFERRING the complete debug-log (`debug-logs/<id>/main.jsonl`) and falling
 * back to the transcript (`transcripts/<id>.jsonl`). The debug-log stays
 * complete for editor-hosted sessions where the transcript does not (docs/02);
 * the transcript is the zero-config fallback when debug-logging is off.
 */
export async function findSessionLog(
  root: string,
  sessionId: string,
): Promise<SessionLog | undefined> {
  let hashDirs: string[];
  try {
    hashDirs = await fs.readdir(root);
  } catch {
    return undefined;
  }
  for (const hashDir of hashDirs) {
    const base = path.join(root, hashDir, "GitHub.copilot-chat");
    const debugLog = path.join(base, "debug-logs", sessionId, "main.jsonl");
    const transcript = path.join(base, "transcripts", `${sessionId}.jsonl`);

    try {
      await fs.access(debugLog);
    } catch {
      // No debug-log here; fall back to the transcript (zero-config) if present.
      try {
        await fs.access(transcript);
        return { file: transcript, parse: parseSessionEvents };
      } catch {
        continue; // keep looking across envs
      }
    }

    // Debug-log LEADS (latest turns). Read the transcript once for older history
    // and stitch it in ahead of the debug-log when the debug-log is missing it
    // after a recycle/restart (docs/05 source strategy). The debug-log's opening
    // turn is fixed, so the stitched tail stays a stable, resume-safe sequence.
    let history: SessionEvent[] = [];
    try {
      history = parseSessionEvents(await fs.readFile(transcript, "utf8"));
    } catch {
      // no transcript alongside -> debug-log leads alone
    }
    return {
      file: debugLog,
      parse: (content) => stitchEvents(history, parseDebugLogEvents(content)),
    };
  }
  return undefined;
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
  private readonly parse: (content: string) => SessionEvent[];

  constructor(
    private readonly filePath: string,
    private readonly sink: SessionEventSink,
    sinceSeq = 0,
    options: {
      pollIntervalMs?: number;
      parse?: (content: string) => SessionEvent[];
    } = {},
  ) {
    this.emitted = sinceSeq;
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
    this.parse = options.parse ?? parseSessionEvents;
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
    const events = this.parse(content);
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
