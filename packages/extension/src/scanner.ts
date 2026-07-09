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

export interface ScanOptions {
  /** Stable identity of this environment; see docs/03 multi-instance topology. */
  instanceId: string;
  /** Override the workspaceStorage root (tests / non-default installs). */
  root?: string;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
  liveWindowSeconds?: number;
}

interface ParsedTranscript {
  title: string;
  turns: number;
  openInteractiveTools: string[];
}

function isInteractive(toolName: unknown): boolean {
  const name = String(toolName ?? "").toLowerCase();
  return INTERACTIVE_TOOL_HINTS.some((hint) => name.includes(hint));
}

/** Parse one transcript's JSONL body: title, turn count, open interactive tools. */
export function parseTranscript(content: string): ParsedTranscript {
  let title = "";
  let turns = 0;
  const openTools = new Map<string, string>(); // toolCallId -> toolName

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: {
      type?: string;
      data?: { content?: unknown; toolCallId?: unknown; toolName?: unknown };
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
  }

  return {
    title,
    turns,
    openInteractiveTools: [...openTools.values()].filter(isInteractive),
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
    let files: string[];
    try {
      files = await fs.readdir(transcriptsDir);
    } catch {
      continue;
    }
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
      const { title, turns, openInteractiveTools } = parseTranscript(content);
      const idleSeconds = Math.max(0, Math.floor((nowMs - mtimeMs) / 1000));
      rows.push({
        mtimeMs,
        summary: {
          instanceId: opts.instanceId,
          sessionId: file.slice(0, -".jsonl".length),
          workspace: await readWorkspaceName(root, hashDir),
          title: title || "(no user message)",
          turns,
          status: classifyStatus(
            idleSeconds,
            openInteractiveTools.length > 0,
            liveWindow,
          ),
          idleSeconds,
        },
      });
    }
  }

  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs).map((row) => row.summary);
}
