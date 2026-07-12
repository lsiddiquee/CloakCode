/**
 * Pure formatter for the `CloakCode: Show Diagnostics` command and the activation
 * dump. It renders (almost) everything the extension host can see about itself —
 * identity, the VS Code environment, every relevant URI, session ownership, and
 * runtime wiring — so we can tell at a glance what is usable and what is not. No
 * `vscode`, no `fs`: the caller gathers the snapshot, this only shapes it, so it
 * stays unit-testable.
 *
 * SECURITY: a diagnostic still obeys the no-log-secrets rule — the caller passes
 * only an allow-list of `CLOAKCODE_*` env vars (ports, ids, paths — never
 * tokens), and nothing here prints code, prompts, or credentials.
 */

export interface ScannedHash {
  /** The `workspaceStorage/<hash>` directory name. */
  hash: string;
  /** Number of Copilot transcript files under it. */
  transcripts: number;
  /** Whether this window can actuate its sessions (in the owned set). */
  owned: boolean;
}

export interface WorkspaceFolderInfo {
  name: string;
  uri: string;
}

export interface DiagnosticsSnapshot {
  // identity & mode
  instanceId: string;
  pid: number;
  extensionMode: string; // "Development" | "Production" | "Test"
  extensionVersion: string;
  node: string; // process.version
  platform: string; // e.g. "linux/x64"
  // vscode.env
  appName: string;
  appHost: string;
  uiKind: string; // "Desktop" | "Web"
  remoteName: string | null; // "dev-container" / "wsl" / "ssh-remote" / null (local)
  uriScheme: string;
  language: string;
  machineId: string;
  // URIs — storage is DERIVED from the workspace (the <hash> = md5(folderUri)),
  // so forcing the storage dir to exist does NOT change the workspace URL.
  extensionUri: string;
  storageUri: string | null; // .../workspaceStorage/<hash>/<extId>; null = empty window
  globalStorageUri: string; // per-profile, no workspace hash
  logUri: string; // per-session
  workspaceFile: string | null; // the .code-workspace, if a multi-root workspace
  workspaceFolders: WorkspaceFolderInfo[];
  // ownership (the owned flag)
  ownedHashes: string[];
  ownedSource: string;
  root: string;
  scanned: ScannedHash[];
  // runtime
  bridgePort: number | null;
  configuredPort: number;
  spoolDir: string;
  hookConfigPath: string;
  // selected non-secret env (allow-list of CLOAKCODE_* only)
  cloakcodeEnv: { key: string; value: string }[];
}

export function formatDiagnostics(s: DiagnosticsSnapshot): string {
  const port =
    s.bridgePort === null
      ? `not listening (configured ${s.configuredPort})`
      : s.bridgePort === s.configuredPort
        ? String(s.bridgePort)
        : `${s.bridgePort} (configured ${s.configuredPort})`;

  const row = (label: string, value: string): string =>
    `  ${`${label}:`.padEnd(19)}${value}`;

  const L: string[] = ["CloakCode diagnostics", "====================="];

  L.push("", "[identity]");
  L.push(row("instance", s.instanceId));
  L.push(row("process pid", String(s.pid)));
  L.push(row("extension mode", s.extensionMode));
  L.push(row("extension version", s.extensionVersion));
  L.push(row("node / platform", `${s.node} / ${s.platform}`));

  L.push("", "[vscode.env]");
  L.push(row("app", `${s.appName} (host: ${s.appHost}) [${s.uiKind}]`));
  L.push(row("remote", s.remoteName ?? "(local)"));
  L.push(row("uri scheme", s.uriScheme));
  L.push(row("language", s.language));
  L.push(row("machineId", s.machineId));

  L.push(
    "",
    "[uris]  storage is derived from the workspace (<hash> = md5(folderUri));",
    "        forcing the storage dir to exist does NOT change the workspace URL.",
  );
  L.push(row("extensionUri", s.extensionUri));
  L.push(
    row(
      "storageUri",
      s.storageUri ??
        "undefined (empty window / Extension Development Host)",
    ),
  );
  L.push(row("globalStorageUri", s.globalStorageUri));
  L.push(row("logUri", s.logUri));
  L.push(
    row(
      "workspaceFile",
      s.workspaceFile ?? "(none — single-folder or empty window)",
    ),
  );
  if (s.workspaceFolders.length === 0) {
    L.push(row("workspaceFolders", "(none)"));
  } else {
    L.push("  workspaceFolders:");
    for (const f of s.workspaceFolders) L.push(`    - ${f.name}  ${f.uri}`);
  }

  L.push("", "[ownership]");
  L.push(
    row(
      "owned hashes",
      s.ownedHashes.length
        ? s.ownedHashes.join(", ")
        : "(none — every session is read-only)",
    ),
  );
  L.push(row("owned resolved by", s.ownedSource));
  L.push(row("storage root", s.root));
  L.push(`  workspaceStorage hashes seen (${s.scanned.length}):`);
  if (s.scanned.length === 0) {
    L.push("    (none — no Copilot transcripts found under the root)");
  } else {
    for (const h of s.scanned) {
      const tag = h.owned ? "[OWNED]     " : "[read-only] ";
      const n = `${h.transcripts} transcript${h.transcripts === 1 ? "" : "s"}`;
      L.push(`    ${tag}${h.hash}  (${n})`);
    }
  }

  L.push("", "[runtime]");
  L.push(row("bridge port", port));
  L.push(row("spool dir", s.spoolDir));
  L.push(row("hook config", s.hookConfigPath));

  L.push("", "[env] (CLOAKCODE_* only — no secrets)");
  if (s.cloakcodeEnv.length === 0) {
    L.push("  (none set)");
  } else {
    for (const e of s.cloakcodeEnv) L.push(`  ${e.key}=${e.value}`);
  }

  return L.join("\n");
}
