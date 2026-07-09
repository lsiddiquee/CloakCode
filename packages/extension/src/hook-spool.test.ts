import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  spoolRecordSchema,
  baseToolCallId,
  spoolEntryPath,
  readSpoolDir,
  transcriptToolCallIds,
  computePendingBlockers,
  pendingRecord,
  eventToolCallId,
  buildHookConfig,
  SpoolFollower,
  type SpoolRecord,
} from "./hook-spool.js";

const RAW_QUESTION = "toolu_017o4WdwEJb2ruJ2PawLoPyH__vscode-1783582362827";
const BASE_QUESTION = "toolu_017o4WdwEJb2ruJ2PawLoPyH";
const RAW_RUN = "toolu_014s9ftYke93xQX364HyyaVo__vscode-1783582362828";
const BASE_RUN = "toolu_014s9ftYke93xQX364HyyaVo";

const questionInput = {
  questions: [
    {
      header: "File name",
      question: "Which file name should I use in /tmp/?",
      options: [
        { label: "cloakcode-test.txt", recommended: true },
        { label: "scratch.txt" },
      ],
      allowFreeformInput: true,
    },
    {
      header: "Write mode",
      question: "Overwrite or append?",
      options: [{ label: "Overwrite", recommended: true }, { label: "Append" }],
      allowFreeformInput: false,
    },
  ],
};

/** A spool record (toolCallId is stored as its base id). */
const rec = (
  toolCallId: string,
  toolName: string,
  input: unknown,
  sessionId = "sessA",
  ts = "2026-07-09T11:30:25.455Z",
): SpoolRecord => ({
  sessionId,
  toolCallId: baseToolCallId(toolCallId),
  toolName,
  input,
  ts,
});

/** Write a spool record as its own file (mirrors the hook's PreToolUse write). */
async function writeRecord(dir: string, r: SpoolRecord): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(spoolEntryPath(dir, r.toolCallId), JSON.stringify(r));
}

describe("baseToolCallId", () => {
  it("strips the __vscode-<n> suffix", () => {
    expect(baseToolCallId(RAW_QUESTION)).toBe(BASE_QUESTION);
  });

  it("leaves an already-base id untouched", () => {
    expect(baseToolCallId(BASE_QUESTION)).toBe(BASE_QUESTION);
  });
});

describe("spoolRecordSchema", () => {
  it("parses a spool record", () => {
    expect(
      spoolRecordSchema.parse(rec(RAW_RUN, "run_in_terminal", { command: "ls" }))
        .toolName,
    ).toBe("run_in_terminal");
  });

  it("rejects a record missing its sessionId", () => {
    expect(
      spoolRecordSchema.safeParse({ toolCallId: "t", toolName: "x", ts: "y" })
        .success,
    ).toBe(false);
  });
});

describe("transcriptToolCallIds", () => {
  it("collects base ids from tool.execution_start events only", () => {
    const content = [
      JSON.stringify({
        type: "tool.execution_start",
        data: { toolCallId: BASE_QUESTION },
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: BASE_QUESTION },
      }),
      JSON.stringify({ type: "user.message", data: { content: "hi" } }),
    ].join("\n");
    const ids = transcriptToolCallIds(content);
    expect(ids.has(BASE_QUESTION)).toBe(true);
    expect(ids.size).toBe(1);
  });
});

describe("computePendingBlockers", () => {
  it("returns a question blocker with confirmations for an interactive tool", () => {
    const blockers = computePendingBlockers(
      [rec(RAW_QUESTION, "vscode_askQuestions", questionInput)],
      "sessA",
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.toolCallId).toBe(BASE_QUESTION);
    expect(blockers[0]?.confirmations).toHaveLength(2);
    expect(blockers[0]?.confirmations?.[0]?.id).toBe(`conf-${BASE_QUESTION}-0`);
    expect(blockers[0]?.confirmations?.[0]?.allowFreeform).toBe(true);
    expect(blockers[0]?.input).toBeUndefined();
  });

  it("returns an approval blocker carrying raw input for an action tool", () => {
    const blockers = computePendingBlockers(
      [rec(RAW_RUN, "run_in_terminal", { command: "rm -v /tmp/x" })],
      "sessA",
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.toolName).toBe("run_in_terminal");
    expect(blockers[0]?.confirmations).toBeUndefined();
    expect((blockers[0]?.input as { command?: string })?.command).toBe(
      "rm -v /tmp/x",
    );
  });

  it("subtracts blockers already present in the transcript (dedup safety net)", () => {
    expect(
      computePendingBlockers(
        [rec(RAW_QUESTION, "vscode_askQuestions", questionInput)],
        "sessA",
        new Set([BASE_QUESTION]),
      ),
    ).toHaveLength(0);
  });

  it("isolates blockers by session", () => {
    const records = [
      rec(RAW_RUN, "run_in_terminal", { command: "ls" }, "sessA"),
      rec(RAW_QUESTION, "vscode_askQuestions", questionInput, "sessB"),
    ];
    expect(computePendingBlockers(records, "sessA")).toHaveLength(1);
    expect(computePendingBlockers(records, "sessB")).toHaveLength(1);
    expect(computePendingBlockers(records, "sessA")[0]?.toolName).toBe(
      "run_in_terminal",
    );
  });
});

