import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  spoolRecordSchema,
  parseSpool,
  baseToolCallId,
  transcriptToolCallIds,
  computePendingBlockers,
  buildSpoolRecord,
  SpoolFollower,
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

const pendingLine = (
  toolCallId: string,
  toolName: string,
  input: unknown,
  sessionId = "sessA",
  ts = "2026-07-09T11:30:25.455Z",
): string =>
  JSON.stringify({
    phase: "pending",
    sessionId,
    toolCallId,
    toolName,
    input,
    ts,
  });

const resolvedLine = (
  toolCallId: string,
  sessionId = "sessA",
  ts = "2026-07-09T11:30:37.263Z",
): string => JSON.stringify({ phase: "resolved", sessionId, toolCallId, ts });

describe("baseToolCallId", () => {
  it("strips the __vscode-<n> suffix", () => {
    expect(baseToolCallId(RAW_QUESTION)).toBe(BASE_QUESTION);
  });

  it("leaves an already-base id untouched", () => {
    expect(baseToolCallId(BASE_QUESTION)).toBe(BASE_QUESTION);
  });
});

describe("spoolRecordSchema", () => {
  it("parses a pending record", () => {
    expect(
      spoolRecordSchema.parse(
        JSON.parse(pendingLine(RAW_RUN, "run_in_terminal", { command: "ls" })),
      ).phase,
    ).toBe("pending");
  });

  it("parses a resolved record", () => {
    expect(
      spoolRecordSchema.parse(JSON.parse(resolvedLine(RAW_RUN))).phase,
    ).toBe("resolved");
  });

  it("rejects an unknown phase", () => {
    expect(
      spoolRecordSchema.safeParse({
        phase: "nope",
        sessionId: "s",
        toolCallId: "t",
        ts: "x",
      }).success,
    ).toBe(false);
  });
});

describe("parseSpool", () => {
  it("skips blank and non-JSON lines, keeps valid records", () => {
    const content = [
      "",
      "not json",
      pendingLine(RAW_RUN, "run_in_terminal", { command: "ls" }),
      "{}",
      resolvedLine(RAW_RUN),
    ].join("\n");
    const records = parseSpool(content);
    expect(records).toHaveLength(2);
    expect(records[0]?.phase).toBe("pending");
    expect(records[1]?.phase).toBe("resolved");
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
    const records = parseSpool(
      pendingLine(RAW_QUESTION, "vscode_askQuestions", questionInput),
    );
    const blockers = computePendingBlockers(records, "sessA");
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.toolCallId).toBe(BASE_QUESTION);
    expect(blockers[0]?.confirmations).toHaveLength(2);
    expect(blockers[0]?.confirmations?.[0]?.id).toBe(`conf-${BASE_QUESTION}-0`);
    expect(blockers[0]?.confirmations?.[0]?.allowFreeform).toBe(true);
    expect(blockers[0]?.input).toBeUndefined();
  });

  it("returns an approval blocker carrying raw input for an action tool", () => {
    const records = parseSpool(
      pendingLine(RAW_RUN, "run_in_terminal", { command: "rm -v /tmp/x" }),
    );
    const blockers = computePendingBlockers(records, "sessA");
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.toolName).toBe("run_in_terminal");
    expect(blockers[0]?.confirmations).toBeUndefined();
    expect((blockers[0]?.input as { command?: string })?.command).toBe(
      "rm -v /tmp/x",
    );
  });

  it("drops a blocker once a resolved record arrives", () => {
    const records = parseSpool(
      [
        pendingLine(RAW_RUN, "run_in_terminal", { command: "ls" }),
        resolvedLine(RAW_RUN),
      ].join("\n"),
    );
    expect(computePendingBlockers(records, "sessA")).toHaveLength(0);
  });

  it("subtracts blockers already present in the transcript (dedup safety net)", () => {
    const records = parseSpool(
      pendingLine(RAW_QUESTION, "vscode_askQuestions", questionInput),
    );
    const transcriptIds = new Set([BASE_QUESTION]);
    expect(
      computePendingBlockers(records, "sessA", transcriptIds),
    ).toHaveLength(0);
  });

  it("isolates blockers by session", () => {
    const records = parseSpool(
      [
        pendingLine(RAW_RUN, "run_in_terminal", { command: "ls" }, "sessA"),
        pendingLine(
          RAW_QUESTION,
          "vscode_askQuestions",
          questionInput,
          "sessB",
        ),
      ].join("\n"),
    );
    expect(computePendingBlockers(records, "sessA")).toHaveLength(1);
    expect(computePendingBlockers(records, "sessB")).toHaveLength(1);
    expect(computePendingBlockers(records, "sessA")[0]?.toolName).toBe(
      "run_in_terminal",
    );
  });
});

