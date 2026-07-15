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
      inTurn: false,
    });
  });

  it("flags an open assistant turn (turn_start, no turn_end) as inTurn", () => {
    const content = [
      JSON.stringify({ type: "user.message", data: { content: "go" } }),
      JSON.stringify({
        type: "assistant.turn_start",
        data: { turnId: "T1" },
      }),
    ].join("\n");
    expect(parseTranscript(content).inTurn).toBe(true);
  });

  it("clears inTurn once the turn ends", () => {
    const content = [
      JSON.stringify({ type: "assistant.turn_start", data: { turnId: "T1" } }),
      JSON.stringify({ type: "assistant.turn_end", data: { turnId: "T1" } }),
    ].join("\n");
    expect(parseTranscript(content).inTurn).toBe(false);
  });

  it("resets a dangling turn_start when a new turn starts and ends (self-heal)", () => {
    // T1's turn_end was never flushed (editor-hosted, §4.10); a later turn that
    // does close must NOT leave the session reading mid-turn forever.
    const content = [
      JSON.stringify({ type: "assistant.turn_start", data: { turnId: "T1" } }),
      JSON.stringify({ type: "user.message", data: { content: "next" } }),
      JSON.stringify({ type: "assistant.turn_start", data: { turnId: "T2" } }),
      JSON.stringify({ type: "assistant.turn_end", data: { turnId: "T2" } }),
    ].join("\n");
    expect(parseTranscript(content).inTurn).toBe(false);
  });

  it("keeps inTurn true through a mid-turn steer user.message", () => {
    // A steer is recorded as an ordinary user.message INSIDE the running turn
    // (§3.1) — it must not clear the in-flight turn (reset is turn_start-only).
    const content = [
      JSON.stringify({ type: "user.message", data: { content: "go" } }),
      JSON.stringify({ type: "assistant.turn_start", data: { turnId: "T1" } }),
      JSON.stringify({ type: "user.message", data: { content: "actually…" } }),
    ].join("\n");
    expect(parseTranscript(content).inTurn).toBe(true);
  });

  it("is NOT inTurn on the spurious trailing turn_start after a turn_end", () => {
    // Copilot writes a childless `turn_start` right after each `turn_end` (same
    // ts, parent = the turn_end) as an idle next-turn placeholder — it must NOT
    // read as mid-turn (docs/02 §3.3/§4.28; the real-world bug this fixes).
    const content = [
      JSON.stringify({ type: "user.message", data: { content: "go" } }),
      JSON.stringify({ type: "assistant.turn_start", data: { turnId: "T1" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "done" } }),
      JSON.stringify({ type: "assistant.turn_end", data: { turnId: "T1" } }),
      // The placeholder: opens right after the turn_end, no activity follows.
      JSON.stringify({ type: "assistant.turn_start", data: { turnId: "T2" } }),
    ].join("\n");
    expect(parseTranscript(content).inTurn).toBe(false);
  });

  it("IS inTurn for an auto-chained turn (after a turn_end) once it has activity", () => {
    // A real turn can also follow a turn_end (agent auto-chaining); the child
    // event (a tool call) proves it is live, unlike the childless placeholder.
    const content = [
      JSON.stringify({ type: "assistant.turn_end", data: { turnId: "T1" } }),
      JSON.stringify({ type: "assistant.turn_start", data: { turnId: "T2" } }),
      JSON.stringify({
        type: "tool.execution_start",
        data: { toolCallId: "x", toolName: "read_file" },
      }),
    ].join("\n");
    expect(parseTranscript(content).inTurn).toBe(true);
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

  it("handles the packaged extension id (rexwel.cloakcode)", () => {
    // The .vsix ships as publisher.name = rexwel.cloakcode (no slash), vs the
    // dev-host's rexwel.@cloakcode/extension — both must resolve the hash.
    expect(
      storageHashFromUri(root, `${root}/feedface99/rexwel.cloakcode`),
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

  it("sets inTurn only for a LIVE session mid-turn (open turn_start)", async () => {
    const r = await fs.mkdtemp(path.join(os.tmpdir(), "cc-inturn-"));
    const mk = async (hash: string, id: string, ageSeconds: number) => {
      const txDir = path.join(r, hash, "GitHub.copilot-chat", "transcripts");
      await fs.mkdir(txDir, { recursive: true });
      const file = path.join(txDir, `${id}.jsonl`);
      await fs.writeFile(
        file,
        [
          { type: "user.message", data: { content: "go" } },
          { type: "assistant.turn_start", data: { turnId: "T1" } },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n"),
      );
      const when = new Date(NOW - ageSeconds * 1000);
      await fs.utimes(file, when, when);
    };
    await mk("live", "sLive", 5); // live + open turn -> mid-turn
    await mk("old", "sOld", 3 * 86400); // dormant open turn -> NOT mid-turn
    const sessions = await scanSessions({
      instanceId: "x",
      root: r,
      now: () => NOW,
    });
    const byId = Object.fromEntries(
      sessions.map((s) => [s.sessionId, s.inTurn]),
    );
    expect(byId["sLive"]).toBe(true);
    expect(byId["sOld"]).toBe(false);
    await fs.rm(r, { recursive: true, force: true });
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

  it("collapses a session under multiple hash dirs into one owned row", async () => {
    // VS Code workspaceStorage hash instability (docs/05): the same sessionId
    // lands under two <hash> dirs — one the window owns, one a bare twin.
    const r = await fs.mkdtemp(path.join(os.tmpdir(), "cc-dedup-"));
    const write = async (
      hashDir: string,
      ageSeconds: number,
    ): Promise<void> => {
      const txDir = path.join(r, hashDir, "GitHub.copilot-chat", "transcripts");
      await fs.mkdir(txDir, { recursive: true });
      await fs.writeFile(
        path.join(r, hashDir, "workspace.json"),
        JSON.stringify({ folder: "file:///home/u/dup" }),
      );
      const file = path.join(txDir, "dupsess.jsonl");
      await fs.writeFile(
        file,
        JSON.stringify({ type: "user.message", data: { content: "dup task" } }),
      );
      const when = new Date(NOW - ageSeconds * 1000);
      await fs.utimes(file, when, when);
    };
    await write("hashOwned", 30);
    await write("hashTwin", 5); // the twin is FRESHER, but foreign
    try {
      const sessions = await scanSessions({
        instanceId: "i1",
        root: r,
        now: () => NOW,
        ownedWorkspaceHashes: new Set(["hashOwned"]),
      });
      const dup = sessions.filter((s) => s.sessionId === "dupsess");
      expect(dup).toHaveLength(1);
      expect(dup[0]?.owned).toBe(true); // owned wins even though the twin is fresher
      expect(dup[0]?.workspaceHash).toBe("hashOwned");
    } finally {
      await fs.rm(r, { recursive: true, force: true });
    }
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
