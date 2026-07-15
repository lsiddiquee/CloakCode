import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionStatus, SessionSummary } from "@cloakcode/protocol";

/**
 * Faithful TypeScript port of `research/list_sessions.py` (validated 2026-07-08).
 * Pure Node `fs` — no `vscode` — so it runs in the dev harness and the extension
 * host alike, and is unit-testable without either.
 *
 * Key lessons baked in (docs/02 §3.2–§3.3):
 *  - status derives from file **mtime liveness**, never the last event type;
 *  - a blocker is an **unmatched interactive `tool.execution_start`** (matched
 *    by `toolCallId`).
 */

export const INTERACTIVE_TOOL_HINTS = [
  "ask",
  "question",
  "confirm",
  "input",
  "elicit",
] as const;

export const DEFAULT_LIVE_WINDOW_SECONDS = 120;

/** `~/.vscode-server/data/User/workspaceStorage` for this environment. */
export function defaultWorkspaceStorageRoot(): string {
  return path.join(
    os.homedir(),
    ".vscode-server",
    "data",
    "User",
    "workspaceStorage",
  );
}

/**
 * The workspaceStorage `<hash>` from a `context.storageUri` fsPath. storageUri is
 * `<root>/<hash>/<extId>`, and the extension id can itself contain a slash (ours
 * is `cloakcode.@cloakcode/extension`), so `basename(dirname())` extracts the
 * WRONG segment — take the first path segment under `root` instead. Returns
 * undefined when the path is not under `root`.
 */
export function storageHashFromUri(
  root: string,
  storageFsPath: string,
): string | undefined {
  const rel = path.relative(root, storageFsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep)[0] || undefined;
}

export interface ScanOptions {
  /** Stable identity of this environment; see docs/03 multi-instance topology. */
  instanceId: string;
  /** Override the workspaceStorage root (tests / non-default installs). */
  root?: string;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
  liveWindowSeconds?: number;
  /**
   * WorkspaceStorage `<hash>` dirs a live extension in THIS window owns (from
   * `context.storageUri`). A session is `owned` (actuatable) iff its hash is in
   * this set; others are listed observe-only (`owned=false`). Unset (dev-server /
   * tests) => everything is `owned` (no window to scope against).
   */
  ownedWorkspaceHashes?: ReadonlySet<string>;
  /**
   * Map of `workspaceStorage/<hash>` -> a human workspace label the extension
   * knows (e.g. the owned window's folder name). Falls back to `workspace.json`
   * / a hash prefix when absent.
   */
  workspaceNames?: ReadonlyMap<string, string>;
}

interface ParsedTranscript {
  title: string;
  turns: number;
  openInteractiveTools: string[];
  /** An assistant turn is in flight: a `turn_start` with no later `turn_end`. */
  inTurn: boolean;
}

function isInteractive(toolName: unknown): boolean {
  const name = String(toolName ?? "").toLowerCase();
  return INTERACTIVE_TOOL_HINTS.some((hint) => name.includes(hint));
}

