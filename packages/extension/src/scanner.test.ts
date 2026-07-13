import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyStatus,
  debugLogTitle,
  parseTranscript,
  scanSessions,
  storageHashFromUri,
} from "./scanner.js";

describe("parseTranscript", () => {
  it("counts turns, takes the first user message as title", () => {
    const content = [
      JSON.stringify({ type: "session.start", data: {} }),
      JSON.stringify({
        type: "user.message",
        data: { content: "Refactor the\nauth middleware" },
      }),
      JSON.stringify({ type: "user.message", data: { content: "and retry" } }),
    ].join("\n");
    const parsed = parseTranscript(content);
    expect(parsed.turns).toBe(2);
    expect(parsed.title).toBe("Refactor the auth middleware");
    expect(parsed.openInteractiveTools).toEqual([]);
  });

  it("flags an unmatched interactive tool call as an open blocker", () => {
    const content = [
      JSON.stringify({ type: "user.message", data: { content: "go" } }),
      JSON.stringify({
        type: "tool.execution_start",
        data: { toolCallId: "t1", toolName: "vscode_askQuestions" },
      }),
    ].join("\n");
    expect(parseTranscript(content).openInteractiveTools).toEqual([
      "vscode_askQuestions",
    ]);
  });

  it("does not flag an interactive start superseded by a later turn", () => {
    const content = [
      JSON.stringify({ type: "user.message", data: { content: "go" } }),
      JSON.stringify({
        type: "tool.execution_start",
        data: { toolCallId: "t1", toolName: "vscode_askQuestions" },
      }),
      // A later turn abandons the orphaned start (its complete never flushed).
      JSON.stringify({ type: "user.message", data: { content: "next task" } }),
    ].join("\n");
    expect(parseTranscript(content).openInteractiveTools).toEqual([]);
  });

  it("still flags an interactive start in the latest turn", () => {
    const content = [
      JSON.stringify({ type: "user.message", data: { content: "go" } }),
      JSON.stringify({ type: "assistant.turn_start", data: {} }),
      JSON.stringify({
        type: "tool.execution_start",
        data: { toolCallId: "t1", toolName: "vscode_askQuestions" },
      }),
    ].join("\n");
    expect(parseTranscript(content).openInteractiveTools).toEqual([
      "vscode_askQuestions",
    ]);
  });

  it("does not flag a matched (completed) interactive tool call", () => {
    const content = [
      JSON.stringify({
        type: "tool.execution_start",
        data: { toolCallId: "t1", toolName: "vscode_askQuestions" },
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: "t1", success: true },
      }),
    ].join("\n");
    expect(parseTranscript(content).openInteractiveTools).toEqual([]);
  });

  it("ignores non-interactive open tool calls (e.g. run_in_terminal)", () => {
    const content = JSON.stringify({
      type: "tool.execution_start",
      data: { toolCallId: "t1", toolName: "run_in_terminal" },
    });
    expect(parseTranscript(content).openInteractiveTools).toEqual([]);
  });

  it("skips malformed lines without throwing", () => {
    const content = ["not json", "", "{bad}"].join("\n");
    expect(parseTranscript(content)).toEqual({
      title: "",
      turns: 0,
      openInteractiveTools: [],
    });
  });
});

describe("storageHashFromUri", () => {
  const root = "/home/u/.vscode-server/data/User/workspaceStorage";

  it("takes the hash even when the extension id contains a slash", () => {
    // Our real storageUri: <root>/<hash>/cloakcode.@cloakcode/extension.
    expect(
      storageHashFromUri(
        root,
        `${root}/07c6b4c5abc/cloakcode.@cloakcode/extension`,
      ),
    ).toBe("07c6b4c5abc");
  });

  it("handles a normal single-segment extension id", () => {
    expect(storageHashFromUri(root, `${root}/deadbeef/publisher.name`)).toBe(
      "deadbeef",
    );
  });

  it("handles the packaged extension id (cloakcode.cloakcode)", () => {
    // The .vsix ships as publisher.name = cloakcode.cloakcode (no slash), vs the
    // dev-host's cloakcode.@cloakcode/extension — both must resolve the hash.
    expect(
      storageHashFromUri(root, `${root}/feedface99/cloakcode.cloakcode`),
    ).toBe("feedface99");
  });

  it("returns undefined when the path is not under the root", () => {
    expect(storageHashFromUri(root, "/somewhere/else/x")).toBeUndefined();
  });
});

describe("classifyStatus", () => {
  it("is blocked when live with an open interactive tool", () => {
    expect(classifyStatus(10, true, 120)).toBe("blocked");
  });
  it("is active when live without a blocker", () => {
    expect(classifyStatus(10, false, 120)).toBe("active");
  });
  it("is idle when past the live window regardless of open tools", () => {
    expect(classifyStatus(9999, true, 120)).toBe("idle");
  });
});

