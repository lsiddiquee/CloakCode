import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type {
  Choice,
  Logger,
  LogFields,
  SessionEvent,
  SessionPart,
  ToolStatus,
} from "@cloakcode/protocol";
import {
  INTERACTIVE_TOOL_HINTS,
  computeInTurn,
  computeInTurnFromDebugLog,
} from "./scanner.js";
import { errorCode } from "./errors.js";
import { TailReader, type TailReadResult } from "./tail-reader.js";

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

/**
 * The streaming unit shared by both incremental parsers: feed one COMPLETE JSONL
 * line, get back the events it produces. A {@link SessionFollower} in streaming
 * mode holds one across the whole tail so `seq` stays absolute + contiguous
 * (docs/02.6 §4.32).
 */
export interface IncrementalParser {
  push(line: string): SessionEvent[];
}

/**
 * Incremental transcript parser: feed one COMPLETE JSONL line at a time (the
 * byte-offset tail's unit) and it returns the events that line produces, carrying
 * id/seq/interactive state across calls — so a streamed tail yields the SAME
 * events + `seq` as a whole-file parse (docs/02.6 §4.32; 2c/2d/#5 depend on
 * `seq === index`, prefix-stable). {@link parseSessionEvents} is this fed all lines.
 */
export class IncrementalTranscriptParser {
  private seq = 0;
  private userIdx = 0;
  private msgIdx = 0;
  /** toolCallId -> the confirmation part ids emitted for it (interactive). */
  private readonly interactiveIds = new Map<string, string[]>();

  push(line: string): SessionEvent[] {
    const out: SessionEvent[] = [];
    const append = (part: SessionPart): void => {
      out.push({ type: "append", seq: this.seq++, part });
    };
    const updateStatus = (id: string, status: ToolStatus): void => {
      out.push({ type: "updateStatus", seq: this.seq++, id, status });
    };
    const resolve = (id: string): void => {
      out.push({ type: "resolve", seq: this.seq++, id });
    };
    const trimmed = line.trim();
    if (!trimmed) return out;
    let raw: RawEvent;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return out;
    }
    const data = raw.data ?? {};

