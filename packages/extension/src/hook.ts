#!/usr/bin/env node
/**
 * The CloakCode Copilot hook command. Registered (opt-in) in the workspace's
 * `.github/hooks/*.json` for `PreToolUse` + `PostToolUse`. It is a **pure
 * notifier**: it appends a `pending`/`resolved` line to the local spool file
 * and returns an EMPTY object — no `permissionDecision` — so VS Code's native
 * approval UI is never altered (docs/02 §4.4, docs/03 notifier design).
 *
 * The event name is passed as argv[2] (matching each hook entry in the config).
 * It never throws into Copilot's flow: any failure degrades to "no overlay".
 *
 * Usage in a hook config command:
 *   node <dist>/hook.cjs PreToolUse
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildSpoolRecord, defaultSpoolFile } from "./hook-spool.js";

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

  const record = buildSpoolRecord(event, stdin, new Date().toISOString());
  if (record) {
    const spoolFile = process.env["CLOAKCODE_SPOOL"] ?? defaultSpoolFile();
    try {
      mkdirSync(dirname(spoolFile), { recursive: true });
      appendFileSync(spoolFile, JSON.stringify(record) + "\n");
    } catch {
      // never disrupt Copilot; the overlay is best-effort
    }
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
