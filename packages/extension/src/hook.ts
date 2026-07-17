#!/usr/bin/env node
/**
 * The CloakCode Copilot hook command. Registered (opt-in) for `PreToolUse` +
 * `PostToolUse`. A pure NOTIFIER: on `PreToolUse` it writes one spool file for
 * the tool call and returns an EMPTY object (no `permissionDecision`), so VS
 * Code's own approval UI is never altered; on `PostToolUse` it deletes the file.
 * One file per record so concurrent hooks (many windows share one spool dir)
 * never race.
 *
 * It decides NOTHING about approval: it runs upstream of VS Code's approve/
 * confirm choice and cannot know which calls need confirming, so it surfaces
 * every call. The observer debounces surfacing (a fast auto-approve is retired
 * before it ever shows) and resolves approvals/answers out-of-band via commands
 * (acceptTool/skipTool, notifyQuestionCarouselAnswer). See docs/02.
 *
 * The event name is argv[2]. It never throws into Copilot's flow: any failure
 * degrades to defer/no-overlay. `CLOAKCODE_SPOOL` is the spool DIRECTORY.
 *
 * Usage in a hook config command:
 *   <node> <dist>/hook.cjs PreToolUse
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  defaultSpoolDir,
  eventToolCallId,
  spoolEntryPath,
  spoolRecordFor,
} from "./hook-spool.js";

/** Defer / no-decision output — VS Code's native approval drives the call. */
const DEFER = "{}";

/** Diagnostic sink. Writes to stderr (never stdout — that's the hook protocol
 *  channel) so a dropped/unrecognized event is debuggable if the Copilot hook
 *  contract ever drifts. NB: only metadata (byte counts, shapes, error names)
 *  is ever emitted — never the raw stdin payload (it may carry prompts/code). */
export type HookWarn = (message: string) => void;

/* v8 ignore start -- process/stream glue, exercised end-to-end not in units */
async function readStdin(): Promise<string> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function stderrWarn(message: string): void {
  process.stderr.write(`[cloakcode-hook] ${message}\n`);
}
/* v8 ignore stop */

/**
 * Parse one hook invocation and dispatch it, returning the stdout output string.
 * Pure + injectable (spool dir, clock, diagnostic sink) so the stdin-parse and
 * silent-drop edges are unit-testable. `PreToolUse` spools one record and
 * DEFERs; `PostToolUse` clears it; anything unrecognized DEFERs with a stderr
 * note. It never throws into Copilot's flow — every failure degrades to DEFER.
 */
export function runHook(
  event: string,
  stdinRaw: string,
  spoolDir: string,
  deps: { warn?: HookWarn; now?: () => string } = {},
): string {
  const warn = deps.warn ?? stderrWarn;
  const now = deps.now ?? (() => new Date().toISOString());

  let stdin: unknown = {};
  const trimmed = stdinRaw.trim();
  if (trimmed !== "") {
    try {
      stdin = JSON.parse(trimmed);
    } catch {
      warn(
        `ignored ${event || "(no event)"}: stdin is not valid JSON (${stdinRaw.length} bytes)`,
      );
      return DEFER;
    }
  }

  try {
    if (event === "PreToolUse") {
      const record = spoolRecordFor(stdin, now());
      if (!record) {
        warn("PreToolUse: unrecognized tool-call shape; nothing spooled");
        return DEFER;
      }
      mkdirSync(spoolDir, { recursive: true });
      writeFileSync(
        spoolEntryPath(spoolDir, record.toolCallId),
        JSON.stringify(record),
      );
      return DEFER;
    }
    if (event === "PostToolUse") {
      const id = eventToolCallId(stdin);
      if (!id) {
        warn("PostToolUse: no toolCallId in payload; nothing to clear");
        return DEFER;
      }
      rmSync(spoolEntryPath(spoolDir, id), { force: true });
      return DEFER;
    }
    if (event !== "") warn(`ignoring unknown event '${event}'`);
    return DEFER;
  } catch (e) {
    // never disrupt Copilot; degrade to defer / best-effort overlay
    warn(`degraded to defer after ${e instanceof Error ? e.name : "error"}`);
    return DEFER;
  }
}

/* v8 ignore start -- process entrypoint glue (argv/env/stdin/stdout wiring) */
async function main(): Promise<void> {
  const event = process.argv[2] ?? "";
  const spoolDir = process.env["CLOAKCODE_SPOOL"] ?? defaultSpoolDir();
  const output = runHook(event, await readStdin(), spoolDir);
  process.stdout.write(output);
}

// Let stdout drain and the process exit naturally (no lingering handles) so the
// output is never truncated by a premature process.exit. Errors degrade to defer.
void main().catch(() => {
  try {
    process.stdout.write(DEFER);
  } catch {
    // ignore — best-effort
  }
});
/* v8 ignore stop */