    switch (raw.type) {
      case "user.message": {
        append({
          kind: "userMessage",
          id: `user-${this.userIdx++}`,
          text: String(data.content ?? ""),
        });
        break;
      }
      case "assistant.message": {
        const reasoning = String(data.reasoningText ?? "").trim();
        if (reasoning) {
          append({
            kind: "thinking",
            id: `think-${this.msgIdx}`,
            text: reasoning,
          });
        }
        const text = String(data.content ?? "").trim();
        if (text) {
          append({ kind: "markdown", id: `msg-${this.msgIdx}`, text });
        }
        this.msgIdx += 1;
        break;
      }
      case "tool.execution_start": {
        const cid = String(data.toolCallId);
        if (isInteractiveTool(data.toolName)) {
          const confs = toConfirmations(confPartId(cid), data.arguments);
          this.interactiveIds.set(
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
        const confIds = this.interactiveIds.get(cid);
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
    return out;
  }
}

/** Convert a transcript's JSONL body into the ordered session event log. */
export function parseSessionEvents(content: string): SessionEvent[] {
  const parser = new IncrementalTranscriptParser();
  const events: SessionEvent[] = [];
  for (const line of content.split("\n")) events.push(...parser.push(line));
  return events;
}

interface RawSpan {
  type?: string;
  name?: string;
  spanId?: string;
  dur?: number;
  attrs?: Record<string, unknown>;
}

/** A finite number, or undefined for anything else (missing/null/string). */
function numAttr(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
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
export class IncrementalDebugLogParser {
  private seq = 0;
  private userIdx = 0;
  private msgIdx = 0;
  private usageIdx = 0;

  push(line: string): SessionEvent[] {
    const out: SessionEvent[] = [];
    const append = (part: SessionPart): void => {
      out.push({ type: "append", seq: this.seq++, part });
    };
    const resolve = (id: string): void => {
      out.push({ type: "resolve", seq: this.seq++, id });
    };
    const trimmed = line.trim();
    if (!trimmed) return out;
    let raw: RawSpan;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return out;
    }
    const attrs = (
      typeof raw.attrs === "object" && raw.attrs ? raw.attrs : {}
    ) as Record<string, unknown>;

    switch (raw.type) {
      case "user_message": {
        append({
          kind: "userMessage",
          id: `user-${this.userIdx++}`,
          text: String(attrs["content"] ?? ""),
        });
        break;
      }
      case "agent_response": {
        const reasoning = String(attrs["reasoning"] ?? "").trim();
        if (reasoning) {
          append({
            kind: "thinking",
            id: `think-${this.msgIdx}`,
            text: reasoning,
          });
        }
        const text = assistantText(attrs["response"]);
        if (text) {
          append({ kind: "markdown", id: `msg-${this.msgIdx}`, text });
        }
        this.msgIdx += 1;
        break;
      }
      case "tool_call": {
        const cid = String(raw.spanId ?? `span-${this.seq}`);
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
      case "llm_request": {
        // Per-request telemetry (docs/02 §4.14): a `usage` metadata part the
        // client aggregates into a session total. Skip a span with no model.
        const model = String(attrs["model"] ?? "").trim();
        if (!model) break;
        const ttft = numAttr(attrs["ttft"]);
        const dur = numAttr(raw.dur);
        const nanoAiu = numAttr(attrs["copilotUsageNanoAiu"]);
        const credits = numAttr(attrs["copilotCredits"]);
        append({
          kind: "usage",
          id: `usage-${this.usageIdx++}`,
          model,
          inputTokens: numAttr(attrs["inputTokens"]) ?? 0,
          outputTokens: numAttr(attrs["outputTokens"]) ?? 0,
          cachedTokens: numAttr(attrs["cachedTokens"]) ?? 0,
          ...(ttft !== undefined ? { ttftMs: ttft } : {}),
          ...(dur !== undefined ? { durationMs: dur } : {}),
          ...(nanoAiu !== undefined ? { nanoAiu } : {}),
          ...(credits !== undefined ? { credits } : {}),
        });
        break;
      }
      default:
        break;
    }
    return out;
  }
}

export function parseDebugLogEvents(content: string): SessionEvent[] {
  const parser = new IncrementalDebugLogParser();
  const events: SessionEvent[] = [];
  for (const line of content.split("\n")) events.push(...parser.push(line));
  return events;
}

/** The ordered user-message texts in an event list (the turns it opens on). */
function userTexts(events: SessionEvent[]): string[] {
  const texts: string[] = [];
  for (const e of events) {
    if (e.type === "append" && e.part.kind === "userMessage")
      texts.push(e.part.text);
  }
  return texts;
}

/**
 * Transcript event index where the debug-log OPENS — the user-message append
 * matching `dlTexts[0]`, choosing (among repeats) the one with the LONGEST
 * aligned prefix of `dlTexts`. This disambiguates a REPEATED opening prompt (F7)
 * WITHOUT requiring the whole sequence to match: VS Code rehydrates the
 * transcript with reordered/retimed turns (docs/06), so demanding a full match
 * made alignment fail and drop all history. Returns -1 when the opening isn't in
 * the transcript.
 */
function alignBoundary(transcript: SessionEvent[], dlTexts: string[]): number {
  if (dlTexts.length === 0) return -1;
  const users: { index: number; text: string }[] = [];
  transcript.forEach((e, i) => {
    if (e.type === "append" && e.part.kind === "userMessage")
      users.push({ index: i, text: e.part.text });
  });
  // Align on the debug-log's OPENING message, disambiguating a REPEATED opening
  // prompt (F7) by the LONGEST aligned prefix — NOT by requiring the WHOLE
  // sequence to match. VS Code rehydrates the transcript with reordered/retimed
  // turns (docs/06 "rehydrated timestamps are replay time"), so later turns
  // routinely diverge from the debug-log's order; demanding a full-sequence match
  // there made alignment FAIL and silently drop ALL earlier history (2026-07-18).
  // The debug-log leads from the boundary, so we only need to find WHERE it opens.
  let best = -1;
  let bestScore = 0;
  for (let p = 0; p < users.length; p++) {
    if (users[p]!.text !== dlTexts[0]) continue;
    let score = 1;
    while (
      score < dlTexts.length &&
      p + score < users.length &&
      users[p + score]!.text === dlTexts[score]
    ) {
      score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = users[p]!.index;
    }
  }
  return best;
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
  const dlTexts = userTexts(debugLog);
  if (dlTexts.length === 0) return transcript;
  const boundary = alignBoundary(transcript, dlTexts);
  if (boundary <= 0) return debugLog;
  const prefix = retag(transcript.slice(0, boundary), "tx-", 0);
  return [...prefix, ...retag(debugLog, "dl-", prefix.length)];
}

/** A resolved session log: the file to tail, its parser, and its turn detector. */
export interface SessionLog {
  file: string;
  parse: (content: string) => SessionEvent[];
  /**
   * When set, the follower tails `file` by BYTE OFFSET through this incremental
   * parser instead of re-reading the whole file into one string each poll — the
   * offset-streaming path for logs past V8's ~512 MiB string cap (docs/02.6
   * §4.31/§4.32). A fresh parser per subscription; discarded on unsubscribe.
   * Streamed output is byte-identical to `parse` fed the whole file, so `seq`
   * stays absolute + prefix-stable. Omitted ⇒ the whole-read `parse` path.
   */
  makeParser?: () => IncrementalParser;
  /**
   * Mid-turn detector for THIS log's format, so `inTurn` is derived from the
   * same file the follower tails (no divergent transcript path). The debug-log
   * has clean `turn_start`/`turn_end` spans; the transcript needs the
   * placeholder-aware parser (docs/02.2).
   */
  computeTurn: (content: string) => boolean;
}

/**
 * True if `id` is a safe single path segment — allowlist charset, no separators
 * or `..` — so it can't traverse out of the storage root when joined into a log
 * path (drift audit S2). Belt to the protocol `sessionIdSchema`; the observer
 * guards here too since it also runs on ids from internal call paths.
 */
function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !id.includes("..");
}

/**
 * A log at or above this byte size is tailed by BYTE OFFSET (streaming) instead
 * of read whole into one string, so it can't hit V8's ~512 MiB string cap
 * (docs/02.6 §4.31/§4.32). Set well under the cap (headroom for multibyte UTF-8):
 * a log this large is essentially always past any recycle boundary, so streaming
 * the debug-log RAW (no transcript prefix) equals the whole-read stitch anyway.
 */
export const STREAM_THRESHOLD_BYTES = 256 * 1024 * 1024; // 256 MiB

/**
 * Locate the best log for a session under one environment's storage root,
 * PREFERRING the complete debug-log (`debug-logs/<id>/main.jsonl`) and falling
 * back to the transcript (`transcripts/<id>.jsonl`). The debug-log stays
 * complete for editor-hosted sessions where the transcript does not (docs/02);
 * the transcript is the zero-config fallback when debug-logging is off.
 *
 * A log at/over `streamThresholdBytes` is resolved with a `makeParser` so the
 * follower tails it by byte offset instead of the whole-read `parse` — the
 * offset-streaming path for logs past the string cap (docs/02.6 §4.32).
 */
export async function findSessionLog(
  root: string,
  sessionId: string,
  logger?: Logger,
  streamThresholdBytes = STREAM_THRESHOLD_BYTES,
): Promise<SessionLog | undefined> {
  if (!isSafeSessionId(sessionId)) return undefined;
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
        const txBytes = (await fileSizeOrUndefined(transcript)) ?? 0;
        return {
          file: transcript,
          parse: parseSessionEvents,
          // A transcript past the string cap streams too (rare, but §4.31 hits
          // it just the same); its incremental parser is byte-identical.
          ...(txBytes >= streamThresholdBytes
            ? { makeParser: () => new IncrementalTranscriptParser() }
            : {}),
          computeTurn: computeInTurn,
        };
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
    } catch (err) {
      // ENOENT is the common, benign case (no transcript alongside → the
      // debug-log leads alone). Anything else — ERR_STRING_TOO_LONG on a huge
      // transcript (docs/02.6 §4.31), EISDIR, EACCES — silently drops history,
      // so surface it instead of swallowing.
      if (errorCode(err) !== "ENOENT") {
        logger?.warn("stitch.transcript_read_failed", { code: errorCode(err) });
      }
    }
    return {
      file: debugLog,
      parse: (content) => stitchEvents(history, parseDebugLogEvents(content)),
      // A debug-log past the string cap is tailed by byte offset instead of read
      // whole (docs/02.6 §4.32). It streams RAW — a log this large is past any
      // recycle boundary (boundary <= 0), so `stitchEvents` would return it raw
      // anyway; the whole-read `parse` above stays the (uninvoked) fallback.
      ...(((await fileSizeOrUndefined(debugLog)) ?? 0) >= streamThresholdBytes
        ? { makeParser: () => new IncrementalDebugLogParser() }
        : {}),
      computeTurn: computeInTurnFromDebugLog,
    };
  }
  return undefined;
}

/** Locate a session's transcript file under one environment's storage root. */
export async function findTranscript(
  root: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!isSafeSessionId(sessionId)) return undefined;
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

/** Sink for live mid-turn transitions (only fired on change). */
export type TurnSink = (inTurn: boolean) => void;

/** Sink for a terminal read failure surfaced to the client (docs/02.6 §4.31). */
export type FollowerErrorSink = (info: {
  code: string;
  bytes?: number;
}) => void;

/** File size in bytes for a diagnostic, or undefined if it can't be stat'd. */
async function fileSizeOrUndefined(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return undefined;
  }
}

