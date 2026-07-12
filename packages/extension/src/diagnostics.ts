/**
 * Pure formatter for the `CloakCode: Show Diagnostics` command and the activation
 * log. It renders the runtime facts needed to debug session ownership and the
 * observer — most importantly `storageUri` (whose absence in an empty window /
 * Extension Development Host is why sessions can wrongly show read-only) and how
 * the owned workspace hashes were resolved. No `vscode`, no `fs` — the caller
 * gathers the snapshot; this only shapes it into text, so it stays unit-testable.
 */

export interface ScannedHash {
  /** The `workspaceStorage/<hash>` directory name. */
  hash: string;
  /** Number of Copilot transcript files under it. */
  transcripts: number;
  /** Whether this window can actuate its sessions (in the owned set). */
  owned: boolean;
}

export interface DiagnosticsSnapshot {
  instanceId: string;
  pid: number;
  /** Actual listening port, or null when the bridge failed to start. */
  bridgePort: number | null;
  configuredPort: number;
  /** `context.storageUri.fsPath`, or null when unavailable (empty window). */
  storageUri: string | null;
  /** Open workspace folder URIs (may be empty for an empty window). */
  workspaceFolders: string[];
  /** Resolved workspaceStorage hashes this window owns / can actuate. */
  ownedHashes: string[];
  /** How `ownedHashes` was derived (storageUri / env / vscode.lock / none). */
  ownedSource: string;
  /** The workspaceStorage root being scanned. */
  root: string;
  /** The hook spool directory. */
  spoolDir: string;
  /** Every workspaceStorage hash the scanner sees, with its owned decision. */
  scanned: ScannedHash[];
}

export function formatDiagnostics(s: DiagnosticsSnapshot): string {
  const port =
    s.bridgePort === null
      ? `not listening (configured ${s.configuredPort})`
      : s.bridgePort === s.configuredPort
        ? String(s.bridgePort)
        : `${s.bridgePort} (configured ${s.configuredPort})`;

  const lines = [
    "CloakCode diagnostics",
    "=====================",
    `instance:          ${s.instanceId}`,
    `process pid:       ${s.pid}`,
    `bridge port:       ${port}`,
    `storageUri:        ${s.storageUri ?? "undefined (empty window / Extension Development Host)"}`,
    `workspace folders: ${s.workspaceFolders.length ? s.workspaceFolders.join(", ") : "(none)"}`,
    `owned hashes:      ${s.ownedHashes.length ? s.ownedHashes.join(", ") : "(none — every session is read-only)"}`,
    `owned resolved by: ${s.ownedSource}`,
    `storage root:      ${s.root}`,
    `spool dir:         ${s.spoolDir}`,
    "",
    `workspaceStorage hashes seen (${s.scanned.length}):`,
  ];

  if (s.scanned.length === 0) {
    lines.push("  (none — no Copilot transcripts found under the root)");
  } else {
    for (const h of s.scanned) {
      const tag = h.owned ? "[OWNED]     " : "[read-only] ";
      const n = `${h.transcripts} transcript${h.transcripts === 1 ? "" : "s"}`;
      lines.push(`  ${tag}${h.hash}  (${n})`);
    }
  }

  return lines.join("\n");
}