describe("buildSpoolRecord", () => {
  const stdin = {
    session_id: "471f445d",
    tool_use_id: RAW_RUN,
    tool_name: "run_in_terminal",
    tool_input: { command: "ls" },
  };

  it("maps PreToolUse to a pending record carrying input", () => {
    const rec = buildSpoolRecord(
      "PreToolUse",
      stdin,
      "2026-07-09T12:00:00.000Z",
    );
    expect(rec).toMatchObject({
      phase: "pending",
      sessionId: "471f445d",
      toolCallId: RAW_RUN,
      toolName: "run_in_terminal",
      input: { command: "ls" },
    });
  });

  it("maps PostToolUse to a resolved record", () => {
    const rec = buildSpoolRecord(
      "PostToolUse",
      stdin,
      "2026-07-09T12:00:00.000Z",
    );
    expect(rec).toMatchObject({ phase: "resolved", toolCallId: RAW_RUN });
    expect((rec as { input?: unknown }).input).toBeUndefined();
  });

  it("returns undefined when routing keys are missing", () => {
    expect(
      buildSpoolRecord("PreToolUse", { tool_name: "x" }, "t"),
    ).toBeUndefined();
  });

  it("returns undefined for events we do not notify on", () => {
    expect(buildSpoolRecord("Stop", stdin, "t")).toBeUndefined();
  });
});

describe("SpoolFollower", () => {
  it("emits a snapshot, then clears on resolved and on transcript catch-up", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-spool-"));
    const spoolFile = path.join(dir, "spool.jsonl");
    const transcriptFile = path.join(dir, "sessA.jsonl");
    await fs.writeFile(
      spoolFile,
      pendingLine(RAW_QUESTION, "vscode_askQuestions", questionInput) + "\n",
    );
    await fs.writeFile(transcriptFile, "");

    const snapshots: number[] = [];
    const follower = new SpoolFollower(
      spoolFile,
      transcriptFile,
      "sessA",
      (blockers) => snapshots.push(blockers.length),
      { pollIntervalMs: 0 },
    );
    try {
      await follower.start();
      expect(snapshots.at(-1)).toBe(1); // one pending question

      // resolved line clears it
      await fs.appendFile(spoolFile, resolvedLine(RAW_QUESTION) + "\n");
      await follower.refresh();
      expect(snapshots.at(-1)).toBe(0);
    } finally {
      follower.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not re-emit an unchanged snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-spool-"));
    const spoolFile = path.join(dir, "spool.jsonl");
    const transcriptFile = path.join(dir, "sessA.jsonl");
    await fs.writeFile(
      spoolFile,
      pendingLine(RAW_RUN, "run_in_terminal", { command: "ls" }) + "\n",
    );
    await fs.writeFile(transcriptFile, "");

    let emits = 0;
    const follower = new SpoolFollower(
      spoolFile,
      transcriptFile,
      "sessA",
      () => (emits += 1),
      { pollIntervalMs: 0 },
    );
    try {
      await follower.start();
      await follower.refresh();
      await follower.refresh();
      expect(emits).toBe(1); // only the initial change
    } finally {
      follower.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