/**
 * Tail window for the streaming turn detector (docs/02.6 §4.32). `computeTurn`
 * depends only on the LAST `turn_start`/`turn_end` span, so a bounded tail suffices
 * and never rebuilds a giant string. 4 MiB dwarfs any real turn's final span yet
 * stays far under V8's ~512 MiB cap.
 */
const TURN_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Read the LAST `maxBytes` of a file as UTF-8 via a bounded stream (never the
 * whole file), so the streaming turn detector can't hit the string cap. A
 * multibyte char split at the START boundary only ever corrupts the first,
 * already-partial line — which the turn parser skips (bad JSON) — so it's safe.
 */
async function readTail(file: string, maxBytes: number): Promise<string> {
  const size = (await fs.stat(file)).size;
  if (size === 0) return "";
  const start = Math.max(0, size - maxBytes);
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = fsSync.createReadStream(file, { start, end: size - 1 });
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

/**
 * Tails a single transcript file: emits every event past `sinceSeq` on start,
 * then re-emits the growing tail on each change. Uses BOTH `fs.watch` (for
 * immediacy) AND a short poll fallback — in dev containers the vscode-server
 * storage often sits on an overlay/volume where inotify events are missed or
 * delayed, which would otherwise stall the live mirror. Refreshes are serialized
 * on a promise queue, so watch + poll never double-emit or drop an event.
 *
 * When `onTurn` is given, it ALSO derives the mid-turn flag from the SAME tailed
 * `filePath` — via the injected `computeTurn` (the debug-log's clean turn spans
 * when sourced from it, else the transcript parser) — and fires `onTurn` on each
 * transition, so the composer flips steer/queue↔send live (docs/05 M3c). There is
 * no separate turn file: turn state comes from the one authoritative source.
 */
export class SessionFollower {
  private emitted: number;
  private watcher: fsSync.FSWatcher | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private lastInTurn: boolean | undefined;
  private readonly pollIntervalMs: number;
  private readonly parse: (content: string) => SessionEvent[];
  /**
   * When set, the follower tails by BYTE OFFSET through a live parser instead of
   * re-reading the whole file each poll — the offset-streaming path for logs past
   * V8's string cap (docs/02.6 §4.32). Precedence over `parse` when both exist.
   */
  private readonly makeParser: (() => IncrementalParser) | undefined;
  /** Offset reader + running parser for the streaming path (lazily created). */
  private reader: TailReader | undefined;
  private parser: IncrementalParser | undefined;
  private readonly computeTurn: (content: string) => boolean;
  private readonly onTurn: TurnSink | undefined;
  private readonly onError: FollowerErrorSink | undefined;
  private readonly logger: Logger | undefined;
  /**
   * Max events to emit on the INITIAL load (the tail window) — the client's
   * `limit`. Undefined = emit everything from `sinceSeq` (unchanged default).
   * Bounds only the first emit; live events after are never dropped (docs/02.6).
   */
  private readonly tailLimit: number | undefined;
  /** First successful parse still pending — gates the one-shot tail clamp. */
  private firstPump = true;
  /** Last error code per phase, so a persistent failure logs once, not per poll. */
  private lastCodeByPhase: Record<string, string | undefined> = {};

  constructor(
    private readonly filePath: string,
    private readonly sink: SessionEventSink,
    sinceSeq = 0,
    options: {
      pollIntervalMs?: number;
      parse?: (content: string) => SessionEvent[];
      makeParser?: () => IncrementalParser;
      computeTurn?: (content: string) => boolean;
      onTurn?: TurnSink;
      onError?: FollowerErrorSink;
      logger?: Logger;
      limit?: number;
    } = {},
  ) {
    this.emitted = sinceSeq;
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
    this.parse = options.parse ?? parseSessionEvents;
    this.makeParser = options.makeParser;
    this.computeTurn = options.computeTurn ?? computeInTurn;
    this.onTurn = options.onTurn;
    this.onError = options.onError;
    this.logger = options.logger;
    this.tailLimit = options.limit;
  }

  async start(): Promise<void> {
    await this.refresh();
    if (this.stopped) return;
    try {
      this.watcher = fsSync.watch(this.filePath, () => {
        void this.refresh();
      });
    } catch (err) {
      // file removed between read and watch; the poll fallback still covers it.
      this.report("watch", "debug", err);
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
    if (this.makeParser) return this.pumpStream();
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      // The swallow that silently blanked huge sessions: a >512 MiB debug-log
      // throws ERR_STRING_TOO_LONG (docs/02.6 §4.31). Surface it with the file
      // size, deduped so a permanent failure logs once — not on every poll.
      const bytes = await fileSizeOrUndefined(this.filePath);
      this.report(
        "read",
        "warn",
        err,
        bytes !== undefined ? { bytes } : undefined,
      );
      return; // a later change re-triggers; a good read clears the dedup.
    }
    this.clear("read");
    const events = this.parse(content);
    // Tail window: on the FIRST successful parse, skip everything before the last
    // `limit` events so a huge session opens light (the client pages older via
    // session.history). seq stays absolute ⇒ prefix-stable; live events after are
    // never clamped. No-op when `limit` is unset (the default).
    if (this.firstPump && this.tailLimit !== undefined) {
      this.emitted = Math.max(this.emitted, events.length - this.tailLimit);
    }
    this.firstPump = false;
    for (let i = this.emitted; i < events.length; i += 1) {
      if (this.stopped) return;
      const event = events[i];
      if (event) this.sink(event);
    }
    if (events.length > this.emitted) this.emitted = events.length;
    this.pumpTurn(content);
  }

  /**
   * Streaming pump (docs/02.6 §4.32): tail the file by BYTE OFFSET through a
   * running incremental parser instead of re-reading the whole file into one
   * string — so a log past V8's ~512 MiB string cap (§4.31) streams in bounded
   * chunks and never throws ERR_STRING_TOO_LONG. `TailReader.read()` drains
   * `[offset, EOF)` and yields only COMPLETE lines; the parser carries `seq`
   * across calls, so the emitted stream is byte-identical to the whole-read
   * `parse` path (proven by the equivalence tests).
   */
  private async pumpStream(): Promise<void> {
    if (this.stopped) return;
    if (!this.reader) this.reader = new TailReader(this.filePath);
    if (!this.parser) this.parser = this.makeParser!();
    let result: TailReadResult;
    try {
      result = await this.reader.read();
    } catch (err) {
      const bytes = await fileSizeOrUndefined(this.filePath);
      this.report(
        "read",
        "warn",
        err,
        bytes !== undefined ? { bytes } : undefined,
      );
      return; // a later change re-triggers; a good read clears the dedup.
    }
    this.clear("read");
    if (result.reset) {
      // Truncation / rotation (the 581→85 MB recycle, §4.32): the parser's ids +
      // seq restart, so rebuild it and re-stream from 0. `result.lines` is already
      // the fresh read from the start; the client cache de-dupes by part id, so a
      // same-session re-stream is idempotent.
      this.parser = this.makeParser!();
      this.emitted = 0;
      this.firstPump = true;
    }
    const events: SessionEvent[] = [];
    for (const line of result.lines) {
      for (const event of this.parser.push(line)) events.push(event);
    }
    if (events.length > 0) {
      const total = events[events.length - 1]!.seq + 1;
      // On the FIRST drain, skip everything before BOTH the resume point
      // (`sinceSeq`) and the tail window (`total - limit`) — seq is absolute, so
      // the skipped prefix stays client-pageable. Later drains carry only new
      // events (the parser's seq keeps climbing), so emit them all.
      let i = 0;
      if (this.firstPump) {
        let clamp = this.emitted;
        if (this.tailLimit !== undefined) {
          clamp = Math.max(clamp, total - this.tailLimit);
        }
        while (i < events.length && events[i]!.seq < clamp) i += 1;
      }
      for (; i < events.length; i += 1) {
        if (this.stopped) return;
        this.sink(events[i]!);
      }
      this.emitted = total;
    }
    this.firstPump = false;
    await this.pumpTurnStream();
  }

  /**
   * Derive the mid-turn flag from the just-read content (the one authoritative
   * source, via the injected `computeTurn`) and fire `onTurn` on a transition.
   * Emits only on change, so it is idempotent under watch + poll.
   */
  private pumpTurn(content: string): void {
    if (!this.onTurn || this.stopped) return;
    const inTurn = this.computeTurn(content);
    if (inTurn !== this.lastInTurn) {
      this.lastInTurn = inTurn;
      this.onTurn(inTurn);
    }
  }

  /**
   * Streaming turn detector: `computeTurn` needs only the LAST `turn_start`/
   * `turn_end` span, so tail a bounded window rather than rebuild a giant string.
   * A single turn dumping more than the window before its close reads idle until
   * the next span arrives — rare + self-correcting (docs/02.6 §4.32).
   */
  private async pumpTurnStream(): Promise<void> {
    if (!this.onTurn || this.stopped) return;
    let tail: string;
    try {
      tail = await readTail(this.filePath, TURN_TAIL_BYTES);
    } catch {
      return; // transient; a later pump retries
    }
    const inTurn = this.computeTurn(tail);
    if (inTurn !== this.lastInTurn) {
      this.lastInTurn = inTurn;
      this.onTurn(inTurn);
    }
  }

  /**
   * Log a follow error at `level`, deduped by phase so a persistent failure
   * (e.g. a debug-log stuck over the string cap) logs ONCE, not on every 400 ms
   * poll. `clear` resets a phase after a good read so a recurrence logs again.
   */
  private report(
    phase: "read" | "watch",
    level: "warn" | "debug",
    err: unknown,
    extra?: LogFields,
  ): void {
    const code = errorCode(err);
    if (this.lastCodeByPhase[phase] === code) return;
    this.lastCodeByPhase[phase] = code;
    this.logger?.[level](`follower.${phase}_failed`, { code, ...extra });
    // Only a READ failure blanks the client's content — surface THAT (a terminal
    // notice) so the phone shows a reason, not an empty session. Watch/turn are
    // internal recovery, logged only.
    if (phase === "read" && this.onError) {
      const bytes = extra?.["bytes"];
      this.onError(typeof bytes === "number" ? { code, bytes } : { code });
    }
  }

  private clear(phase: "read"): void {
    this.lastCodeByPhase[phase] = undefined;
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
