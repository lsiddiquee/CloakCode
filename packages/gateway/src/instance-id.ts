import { hostname } from "node:os";

/**
 * Resolve the standalone gateway's **instance id** — the human identifier used
 * as the authenticator label (the otpauth `account`), the Dev-Tunnel name seed,
 * and the name shown to the phone. An explicit `CLOAKCODE_INSTANCE_ID` always
 * wins; otherwise it defaults to the **machine hostname** (the natural
 * per-machine identifier — the Windows computer/NetBIOS name, or the Unix
 * hostname), so several gateways (e.g. office vs home) are distinguishable in an
 * authenticator app without any configuration. Falls back to `"gateway"` only if
 * even the hostname is unavailable.
 *
 * Pure: the caller injects the env value and hostname so it is unit-testable.
 */
export function resolveInstanceId(
  envId: string | undefined,
  host: string | undefined = hostname(),
): string {
  const explicit = (envId ?? "").trim();
  if (explicit) return explicit;
  const h = (host ?? "").trim();
  if (h) return h;
  return "gateway";
}
