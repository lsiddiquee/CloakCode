import {
  createLogger,
  type Logger,
  type LogFields,
  type LogLevel,
} from "@cloakcode/protocol";
import { formatRecord } from "@cloakcode/gateway";
import type { OutputChannel } from "vscode";

/**
 * A {@link Logger} backed by the VS Code **OutputChannel** — the extension's
 * ("hosted gateway") sink. Output is ALWAYS local (never cloud telemetry). The
 * level is a function so the `cloakcode.logLevel` setting can change it live
 * without recreating the logger. Reuses the gateway's `formatRecord` so the
 * extension and the standalone gateway render identical lines.
 */
export function createOutputChannelLogger(
  channel: Pick<OutputChannel, "appendLine">,
  level: LogLevel | (() => LogLevel),
  base?: LogFields,
): Logger {
  return createLogger({
    sink: (record) => channel.appendLine(formatRecord(record)),
    level,
    ...(base ? { base } : {}),
  });
}