describe("scanSessions", () => {
  let root: string;
  const NOW = 1_700_000_000_000; // fixed clock

  async function writeSession(
    hashDir: string,
    folderUri: string,
    sessionId: string,
    lines: object[],
    ageSeconds: number,
  ): Promise<void> {
    const wsDir = path.join(root, hashDir);
    const txDir = path.join(wsDir, "GitHub.copilot-chat", "transcripts");
    await fs.mkdir(txDir, { recursive: true });
    await fs.writeFile(
      path.join(wsDir, "workspace.json"),
      JSON.stringify({ folder: folderUri }),
    );
    const file = path.join(txDir, `${sessionId}.jsonl`);
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    const when = new Date(NOW - ageSeconds * 1000);
    await fs.utimes(file, when, when);
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-scan-"));
    await writeSession(
      "hashA",
      "file:///home/u/myrepo",
      "sessA",
      [
        { type: "user.message", data: { content: "Refactor auth middleware" } },
        {
          type: "tool.execution_start",
          data: { toolCallId: "t1", toolName: "vscode_askQuestions" },
        },
      ],
      10, // live -> blocked
    );
    await writeSession(
      "hashB",
      "file:///home/u/other",
      "sessB",
      [
        { type: "user.message", data: { content: "Old task" } },
        {
          type: "tool.execution_start",
          data: { toolCallId: "t2", toolName: "read_file" },
        },
        {
          type: "tool.execution_complete",
          data: { toolCallId: "t2", success: true },
        },
      ],
      3 * 86400, // 3 days old -> idle
    );
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns instance-scoped summaries, newest first", async () => {
    const sessions = await scanSessions({
      instanceId: "inst-test",
      root,
      now: () => NOW,
    });
    expect(sessions).toHaveLength(2);

    const [first, second] = sessions;
    expect(first).toMatchObject({
      instanceId: "inst-test",
      sessionId: "sessA",
      workspace: "myrepo",
      workspaceHash: "hashA",
      title: "Refactor auth middleware",
      turns: 1,
      status: "blocked",
    });
    expect(second).toMatchObject({
      sessionId: "sessB",
      workspace: "other",
      workspaceHash: "hashB",
      status: "idle",
    });
  });

  it("uses an extension-supplied workspace name over workspace.json", async () => {
    const sessions = await scanSessions({
      instanceId: "inst-test",
      root,
      now: () => NOW,
      workspaceNames: new Map([["hashA", "My Cool Repo"]]),
    });
    const a = sessions.find((s) => s.sessionId === "sessA");
    expect(a?.workspace).toBe("My Cool Repo");
    expect(a?.workspaceHash).toBe("hashA");
    const b = sessions.find((s) => s.sessionId === "sessB");
    expect(b?.workspace).toBe("other"); // hashB keeps the workspace.json name
  });

  it("marks only sessions in ownedWorkspaceHashes as owned; else all owned", async () => {
    const scoped = await scanSessions({
      instanceId: "inst-test",
      root,
      now: () => NOW,
      ownedWorkspaceHashes: new Set(["hashA"]),
    });
    const owned = Object.fromEntries(scoped.map((s) => [s.sessionId, s.owned]));
    expect(owned["sessA"]).toBe(true); // hashA is this window's workspace
    expect(owned["sessB"]).toBe(false); // hashB is a foreign workspace

    const unscoped = await scanSessions({
      instanceId: "inst-test",
      root,
      now: () => NOW,
    });
    expect(unscoped.every((s) => s.owned)).toBe(true); // no scope => all owned
  });

  it("returns [] when the root does not exist", async () => {
    expect(
      await scanSessions({ instanceId: "x", root: "/no/such/dir" }),
    ).toEqual([]);
  });

  it("prefers the debug-log generated title over the first user message", async () => {
    const r = await fs.mkdtemp(path.join(os.tmpdir(), "cc-scan-title-"));
    const ws = path.join(r, "hashT");
    const tx = path.join(ws, "GitHub.copilot-chat", "transcripts");
    const dl = path.join(ws, "GitHub.copilot-chat", "debug-logs", "sessT");
    await fs.mkdir(tx, { recursive: true });
    await fs.mkdir(dl, { recursive: true });
    await fs.writeFile(
      path.join(ws, "workspace.json"),
      JSON.stringify({ folder: "file:///home/u/repo" }),
    );
    await fs.writeFile(
      path.join(tx, "sessT.jsonl"),
      JSON.stringify({
        type: "user.message",
        data: { content: "opening a new chat session for testing" },
      }),
    );
    await fs.writeFile(
      path.join(dl, "title-c1.jsonl"),
      JSON.stringify({
        type: "agent_response",
        name: "agent_response",
        attrs: {
          response: JSON.stringify([
            {
              role: "assistant",
              parts: [{ type: "text", content: "New chat session testing" }],
            },
          ]),
        },
      }),
    );
    try {
      const sessions = await scanSessions({
        instanceId: "i",
        root: r,
        now: () => NOW,
      });
      expect(sessions[0]?.title).toBe("New chat session testing");
    } finally {
      await fs.rm(r, { recursive: true, force: true });
    }
  });
});

describe("debugLogTitle", () => {
  it("extracts the generated title from the title child log", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "cc-title-"));
    const dir = path.join(base, "sessX");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "title-child123.jsonl"),
      [
        JSON.stringify({
          type: "session_start",
          name: "session_start",
          attrs: {},
        }),
        JSON.stringify({
          type: "agent_response",
          name: "agent_response",
          attrs: {
            response: JSON.stringify([
              {
                role: "assistant",
                parts: [{ type: "text", content: "Testing VS Code extension" }],
              },
            ]),
          },
        }),
      ].join("\n"),
    );
    try {
      expect(await debugLogTitle(base, "sessX")).toBe(
        "Testing VS Code extension",
      );
      expect(await debugLogTitle(base, "nope")).toBeUndefined();
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
