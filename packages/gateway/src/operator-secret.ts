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
  /** True when this run generated + persisted a fresh secret (⇒ show the QR). */
  created: boolean;
}

/**
 * Load the base32 secret from `file`, or generate one and persist it `0600`
 * (creating the parent dir `0700`) when the file is absent or empty. Returning
 * `created` lets the runner print the pairing QR exactly once — on first setup.
 */
export function loadOrCreateSecret(file: string): SecretLoad {
  if (existsSync(file)) {
    const secret = readFileSync(file, "utf8").trim();
    if (secret) return { secret, created: false };
  }
  const secret = generateTotpSecret();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return { secret, created: true };
}
