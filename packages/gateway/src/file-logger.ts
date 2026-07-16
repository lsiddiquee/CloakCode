import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { LogRecord, LogSink } from "@cloakcode/protocol";

/**
 * A {@link LogSink} that appends each record as one JSON line to `file` — the
 * **standalone gateway's on-disk action log**. The gateway relays the operator's
 * `remote-operator` actions (`rpc.relay` carries the `op` + `traceId`), so its
 * structured-record stream _is_ the action log; persisting it to a file gives a
 * durable record when the hub runs outside VS Code (Docker / host binary),
 * mirroring the extension's per-session action logs.
 *
 * **Local-only** and **redacted by construction** — `LogFields` are primitives
 * (ids, counts, booleans), never raw code/prompts (docs/04). Fire-and-forget and
 * best-effort: the parent dir is created and a write failure is swallowed, so
 * logging can never throw into the relay path.
 */
export function fileLogSink(file: string): LogSink {
  const dir = path.dirname(file);
  return (record: LogRecord): void => {
    void fs
      .mkdir(dir, { recursive: true })
      .then(() => fs.appendFile(file, JSON.stringify(record) + "\n"))
      .catch(() => undefined);
  };
}
