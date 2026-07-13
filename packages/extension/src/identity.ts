/**
 * Classify `vscode.env.remoteName` into a short environment kind for the default
 * instanceId. `undefined` (desktop) → `local`. Pure (no `vscode`), so it's
 * unit-testable.
 */
export function classifyRemote(remoteName: string | undefined): string {
  if (!remoteName) return "local";
  const l = remoteName.toLowerCase();
  if (l.includes("wsl")) return "wsl";
  if (l.includes("container")) return "devcontainer";
  if (l.includes("codespace")) return "codespaces";
  if (l.includes("ssh")) return "ssh";
  if (l.includes("tunnel")) return "tunnel";
  return l;
}

/**
 * Best-effort friendly name from a `devcontainer.json` (JSONC): the top-level
 * `"name"` value, extracted without a full JSONC parse (tolerant of comments and
 * trailing commas). Pure.
 */
export function parseDevcontainerName(jsonc: string): string | undefined {
  const m = jsonc.match(/"name"\s*:\s*"([^"]+)"/);
  return m?.[1]?.trim() || undefined;
}
