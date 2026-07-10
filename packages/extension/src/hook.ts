#!/usr/bin/env node
/**
 * The CloakCode Copilot hook command. Registered (opt-in) for `PreToolUse` +
 * `PostToolUse`. Two modes, chosen per tool call from the session's on-disk
 * control policy (`<controlDir>/<sessionId>.json`):
 *
 * - **Notifier (default).** Not in control, or VS Code would auto-approve: it
 *   writes/deletes one spool file per live blocker and returns an EMPTY object
 *   — no `permissionDecision` — so VS Code's native approval UI is never altered
 *   (docs/02 §4.4). One file per record ⇒ concurrent hooks never race.
 * - **Blocking (take-control).** When the operator has taken control of the
 *   session and the tool would otherwise need confirmation, it records the
 *   pending call, HOLDS the tool synchronously while polling for a remote
 *   allow/deny, and emits `hookSpecificOutput.permissionDecision`. A timeout
 *   falls through to native (empty object). It only blocks if VS Code would
 *   have blocked — see docs/02 §4.15.
 *
 * The event name is argv[2]. It never throws into Copilot's flow: any failure
 * degrades to defer/no-overlay. `CLOAKCODE_SPOOL` is the spool DIRECTORY; the
 * control dir is its fixed sibling.
 *
 * Usage in a hook config command:
 *   <node> <dist>/hook.cjs PreToolUse
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Decision } from "@cloakcode/protocol";
import {
  awaitDecision,
  blockingRecord,
  BLOCK_HOOK_TIMEOUT_SECONDS,
  controlDirFor,
  debugLogFromTranscript,
  decisionEntryPath,
  defaultSpoolDir,
  eventToolCallId,
  hookRouting,
  NO_CONTROL,
  pendingRecord,
  preToolAction,
  readControlPolicy,
  readDecision,
  readLatestPermissionLevel,
  spoolEntryPath,
} from "./hook-spool.js";

/** Defer / no-decision output — VS Code's native approval drives the call. */
const DEFER = "{}";

/**
 * A PreToolUse decision output the copilot hook host understands — the verdict
 * lives inside `hookSpecificOutput` (copilot-chat `hookCommandTypes`, parsed in
 * `chatHookService`). An empty object (no `hookSpecificOutput`) means defer.
 */
function decisionOutput(decision: Decision): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
    },
  });
}

async function readStdin(): Promise<string> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/**
 * Handle one `PreToolUse`. Returns the stdout string to emit: `DEFER` for the
 * notifier / auto-approve paths, or a `permissionDecision` once a remote verdict
 * (or a timeout) resolves a held tool call.
 */
async function handlePreToolUse(
  stdin: unknown,
  spoolDir: string,
): Promise<string> {
  const { sessionId, toolName, transcriptPath } = hookRouting(stdin);
  const policy = sessionId
    ? await readControlPolicy(controlDirFor(spoolDir), sessionId)
    : NO_CONTROL;

  // The session's live permission level (Bypass Approvals / autopilot) actually
  // drives VS Code's approval but is NOT in the hook stdin — read it from the
  // debug-log (docs/02 §4.15). Only needed while in control (otherwise we defer
  // regardless), so the tail-read never touches the common path.
  let permissionLevel: string | undefined;
  if (policy.control && sessionId && transcriptPath) {
    permissionLevel = await readLatestPermissionLevel(
      debugLogFromTranscript(transcriptPath, sessionId),
    );
  }

  const action = preToolAction(policy, toolName, permissionLevel);

  if (action === "notify") {
    const record = pendingRecord(stdin, new Date().toISOString());
    if (record) {
      mkdirSync(spoolDir, { recursive: true });
      writeFileSync(
        spoolEntryPath(spoolDir, record.toolCallId),
        JSON.stringify(record),
      );
    }
    return DEFER;
  }

  if (action === "block") {
    const record = blockingRecord(stdin, new Date().toISOString());
    if (!record) return DEFER;
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(
      spoolEntryPath(spoolDir, record.toolCallId),
      JSON.stringify(record),
    );
    let decision: Decision | undefined;
    try {
      decision = await awaitDecision({
        read: () => readDecision(spoolDir, record.toolCallId),
        timeoutMs: (BLOCK_HOOK_TIMEOUT_SECONDS - 5) * 1000,
        intervalMs: 500,
      });
    } finally {
      // Clear the held blocker + its verdict regardless of outcome: `allow` lets
      // the tool run (PostToolUse would also clean up), while `deny`/timeout
      // never fire PostToolUse \u2014 so the hook owns cleanup here.
      rmSync(spoolEntryPath(spoolDir, record.toolCallId), { force: true });
      rmSync(decisionEntryPath(spoolDir, record.toolCallId), { force: true });
    }
    return decision ? decisionOutput(decision) : DEFER;
  }

  return DEFER; // action === "defer"
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
        rmSync(decisionEntryPath(spoolDir, id), { force: true });
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
