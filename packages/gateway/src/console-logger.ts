import {
  createLogger,
  LOG_LEVELS,
  type Logger,
  type LogFields,
  type LogLevel,
  type LogRecord,
  type LogSink,
} from "@cloakcode/protocol";
import { fileLogSink } from "./file-logger.js";

/** Format one record to a single line: `<ts> <LEVEL> <event> k=v …`. */
export function formatRecord(record: LogRecord): string {
  const fields = Object.entries(record.fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const s = String(v);
      return `${k}=${/\s/.test(s) ? JSON.stringify(s) : s}`;
    })
    .join(" ");
  const level = record.level.toUpperCase().padEnd(5);
  return `${record.ts} ${level} ${record.event}${fields ? ` ${fields}` : ""}`;
}

/** Coerce an env string to a LogLevel, or undefined if not a known level. */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  const v = value?.trim().toLowerCase();
  return LOG_LEVELS.find((l) => l === v);
}

/**
 * A {@link Logger} that writes formatted lines to `console` — the sink for the
 * STANDALONE gateway. When `logFile` is set, each record is ALSO persisted as
 * JSONL to that file (the on-disk action log; see {@link fileLogSink}). This is
 * the swap point: keep the callsites structured and a richer sink (rotating
 * file, etc.) drops in behind the same port later.
 */
export function createConsoleLogger(
  opts: {
    level?: LogLevel | (() => LogLevel);
    base?: LogFields;
    prefix?: string;
    logFile?: string;
  } = {},
): Logger {
  const prefix = opts.prefix ?? "[cloakcode-gateway]";
  const toConsole: LogSink = (record) => {
    const line = `${prefix} ${formatRecord(record)}`;
    if (record.level === "error") console.error(line);
    else if (record.level === "warn") console.warn(line);
    else console.log(line);
  };
  const persist = opts.logFile ? fileLogSink(opts.logFile) : undefined;
  const sink: LogSink = persist
    ? (record) => {
        toConsole(record);
        persist(record);
      }
    : toConsole;
  return createLogger({
    sink,
    ...(opts.level !== undefined ? { level: opts.level } : {}),
    ...(opts.base ? { base: opts.base } : {}),
  });
}

/** A no-op Logger for tests/embeds that don't want any output. */
export function silentLogger(base?: LogFields): Logger {
  return createLogger({
    sink: () => undefined,
    ...(base ? { base } : {}),
  });
}
