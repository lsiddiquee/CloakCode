import type { Server } from "node:http";
import { DEFAULT_PORT } from "@cloakcode/protocol";

/** A resolved bind decision: the port to try + whether to fall back to ephemeral. */
export interface PortPlan {
  port: number;
  fallbackToEphemeral: boolean;
}

function coerceInt(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** Parse a port env var: unset/blank/invalid → undefined; else a non-negative int. */
function parseEnvPort(env: string | undefined): number | undefined {
  if (env === undefined) return undefined;
  const t = env.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Resolve how to bind from the raw inputs — env taking precedence over the
 * setting. ONE rule for both the embedded bridge and the standalone gateway:
 *   - **nothing set** → prefer {@link DEFAULT_PORT}, fall back to an ephemeral
 *     port only if it is already taken;
 *   - explicit **`0`** → an ephemeral port (never a fixed one);
 *   - explicit **`N` (>0)** → lock port `N` (no fallback; fail loudly if taken).
 *
 * Unset is genuinely distinct from `0`: it is NOT modelled as a "preferred port"
 * flag — `0` still means ephemeral, absence means the 3543-then-ephemeral default.
 */
export function resolvePortPlan(
  env: string | undefined,
  setting?: number | null,
): PortPlan {
  const raw = parseEnvPort(env) ?? coerceInt(setting);
  if (raw === undefined)
    return { port: DEFAULT_PORT, fallbackToEphemeral: true };
  if (raw === 0) return { port: 0, fallbackToEphemeral: false };
  return { port: raw, fallbackToEphemeral: false };
}

/**
 * Bind `server` to `port` on `host`, resolving with the actually-bound port.
 * When `fallbackToEphemeral` is set and `port` is a specific busy port
 * (`EADDRINUSE`), retry once on an ephemeral port (0) instead of failing — this
 * backs the "prefer {@link DEFAULT_PORT}, else ephemeral" default. A locked
 * explicit port passes `fallbackToEphemeral: false` and fails loudly on a clash.
 */
export function listenWithFallback(
  server: Server,
  host: string,
  port: number,
  fallbackToEphemeral = false,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const attempt = (p: number, allowFallback: boolean): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener("error", onError);
        if (allowFallback && err.code === "EADDRINUSE") attempt(0, false);
        else reject(err);
      };
      server.once("error", onError);
      server.listen(p, host, () => {
        server.removeListener("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : p);
      });
    };
    attempt(port, fallbackToEphemeral && port !== 0);
  });
}
