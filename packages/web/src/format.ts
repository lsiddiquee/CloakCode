import type { SessionStatus } from "@cloakcode/protocol";

/** Compact human age from an idle-seconds value: `0s`, `6m`, `2h`, `3d`. */
export function humanAge(seconds: number): string {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${Math.max(0, Math.floor(seconds))}s`;
}

/** Short status word shown next to a session row. */
export function statusLabel(
  status: SessionStatus,
  idleSeconds: number,
): string {
  switch (status) {
    case "blocked":
      return `blocked ${humanAge(idleSeconds)}`;
    case "active":
      return "active";
    case "idle":
      return `idle ${humanAge(idleSeconds)}`;
  }
}
