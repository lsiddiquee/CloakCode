/**
 * The CloakCode **logger port** — an ILogger-style abstraction shared by every
 * package. Pure: no `vscode`, no `node`, browser-safe — only the injected SINK
 * differs per runtime (console for the standalone gateway, an OutputChannel for
 * the extension, `console` for the web client).
 *
 * Two hard rules bake the product's constraints into the type system:
 *  1. **Local-only.** Output never leaves the machine (no cloud telemetry,
 *     docs/04). A `traceId` is minted purely to CORRELATE local logs across the
 *     extension / gateway / hook / web boundaries — it is never shipped anywhere.
 *  2. **Redacted by construction.** {@link LogFields} accepts primitives only —
 *     identity, shape, outcome (ids, counts, sizes, durations, booleans, hashes)
 *     — so raw code / prompts / secrets can't be passed as a free-form blob.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Ascending severity; index gives the threshold ordinal. */
export const LOG_LEVELS: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
];

/** True when `level` meets or exceeds the minimum `min`. */
export function shouldLog(min: LogLevel, level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(min);
}

/**
 * Redaction-by-construction: log fields are **primitives only**. Log identity,
 * shape and outcome — never content. A body that must be referenced becomes a
 * hash + length, not the bytes.
 */
export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

/** One finished, redacted record handed to a sink. */
export interface LogRecord {
  /** ISO-8601 timestamp. */
  ts: string;
  level: LogLevel;
  /** Stable event name, e.g. `bridge.listen`, `actuator.respond`. */
  event: string;
  /** Bound context (component, instanceId, traceId, …) merged with call fields. */
  fields: LogFields;
}

/** A sink writes a finished record to a LOCAL destination (console/channel/file). */
export type LogSink = (record: LogRecord) => void;

/** The ILogger-style port. `child()` binds extra context (e.g. a `traceId`). */
export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  trace(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger with additional bound context merged into every record. */
  child(fields: LogFields): Logger;
  /** The effective minimum level right now (may be dynamic — see `level`). */
  readonly level: LogLevel;
}

export interface LoggerOptions {
  /** Where finished records go (console, OutputChannel, file…). */
  sink: LogSink;
  /**
   * Minimum level to emit. A function is re-read on every call, so a host can
   * change the level at runtime (e.g. the `cloakcode.logLevel` setting) without
   * recreating the logger. Default `info`.
   */
  level?: LogLevel | (() => LogLevel);
  /** Context stamped on every record (e.g. `{ component, instanceId }`). */
  base?: LogFields;
}

/**
 * Build a {@link Logger} over an injected sink. Pure + synchronous; the sink
 * decides the destination. Level-filters before the sink so a dropped record
 * costs nothing but the comparison.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const levelOpt = opts.level;
  let readLevel: () => LogLevel;
  if (typeof levelOpt === "function") {
    readLevel = levelOpt;
  } else {
    const fixed: LogLevel = levelOpt ?? "info";
    readLevel = () => fixed;
  }
  const make = (bound: LogFields): Logger => {
    const log = (lvl: LogLevel, event: string, fields?: LogFields): void => {
      if (!shouldLog(readLevel(), lvl)) return;
      opts.sink({
        ts: new Date().toISOString(),
        level: lvl,
        event,
        fields: { ...bound, ...fields },
      });
    };
    return {
      get level(): LogLevel {
        return readLevel();
      },
      log,
      trace: (e, f) => log("trace", e, f),
      debug: (e, f) => log("debug", e, f),
      info: (e, f) => log("info", e, f),
      warn: (e, f) => log("warn", e, f),
      error: (e, f) => log("error", e, f),
      child: (fields) => make({ ...bound, ...fields }),
    };
  };
  return make(opts.base ?? {});
}

/**
 * Mint a short correlation id for one action / flow, propagated ACROSS process
 * boundaries so their local logs line up. **Local-only** — never sent to any
 * cloud/telemetry sink. Uses `crypto.randomUUID` when available (Node + secure
 * browser contexts, incl. localhost + the https tunnel), with a plain fallback.
 */
export function newTraceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 12);
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  ).slice(0, 12);
}
