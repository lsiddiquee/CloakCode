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

async function readStdin(): Promise<string> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/**
 * Handle one `PreToolUse`: spool one record for the tool call and DEFER. Every
 * call is surfaced (the hook is upstream of VS Code's approve/confirm decision);
 * the observer debounces so auto-approved calls never show. `spoolRecordFor`
 * tags interactive tools as questions and the rest as allow/deny approvals.
 */
async function handlePreToolUse(
  stdin: unknown,
  spoolDir: string,
): Promise<string> {
  const record = spoolRecordFor(stdin, new Date().toISOString());
  if (record) {
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(
      spoolEntryPath(spoolDir, record.toolCallId),
      JSON.stringify(record),
    );
  }
  return DEFER;
}

async function main(): Promise<void> {
  const event = process.argv[2] ?? "";
  let stdin: unknown = {};
  try {
    stdin = JSON.parse(await readStdin());
  } catch {
    // not JSON / empty — nothing to record
  }

  const spoolDir = process.env["CLOAKCODE_SPOOL"] ?? defaultSpoolDir();
  let output = DEFER;
  try {
    if (event === "PreToolUse") {
      output = await handlePreToolUse(stdin, spoolDir);
    } else if (event === "PostToolUse") {
      const id = eventToolCallId(stdin);
      if (id) {
        rmSync(spoolEntryPath(spoolDir, id), { force: true });
      }
    }
  } catch {
    // never disrupt Copilot; degrade to defer / best-effort overlay
    output = DEFER;
  }

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
