import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateTotpSecret } from "./totp.js";

/**
 * Persistence + policy for the **standalone gateway's** operator-TOTP secret
 * (docs/04, F2a). The embedded bridge keeps its secret in VS Code SecretStorage;
 * a run-it-yourself hub has no keychain, so it persists a base32 secret to a
 * `0600` file (a mounted volume in Docker) and generates one on first run. Pure
 * except for the file I/O — unit-tested against a temp dir.
 */

/** Hosts that mean "this machine only" — no phone can reach them. */
function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

/**
 * Whether the gateway is reachable beyond loopback and therefore needs operator
 * auth by default: a wide bind (`0.0.0.0` / a LAN address) OR a live tunnel
 * (`CLOAKCODE_TUNNEL=devtunnel`) both expose the hub to other devices.
 */
export function isExposed(host: string, env: NodeJS.ProcessEnv): boolean {
  if (!isLoopbackHost(host)) return true;
  return (env["CLOAKCODE_TUNNEL"] ?? "").trim().toLowerCase() === "devtunnel";
}

/**
 * Map an MFA **mode** to on/off against a computed `exposed` signal: `off`/
 * `false`/`0`/`disabled` → off; `required`/`on`/`true`/`1` → on; anything else
 * (incl. `auto`/unset) → **secure by exposure**. Shared by the standalone gateway
 * (mode from `CLOAKCODE_MFA`) and the embedded bridge (mode from `cloakcode.mfa`).
 */
export function mfaEnabledFromMode(
  mode: string | undefined,
  exposed: boolean,
): boolean {
  const v = (mode ?? "").trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0" || v === "disabled") {
    return false;
  }
  if (v === "required" || v === "on" || v === "true" || v === "1") {
    return true;
  }
  return exposed;
}

/**
 * Decide whether operator MFA is on for the **standalone gateway**.
 * `CLOAKCODE_MFA`: `off` → off; `required` → on; unset → secure by exposure.
 */
export function operatorMfaEnabled(
  env: NodeJS.ProcessEnv,
  exposed: boolean,
): boolean {
  return mfaEnabledFromMode(env["CLOAKCODE_MFA"], exposed);
}

/**
 * Resolve the secret file: `CLOAKCODE_MFA_SECRET_FILE`, else
 * `~/.cloakcode/operator-totp.secret` (mount that dir as a volume to persist it
 * across container replacement).
 */
export function resolveSecretFile(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  const override = env["CLOAKCODE_MFA_SECRET_FILE"];
  if (override && override.trim()) return override.trim();
  return join(home, ".cloakcode", "operator-totp.secret");
}

export interface SecretLoad {
  /** The base32 TOTP secret. */
  secret: string;
  /** Whether first-run enrolment has been verified (else enrolment mode). */
  confirmed: boolean;
  /** True when this run generated + persisted a fresh secret (⇒ show the QR). */
  created: boolean;
}

interface SecretFile {
  secret: string;
  confirmed: boolean;
}

/** Read the secret file: the `{secret, confirmed}` JSON, or a legacy plain
 *  base32 file (pre-enrolment) treated as already-confirmed. */
function readSecretFile(file: string): SecretFile | undefined {
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { secret?: unknown }).secret === "string" &&
      (parsed as { secret: string }).secret
    ) {
      const p = parsed as { secret: string; confirmed?: unknown };
      return { secret: p.secret, confirmed: Boolean(p.confirmed) };
    }
  } catch {
    // not JSON — fall through to the legacy plain-secret path
  }
  return { secret: raw, confirmed: true };
}

function writeSecretFile(file: string, data: SecretFile): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(data)}\n`, { mode: 0o600 });
}

/**
 * Load the `{secret, confirmed}` from `file`, or generate a fresh secret and
 * persist it `0600` (dir `0700`) when the file is absent/empty or `reset` is set.
 * A fresh secret is **unconfirmed** (enrolment mode) until a code is verified;
 * `created` lets the runner show the pairing QR. `reset` regenerates for lockout
 * recovery (`CLOAKCODE_MFA_RESET`).
 */
export function loadOrCreateSecret(
  file: string,
  opts: { reset?: boolean } = {},
): SecretLoad {
  if (!opts.reset) {
    const existing = readSecretFile(file);
    if (existing) return { ...existing, created: false };
  }
  const secret = generateTotpSecret();
  writeSecretFile(file, { secret, confirmed: false });
  return { secret, confirmed: false, created: true };
}

/** Persist that enrolment was verified (the `OperatorAuth.onConfirmed` hook). */
export function persistConfirmed(file: string): void {
  const existing = readSecretFile(file);
  if (existing && !existing.confirmed) {
    writeSecretFile(file, { secret: existing.secret, confirmed: true });
  }
}
