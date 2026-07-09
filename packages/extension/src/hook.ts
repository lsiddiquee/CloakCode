#!/usr/bin/env node
/**
 * The CloakCode Copilot hook command. Registered (opt-in) as a Copilot hook for
 * `PreToolUse` + `PostToolUse`. It is a **pure notifier**: on `PreToolUse` it
 * writes one spool file (`<spoolDir>/<baseToolCallId>.json`) for the pending
 * blocker; on `PostToolUse` it deletes that file. It returns an EMPTY object —
 * no `permissionDecision` — so VS Code's native approval UI is never altered
 * (docs/02 §4.4, docs/03 notifier design). One-file-per-record means concurrent
 * hooks from multiple windows never race on a shared append log.
 *
 * The event name is passed as argv[2]. It never throws into Copilot's flow: any
 * failure degrades to "no overlay". `CLOAKCODE_SPOOL` is the spool DIRECTORY.
 *
 * Usage in a hook config command:
 *   <node> <dist>/hook.cjs PreToolUse
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  defaultSpoolDir,
  eventToolCallId,
  pendingRecord,
  spoolEntryPath,
} from "./hook-spool.js";

async function readStdin(): Promise<string> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
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
  try {
    if (event === "PreToolUse") {
      const record = pendingRecord(stdin, new Date().toISOString());
      if (record) {
        mkdirSync(spoolDir, { recursive: true });
        writeFileSync(
          spoolEntryPath(spoolDir, record.toolCallId),
          JSON.stringify(record),
        );
      }
    } else if (event === "PostToolUse") {
      const id = eventToolCallId(stdin);
      if (id) rmSync(spoolEntryPath(spoolDir, id), { force: true });
    }
  } catch {
    // never disrupt Copilot; the overlay is best-effort
  }

  // Non-intrusive: emit no permissionDecision so VS Code drives approvals.
  process.stdout.write("{}");
}

// Let stdout drain and the process exit naturally (no lingering handles) so the
// "{}" is never truncated by a premature process.exit. Errors degrade silently.
void main().catch(() => {
  try {
    process.stdout.write("{}");
  } catch {
    // ignore — best-effort
  }
});
