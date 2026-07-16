import {
  createLogger,
  LOG_LEVELS,
  type Logger,
  type LogFields,
  type LogLevel,
  type LogRecord,
} from "@cloakcode/protocol";

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
 * STANDALONE gateway. This is the swap point: keep the callsites structured and
 * a richer sink (rotating file, etc.) drops in behind the same port later.
 */
export function createConsoleLogger(
  opts: {
    level?: LogLevel | (() => LogLevel);
    base?: LogFields;
    prefix?: string;
  } = {},
): Logger {
  const prefix = opts.prefix ?? "[cloakcode-gateway]";
  return createLogger({
    sink: (record) => {
      const line = `${prefix} ${formatRecord(record)}`;
      if (record.level === "error") console.error(line);
      else if (record.level === "warn") console.warn(line);
      else console.log(line);
    },
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
