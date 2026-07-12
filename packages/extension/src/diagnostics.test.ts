import { describe, expect, it } from "vitest";
import { formatDiagnostics, type DiagnosticsSnapshot } from "./diagnostics.js";

function snapshot(
  over: Partial<DiagnosticsSnapshot> = {},
): DiagnosticsSnapshot {
  return {
    instanceId: "ext-dev",
    pid: 71766,
    bridgePort: 7803,
    configuredPort: 7803,
    storageUri:
      "/home/u/.vscode-server/data/User/workspaceStorage/abc123/cloakcode.extension",
    workspaceFolders: ["file:///workspaces/cloakcode"],
    ownedHashes: ["abc123"],
    ownedSource: "context.storageUri",
    root: "/home/u/.vscode-server/data/User/workspaceStorage",
    spoolDir: "/home/u/.cloakcode/spool",
    scanned: [
      { hash: "abc123", transcripts: 2, owned: true },
      { hash: "def456", transcripts: 1, owned: false },
    ],
    ...over,
  };
}

describe("formatDiagnostics", () => {
  it("renders owned vs read-only hashes and the ownership source", () => {
    const out = formatDiagnostics(snapshot());
    expect(out).toContain("owned hashes:      abc123");
    expect(out).toContain("owned resolved by: context.storageUri");
    expect(out).toContain("[OWNED]     abc123  (2 transcripts)");
    expect(out).toContain("[read-only] def456  (1 transcript)");
  });

  it("flags the empty-window case that makes everything read-only", () => {
    const out = formatDiagnostics(
      snapshot({
        storageUri: null,
        workspaceFolders: [],
        ownedHashes: [],
        ownedSource: "none",
        scanned: [{ hash: "def456", transcripts: 1, owned: false }],
      }),
    );
    expect(out).toContain(
      "storageUri:        undefined (empty window / Extension Development Host)",
    );
    expect(out).toContain(
      "owned hashes:      (none — every session is read-only)",
    );
    expect(out).toContain("workspace folders: (none)");
  });

  it("notes when the bridge port differs from the configured port", () => {
    const out = formatDiagnostics(snapshot({ bridgePort: 7811 }));
    expect(out).toContain("bridge port:       7811 (configured 7803)");
  });

  it("notes when the bridge is not listening", () => {
    const out = formatDiagnostics(snapshot({ bridgePort: null }));
    expect(out).toContain("bridge port:       not listening (configured 7803)");
  });
});