/** Parse one transcript's JSONL body: title, turn count, open interactive tools. */
export function parseTranscript(content: string): ParsedTranscript {
  let title = "";
  let turns = 0;
  let openTurnId: string | undefined; // the in-flight assistant turn, if any
  // Copilot writes a spurious `assistant.turn_start` immediately after each
  // `assistant.turn_end` (SAME timestamp, `parentId` = that turn_end) as a
  // pre-allocated "next turn" placeholder that never runs — so an IDLE session's
  // transcript ends on a childless `turn_start` (docs/02 §3.3/§4.28: the very
  // trap that forces status off the last event). Disambiguate: a turn that
  // OPENED right after a `turn_end` and has seen NO activity is that placeholder,
  // not a live turn. A real turn either follows a `user.message` or gains a
  // child event (message / tool / function) as the model works.
  let openTurnAfterTurnEnd = false;
  let openTurnHadActivity = false;
  let prevType = "";
  const openTools = new Map<string, string>(); // toolCallId -> toolName

  // A new turn (a user message, or the assistant starting to speak) abandons any
  // still-open interactive tool from an EARLIER turn: §4.6 batches tool events at
  // completion, so an orphaned `execution_start` (its `complete` never flushed)
  // would otherwise pile up and read as "blocked" forever (docs/05 #27). Only an
  // interactive start with no later turn after it is a live blocker.
  const supersedeOpenInteractive = (): void => {
    for (const [id, name] of openTools) {
      if (isInteractive(name)) openTools.delete(id);
    }
  };

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: {
      type?: string;
      data?: {
        content?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
        turnId?: unknown;
      };
    };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const data = event.data ?? {};
    switch (event.type) {
      case "user.message": {
        turns += 1;
        if (!title) {
          title = String(data.content ?? "")
            .replace(/\n/g, " ")
            .trim()
            .slice(0, 60);
        }
        supersedeOpenInteractive();
        break;
      }
      case "assistant.turn_start": {
        supersedeOpenInteractive();
        // A new turn RESETS any still-open turn: editor-hosted sessions omit
        // `assistant.turn_end` (§4.10), so a dangling `turn_start` would read
        // "mid-turn" forever — the latest start is the one in flight. Mirrors
        // the interactive-tool self-heal above. Reset on `turn_start` ONLY, not
        // `user.message` (a steer injects a mid-turn `user.message`, §3.1, which
        // must NOT clear the in-flight turn).
        openTurnId = String(data.turnId ?? "");
        // Placeholder guard: a `turn_start` right after a `turn_end` (no user
        // message between) is either the spurious idle placeholder or an
        // auto-chained turn — only the LATTER gains activity below.
        openTurnAfterTurnEnd = prevType === "assistant.turn_end";
        openTurnHadActivity = false;
        break;
      }
      case "assistant.turn_end": {
        openTurnId = undefined;
        break;
      }
      case "tool.execution_start": {
        openTools.set(String(data.toolCallId), String(data.toolName));
        break;
      }
      case "tool.execution_complete": {
        openTools.delete(String(data.toolCallId));
        break;
      }
      default:
        break;
    }
    // Any assistant-side event after a `turn_start` proves the turn is really
    // running (distinguishes a live turn from the childless idle placeholder).
    if (
      openTurnId !== undefined &&
      (event.type === "assistant.message" ||
        event.type === "tool.execution_start" ||
        event.type === "tool.execution_complete" ||
        event.type === "function")
    ) {
      openTurnHadActivity = true;
    }
    prevType = event.type ?? "";
  }

  return {
    title,
    turns,
    openInteractiveTools: [...openTools.values()].filter(isInteractive),
    // Mid-turn only when there's an open turn that is NOT the spurious idle
    // placeholder (opened right after a turn_end with no activity since).
    inTurn:
      openTurnId !== undefined &&
      (openTurnHadActivity || !openTurnAfterTurnEnd),
  };
}

/** Liveness classification: mtime window + the blocker signature. */
export function classifyStatus(
  idleSeconds: number,
  hasOpenInteractive: boolean,
  liveWindowSeconds: number,
): SessionStatus {
  const live = idleSeconds < liveWindowSeconds;
  if (live && hasOpenInteractive) return "blocked";
  return live ? "active" : "idle";
}

async function readWorkspaceName(
  root: string,
  hashDir: string,
): Promise<string> {
  try {
    const raw = await fs.readFile(
      path.join(root, hashDir, "workspace.json"),
      "utf8",
    );
    const folder = String(
      (JSON.parse(raw) as { folder?: unknown }).folder ?? "",
    );
    const base = path.basename(folder.replace(/\/+$/, ""));
    return base || folder.slice(0, 16) || hashDir.slice(0, 8);
  } catch {
    return hashDir.slice(0, 8);
  }
}

/**
 * Extract the text of a debug-log `agent_response.response`, whose shape is
 * `[{ role, parts: [{type:'text', content} | …] }]`. Kept local to the scanner
 * (avoids a scanner↔session-observer import cycle); the stream parser has its
 * own copy for the event log.
 */
function responseText(response: unknown): string {
  let arr: unknown = response;
  if (typeof response === "string") {
    try {
      arr = JSON.parse(response);
    } catch {
      return response.trim();
    }
  }
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
        if (typeof c === "string") out.push(c);
      }
    }
  }
  return out.join("").trim();
}

/**
 * The LLM-generated session title from the debug-log's "title" child session —
 * the exact title VS Code shows (it equals `ChatModel.customTitle`, verified
 * 2026-07-10 against the client-side store). Reads
 * `<debugLogsDir>/<sessionId>/title-*.jsonl` → its `agent_response` text.
 * Returns `undefined` when there's no debug-log (the transcript's first user
 * message stays the zero-config fallback).
 */
