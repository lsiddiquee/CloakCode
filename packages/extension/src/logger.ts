import {
  createLogger,
  type Logger,
  type LogFields,
  type LogLevel,
  type LogSink,
} from "@cloakcode/protocol";
import { formatRecord } from "@cloakcode/gateway";
import type { OutputChannel } from "vscode";
import { sessionLogSink } from "./session-log.js";

/**
 * A {@link Logger} for the extension ("hosted gateway"). Every record goes to the
 * VS Code **OutputChannel** (live, local — never cloud telemetry); when
 * `sessionLogDir` is given, session-scoped records are ALSO persisted to a
 * per-session JSONL file there (the action log, keyed by `sessionId`). The level
 * is a function so the `cloakcode.logLevel` setting changes it live. Reuses the
 * gateway's `formatRecord` so the extension and the standalone gateway render
 * identical lines.
 */
export function createOutputChannelLogger(
  channel: Pick<OutputChannel, "appendLine">,
  level: LogLevel | (() => LogLevel),
  opts: { base?: LogFields; sessionLogDir?: string } = {},
): Logger {
  const toChannel: LogSink = (record) =>
    channel.appendLine(formatRecord(record));
  const persist = opts.sessionLogDir
    ? sessionLogSink(opts.sessionLogDir)
    : undefined;
  const sink: LogSink = persist
    ? (record) => {
        toChannel(record);
        persist(record);
      }
    : toChannel;
  return createLogger({
    sink,
    level,
    ...(opts.base ? { base: opts.base } : {}),
  });
}
