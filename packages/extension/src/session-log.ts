import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { LogRecord, LogSink } from "@cloakcode/protocol";

/** Filesystem-safe form of a sessionId (a UUID, but strip separators defensively). */
function safeName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
}

/**
 * A {@link LogSink} that ALSO persists each **session-scoped** log record to a
 * per-session JSONL file under `dir` — one file per `sessionId`, so the actions
 * CloakCode took on a session read back like a transcript. Records without a
 * `sessionId` field are skipped (they stay channel-only).
 *
 * NOT a hard audit trail (Copilot Chat has none either — it has transcripts):
 * best-effort, no hash chain, no forced mount. `dir` is CloakCode's own
 * workspace storage — durable already on host/WSL; in a container it rides the
 * ephemeral overlay (mount it yourself for durability). **Local-only** — these
 * files never leave the machine (docs/04). Fire-and-forget: a write failure is
 * swallowed so logging can never throw into the caller.
 */
export function sessionLogSink(dir: string): LogSink {
  return (record: LogRecord): void => {
    const sessionId = record.fields["sessionId"];
    if (typeof sessionId !== "string" || sessionId === "") return;
    const file = path.join(dir, `${safeName(sessionId)}.jsonl`);
    void fs
      .mkdir(dir, { recursive: true })
      .then(() => fs.appendFile(file, JSON.stringify(record) + "\n"))
      .catch(() => undefined);
  };
}