export async function debugLogTitle(
  debugLogsDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const dir = path.join(debugLogsDir, sessionId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const titleFile = names.find(
    (n) => n.startsWith("title-") && n.endsWith(".jsonl"),
  );
  if (!titleFile) return undefined;
  let content: string;
  try {
    content = await fs.readFile(path.join(dir, titleFile), "utf8");
  } catch {
    return undefined;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: { type?: string; attrs?: { response?: unknown } };
    try {
      o = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (o.type === "agent_response") {
      const t = responseText(o.attrs?.response)
        .replace(/\n/g, " ")
        .trim()
        .slice(0, 80);
      if (t) return t;
    }
  }
  return undefined;
}

/**
 * Enumerate every session transcript under one environment's workspaceStorage
 * and derive the phone's session picker rows, newest first.
 */
export async function scanSessions(
  opts: ScanOptions,
): Promise<SessionSummary[]> {
  const root = opts.root ?? defaultWorkspaceStorageRoot();
  const liveWindow = opts.liveWindowSeconds ?? DEFAULT_LIVE_WINDOW_SECONDS;
  const nowMs = (opts.now ?? Date.now)();

  let hashDirs: string[];
  try {
    hashDirs = await fs.readdir(root);
  } catch {
    return [];
  }

  const rows: Array<{ summary: SessionSummary; mtimeMs: number }> = [];

  for (const hashDir of hashDirs) {
    const transcriptsDir = path.join(
      root,
      hashDir,
      "GitHub.copilot-chat",
      "transcripts",
    );
    const debugLogsDir = path.join(
      root,
      hashDir,
      "GitHub.copilot-chat",
      "debug-logs",
    );
    let files: string[];
    try {
      files = await fs.readdir(transcriptsDir);
    } catch {
      continue;
    }
    // Prefer an extension-supplied label (owned window's folder name); else one
    // workspace.json read per hash dir (not per session file).
    const workspace =
      opts.workspaceNames?.get(hashDir) ??
      (await readWorkspaceName(root, hashDir));
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = path.join(transcriptsDir, file);
      let content: string;
      let mtimeMs: number;
      try {
        content = await fs.readFile(full, "utf8");
        mtimeMs = (await fs.stat(full)).mtimeMs;
      } catch {
        continue;
      }
      const sessionId = file.slice(0, -".jsonl".length);
      const { title, turns, openInteractiveTools, inTurn } =
        parseTranscript(content);
      // Prefer VS Code's own LLM-generated title (from the debug-log) over the
      // first user message; fall back when there's no debug-log.
      const generatedTitle = await debugLogTitle(debugLogsDir, sessionId);
      const idleSeconds = Math.max(0, Math.floor((nowMs - mtimeMs) / 1000));
      const live = idleSeconds < liveWindow;
      rows.push({
        mtimeMs,
        summary: {
          instanceId: opts.instanceId,
          sessionId,
          workspace,
          workspaceHash: hashDir,
          title: generatedTitle || title || "(no user message)",
          turns,
          status: classifyStatus(
            idleSeconds,
            openInteractiveTools.length > 0,
            liveWindow,
          ),
          idleSeconds,
          // Mid-turn only counts while live — a dormant transcript that ends at
          // `turn_start` (never flushed `turn_end`, §4.10) must read idle.
          inTurn: live && inTurn,
          owned: opts.ownedWorkspaceHashes
            ? opts.ownedWorkspaceHashes.has(hashDir)
            : true,
        },
      });
    }
  }

  // De-dup by sessionId (a globally-unique UUID): one session can land under
  // several <hash> dirs (VS Code workspaceStorage hash instability, docs/05) —
  // list it ONCE, preferring the OWNED (actuatable) copy, then the freshest.
  const bySession = new Map<
    string,
    { summary: SessionSummary; mtimeMs: number }
  >();
  for (const row of rows) {
    const prev = bySession.get(row.summary.sessionId);
    if (
      !prev ||
      (row.summary.owned && !prev.summary.owned) ||
      (row.summary.owned === prev.summary.owned && row.mtimeMs > prev.mtimeMs)
    ) {
      bySession.set(row.summary.sessionId, row);
    }
  }
  return [...bySession.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((row) => row.summary);
}