describe("readSpoolDir", () => {
  it("reads record files, skips junk, missing dir -> []", async () => {
    expect(
      await readSpoolDir(path.join(os.tmpdir(), "cc-none-" + Date.now())),
    ).toEqual([]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-read-"));
    try {
      await writeRecord(dir, rec(RAW_RUN, "run_in_terminal", { command: "ls" }));
      await fs.writeFile(path.join(dir, "junk.json"), "not json");
      await fs.writeFile(path.join(dir, "ignore.txt"), "{}");
      const records = await readSpoolDir(dir);
      expect(records).toHaveLength(1);
      expect(records[0]?.toolCallId).toBe(BASE_RUN);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("pendingRecord / eventToolCallId", () => {
  const stdin = {
    session_id: "471f445d",
    tool_use_id: RAW_RUN,
    tool_name: "run_in_terminal",
    tool_input: { command: "ls" },
  };

  it("builds a pending record with the BASE toolCallId + input", () => {
    expect(pendingRecord(stdin, "2026-07-09T12:00:00.000Z")).toMatchObject({
      sessionId: "471f445d",
      toolCallId: BASE_RUN,
      toolName: "run_in_terminal",
      input: { command: "ls" },
    });
  });

  it("returns undefined when routing keys are missing", () => {
    expect(pendingRecord({ tool_name: "x" }, "t")).toBeUndefined();
  });

  it("resolves the base toolCallId for the delete path", () => {
    expect(eventToolCallId(stdin)).toBe(BASE_RUN);
    expect(eventToolCallId({})).toBeUndefined();
  });
});

describe("buildHookConfig", () => {
  it("uses absolute runtime + hook + spool dir", () => {
    const cfg = buildHookConfig({
      runtime: "/usr/local/bin/node",
      hookBin: "/ext/dist/hook.cjs",
      spoolDir: "/store/spool",
    }) as {
      hooks: Record<
        string,
        Array<{ command: string; env: Record<string, string> }>
      >;
    };
    const pre = cfg.hooks["PreToolUse"]?.[0];
    expect(pre?.command).toBe(
      '"/usr/local/bin/node" "/ext/dist/hook.cjs" PreToolUse',
    );
    expect(pre?.env["CLOAKCODE_SPOOL"]).toBe("/store/spool");
    expect(cfg.hooks["PostToolUse"]?.[0]?.command).toContain("PostToolUse");
  });
});

describe("SpoolFollower", () => {
  const setup = async (): Promise<{
    base: string;
    spoolDir: string;
    transcriptFile: string;
  }> => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "cc-spool-"));
    return {
      base,
      spoolDir: path.join(base, "spool"),
      transcriptFile: path.join(base, "sessA.jsonl"),
    };
  };

  it("emits on a new record file, clears when it's deleted", async () => {
    const { base, spoolDir, transcriptFile } = await setup();
    await writeRecord(
      spoolDir,
      rec(RAW_QUESTION, "vscode_askQuestions", questionInput),
    );
    await fs.writeFile(transcriptFile, "");
    const snapshots: number[] = [];
    const follower = new SpoolFollower(
      spoolDir,
      transcriptFile,
      "sessA",
      (blockers) => snapshots.push(blockers.length),
      { pollIntervalMs: 0 },
    );
    try {
      await follower.start();
      expect(snapshots.at(-1)).toBe(1);
      await fs.rm(spoolEntryPath(spoolDir, BASE_QUESTION), { force: true });
      await follower.refresh();
      expect(snapshots.at(-1)).toBe(0);
    } finally {
      follower.stop();
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it("clears via transcript catch-up even if the file lingers", async () => {
    const { base, spoolDir, transcriptFile } = await setup();
    await writeRecord(spoolDir, rec(RAW_RUN, "run_in_terminal", { command: "ls" }));
    await fs.writeFile(transcriptFile, "");
    const snapshots: number[] = [];
    const follower = new SpoolFollower(
      spoolDir,
      transcriptFile,
      "sessA",
      (b) => snapshots.push(b.length),
      { pollIntervalMs: 0 },
    );
    try {
      await follower.start();
      expect(snapshots.at(-1)).toBe(1);
      await fs.writeFile(
        transcriptFile,
        JSON.stringify({
          type: "tool.execution_start",
          data: { toolCallId: BASE_RUN },
        }),
      );
      await follower.refresh();
      expect(snapshots.at(-1)).toBe(0);
    } finally {
      follower.stop();
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it("does not re-emit an unchanged snapshot", async () => {
    const { base, spoolDir, transcriptFile } = await setup();
    await writeRecord(spoolDir, rec(RAW_RUN, "run_in_terminal", { command: "ls" }));
    await fs.writeFile(transcriptFile, "");
    let emits = 0;
    const follower = new SpoolFollower(
      spoolDir,
      transcriptFile,
      "sessA",
      () => (emits += 1),
      { pollIntervalMs: 0 },
    );
    try {
      await follower.start();
      await follower.refresh();
      await follower.refresh();
      expect(emits).toBe(1);
    } finally {
      follower.stop();
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
