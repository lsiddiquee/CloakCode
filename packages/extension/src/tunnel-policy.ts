import type { TunnelErrorKind } from "@cloakcode/gateway";

/** What to do with a Dev Tunnel failure. */
export type TunnelFixAction =
  "guide-auth" | "guide-missing" | "show-error" | "ignore";

/**
 * Decide how to surface a Dev Tunnel failure. Pure (no `vscode`).
 *
 * On activation (`silent`) we STILL guide the user through the actionable,
 * one-time setup errors — signing in (`auth`) and installing the CLI
 * (`missing`) — because they explicitly opted into `cloakcode.tunnel: devtunnel`
 * and the tunnel can't come up without them. A generic/transient failure is
 * surfaced only on an explicit request (Show Phone Link / Set Up Phone Tunnel),
 * so a plain reload never nags. When not silent, everything is surfaced.
 */
export function tunnelFixAction(
  kind: TunnelErrorKind | "unknown",
  silent: boolean,
): TunnelFixAction {
  if (kind === "auth") return "guide-auth";
  if (kind === "missing") return "guide-missing";
  return silent ? "ignore" : "show-error";
}
