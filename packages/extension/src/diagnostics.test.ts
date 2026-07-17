import { describe, expect, it } from "vitest";
import {
  collectCloakcodeEnv,
  formatDiagnostics,
  type DiagnosticsSnapshot,
} from "./diagnostics.js";

function snapshot(
  over: Partial<DiagnosticsSnapshot> = {},
): DiagnosticsSnapshot {
  return {
    instanceId: "ext-dev",
    pid: 71766,
    extensionMode: "Development",
    extensionVersion: "0.0.0",
    node: "v20.14.0",
    platform: "linux/x64",
    appName: "Visual Studio Code",
    appHost: "desktop",
    uiKind: "Desktop",
    remoteName: "dev-container",
    uriScheme: "vscode",
    language: "en",
    machineId: "machine-abc",
    extensionUri: "file:///ext/cloakcode",
    storageUri:
      "/home/u/.vscode-server/data/User/workspaceStorage/abc123/cloakcode.@cloakcode/extension",
    globalStorageUri:
      "/home/u/.vscode-server/data/User/globalStorage/cloakcode.extension",
    logUri: "/home/u/.vscode-server/data/logs/x/cloakcode",
    workspaceFile: null,
    workspaceFolders: [
      { name: "cloakcode", uri: "file:///workspaces/cloakcode" },
    ],
    ownedHashes: ["abc123"],
    ownedSource: "context.storageUri",
    root: "/home/u/.vscode-server/data/User/workspaceStorage",
    scanned: [
      { hash: "abc123", transcripts: 2, owned: true },
      { hash: "def456", transcripts: 1, owned: false },
    ],
    bridgePort: 7803,
    configuredPort: 7803,
    spoolDir: "/home/u/.cloakcode/spool",
    hookConfigPath: "/home/u/.copilot/hooks/cloakcode.json",
    cloakcodeEnv: [
      { key: "CLOAKCODE_INSTANCE_ID", value: "ext-dev" },
      { key: "CLOAKCODE_GATEWAY_PORT", value: "7803" },
    ],
    ...over,
  };
}

describe("formatDiagnostics", () => {
  it("renders all sections", () => {
    const out = formatDiagnostics(snapshot());
    for (const section of [
      "[identity]",
      "[vscode.env]",
      "[uris]",
      "[ownership]",
      "[runtime]",
      "[env]",
    ]) {
      expect(out).toContain(section);
    }
    expect(out).toContain("extension mode:    Development");
    expect(out).toContain("dev-container");
  });

  it("renders owned vs read-only hashes and the ownership source", () => {
    const out = formatDiagnostics(snapshot());
    expect(out).toContain("owned hashes:      abc123");
    expect(out).toContain("owned resolved by: context.storageUri");
    expect(out).toContain("[OWNED]     abc123  (2 transcripts)");
    expect(out).toContain("[read-only] def456  (1 transcript)");
  });

  it("shows the URIs and workspace folders with names", () => {
    const out = formatDiagnostics(snapshot());
    expect(out).toContain("- cloakcode  file:///workspaces/cloakcode");
    expect(out).toContain("globalStorageUri:");
    expect(out).toContain("does NOT change the workspace URL");
  });

  it("lists only allow-listed CLOAKCODE_* env vars", () => {
    const out = formatDiagnostics(snapshot());
    expect(out).toContain("CLOAKCODE_GATEWAY_PORT=7803");
    expect(out).toContain("CLOAKCODE_INSTANCE_ID=ext-dev");
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
    expect(out).toContain("workspaceFolders:  (none)");
  });

  it("notes when the bridge port differs from / is not listening", () => {
    expect(formatDiagnostics(snapshot({ bridgePort: 7811 }))).toContain(
      "bridge port:       7811 (configured 7803)",
    );
    expect(formatDiagnostics(snapshot({ bridgePort: null }))).toContain(
      "bridge port:       not listening (configured 7803)",
    );
  });
});

describe("collectCloakcodeEnv", () => {
  it("REDACTS secret-bearing values but keeps the key visible", () => {
    const got = collectCloakcodeEnv({
      CLOAKCODE_GATEWAY_TOKEN: "s3cr3t-shared-secret",
      CLOAKCODE_GATEWAY_PORT: "3543",
    });
    const token = got.find((e) => e.key === "CLOAKCODE_GATEWAY_TOKEN");
    expect(token).toEqual({
      key: "CLOAKCODE_GATEWAY_TOKEN",
      value: "<redacted>",
    });
    // The secret value must never appear.
    expect(JSON.stringify(got)).not.toContain("s3cr3t");
    // Non-secret vars pass through untouched.
    expect(got).toContainEqual({
      key: "CLOAKCODE_GATEWAY_PORT",
      value: "3543",
    });
  });

  it("only includes CLOAKCODE_* vars and sorts them", () => {
    const got = collectCloakcodeEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      CLOAKCODE_TUNNEL: "devtunnel",
      CLOAKCODE_INSTANCE_ID: "ext-dev",
    });
    expect(got.map((e) => e.key)).toEqual([
      "CLOAKCODE_INSTANCE_ID",
      "CLOAKCODE_TUNNEL",
    ]);
  });

  it("redacts any future *_SECRET / *_KEY / *_PASSWORD var too", () => {
    const got = collectCloakcodeEnv({
      CLOAKCODE_API_KEY: "abc",
      CLOAKCODE_DB_PASSWORD: "pw",
      CLOAKCODE_CLIENT_SECRET: "cs",
    });
    expect(got.every((e) => e.value === "<redacted>")).toBe(true);
  });

  it("leaves an unset/empty value as empty (not '<redacted>')", () => {
    expect(collectCloakcodeEnv({ CLOAKCODE_GATEWAY_TOKEN: "" })).toEqual([
      { key: "CLOAKCODE_GATEWAY_TOKEN", value: "" },
    ]);
  });
});
