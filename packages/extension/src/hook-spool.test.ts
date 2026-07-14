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
  isRetired,
  isSuperseded,
  newestTurnTs,
  spoolRecordFor,
  eventToolCallId,
  buildHookConfig,
  defaultSpoolDir,
  stableHookPath,
  hookConfigPath,
  SpoolFollower,
  localChatSessionUri,
  buildCarouselAnswers,
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

describe("localChatSessionUri", () => {
  it("is vscode-chat-session scheme + local authority + unpadded base64url", () => {
    expect(localChatSessionUri("abc")).toBe("vscode-chat-session://local/YWJj");
  });

  it("uses UNPADDED url-safe base64 (matches LocalChatSessionUri.forSession)", () => {
    const uri = localChatSessionUri("hi");
    expect(uri).toBe("vscode-chat-session://local/aGk");
    expect(uri).not.toContain("=");
  });
});

describe("spoolRecordSchema", () => {
  it("parses a spool record", () => {
    expect(
      spoolRecordSchema.parse(
        rec(RAW_RUN, "run_in_terminal", { command: "ls" }),
      ).toolName,
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

describe("isRetired", () => {
  it("is true iff the record's base toolCallId is in the transcript", () => {
    const record = rec(RAW_QUESTION, "vscode_askQuestions", questionInput);
    expect(isRetired(record, new Set([BASE_QUESTION]))).toBe(true);
    expect(isRetired(record, new Set())).toBe(false);
    expect(isRetired(record, new Set([BASE_RUN]))).toBe(false);
  });
});

describe("newestTurnTs", () => {
  it("returns the max timestamp over user.message + assistant.turn_start (robust to out-of-order)", () => {
    const content = [
      JSON.stringify({
        type: "assistant.turn_start",
        timestamp: "2026-07-09T11:30:00.000Z",
      }),
      JSON.stringify({
        type: "user.message",
        timestamp: "2026-07-09T12:00:00.000Z",
        data: { content: "hi" },
      }),
      // an out-of-order OLDER event must not lower the max
      JSON.stringify({
        type: "assistant.turn_start",
        timestamp: "2026-07-09T09:00:00.000Z",
      }),
      // a sibling tool completing is NOT a new turn -> ignored
      JSON.stringify({
        type: "tool.execution_complete",
        timestamp: "2026-07-09T13:00:00.000Z",
        data: { toolCallId: BASE_RUN },
      }),
    ].join("\n");
    expect(newestTurnTs(content)).toBe("2026-07-09T12:00:00.000Z");
  });

  it("returns undefined when there are no turn-boundary events", () => {
    expect(newestTurnTs("")).toBeUndefined();
    expect(
      newestTurnTs(
        JSON.stringify({
          type: "tool.execution_start",
          timestamp: "2026-07-09T12:00:00.000Z",
          data: { toolCallId: BASE_RUN },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("isSuperseded", () => {
  // rec()'s default ts is 2026-07-09T11:30:25.455Z.
  const record = rec(RAW_RUN, "run_in_terminal", { command: "ls" });
  it("is true when a later turn started after the blocker was recorded", () => {
    expect(isSuperseded(record, "2026-07-09T11:30:26.000Z")).toBe(true);
  });
  it("is false for a live blocker (newest turn is older; the transcript lags the in-flight turn)", () => {
    expect(isSuperseded(record, "2026-07-09T11:30:25.000Z")).toBe(false);
  });
  it("is false when there is no turn activity at all", () => {
    expect(isSuperseded(record, undefined)).toBe(false);
  });
});

describe("computePendingBlockers supersede", () => {
  it("drops a record the session has advanced past (later turn), keeps a live one", () => {
    const live = rec(RAW_QUESTION, "vscode_askQuestions", questionInput); // ts 11:30:25.455Z
    const orphan = rec(RAW_RUN, "run_in_terminal", { command: "ls" }); // ts 11:30:25.455Z
    // A later turn than the orphan/live ts -> both are superseded.
    const later = computePendingBlockers(
      [live, orphan],
      "sessA",
      new Set(),
      "2026-07-09T11:31:00.000Z",
    );
    expect(later).toHaveLength(0);
    // An EARLIER turn ts (transcript lags) -> nothing superseded.
    const earlier = computePendingBlockers(
      [live, orphan],
      "sessA",
      new Set(),
      "2026-07-09T11:30:00.000Z",
    );
    expect(earlier).toHaveLength(2);
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
      await writeRecord(
        dir,
        rec(RAW_RUN, "run_in_terminal", { command: "ls" }),
      );
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

describe("spoolRecordFor / eventToolCallId", () => {
  it("builds an interactive tool as a QUESTION (no awaitingDecision)", () => {
    const r = spoolRecordFor(
      {
        session_id: "471f445d",
        tool_use_id: RAW_QUESTION,
        tool_name: "vscode_askQuestions",
        tool_input: { questions: [] },
      },
      "2026-07-09T12:00:00.000Z",
    );
    expect(r).toMatchObject({
      sessionId: "471f445d",
      toolCallId: BASE_QUESTION,
      toolName: "vscode_askQuestions",
      input: { questions: [] },
      resolveId: RAW_QUESTION,
    });
    expect(r?.awaitingDecision).toBeUndefined();
  });

  it("builds a non-interactive tool as an APPROVAL (awaitingDecision)", () => {
    const r = spoolRecordFor(
      {
        session_id: "s",
        tool_use_id: RAW_RUN,
        tool_name: "run_in_terminal",
        tool_input: { command: "ls" },
      },
      "2026-07-09T12:00:00.000Z",
    );
    expect(r?.toolCallId).toBe(BASE_RUN);
    expect(r?.awaitingDecision).toBe(true);
    expect(r?.resolveId).toBe(RAW_RUN);
  });

  it("returns undefined when routing keys are missing", () => {
    expect(
      spoolRecordFor({ tool_name: "vscode_askQuestions" }, "t"),
    ).toBeUndefined();
  });

  it("resolves the base toolCallId for the delete path (any tool)", () => {
    expect(
      eventToolCallId({ tool_use_id: RAW_RUN, tool_name: "run_in_terminal" }),
    ).toBe(BASE_RUN);
    expect(eventToolCallId({})).toBeUndefined();
  });
});

describe("buildHookConfig", () => {
  it("uses absolute runtime + hook, and passes an OVERRIDE spool via env", () => {
    const cfg = buildHookConfig({
      runtime: "/usr/local/bin/node",
      hookBin: "/ext/dist/hook.cjs",
      spoolDir: "/store/spool",
    }) as {
      hooks: Record<
        string,
        Array<{ command: string; env?: Record<string, string> }>
      >;
    };
    const pre = cfg.hooks["PreToolUse"]?.[0];
    expect(pre?.command).toBe(
      '"/usr/local/bin/node" "/ext/dist/hook.cjs" PreToolUse',
    );
    expect(pre?.env?.["CLOAKCODE_SPOOL"]).toBe("/store/spool");
    expect(cfg.hooks["PostToolUse"]?.[0]?.command).toContain("PostToolUse");
  });

  it("omits the spool env for the standard location (hook derives it itself)", () => {
    const cfg = buildHookConfig({
      runtime: "/usr/local/bin/node",
      hookBin: "/ext/dist/hook.cjs",
      spoolDir: defaultSpoolDir(),
    }) as { hooks: Record<string, Array<{ env?: unknown }>> };
    expect(cfg.hooks["PreToolUse"]?.[0]?.env).toBeUndefined();
  });

  it("gives both hook events a short timeout (the hook never blocks)", () => {
    const cfg = buildHookConfig({
      runtime: "/usr/local/bin/node",
      hookBin: "/ext/dist/hook.cjs",
      spoolDir: defaultSpoolDir(),
    }) as { hooks: Record<string, Array<{ timeout?: number }>> };
    expect(cfg.hooks["PreToolUse"]?.[0]?.timeout).toBe(30);
    expect(cfg.hooks["PostToolUse"]?.[0]?.timeout).toBe(30);
  });
});

describe("hook paths", () => {
  it("puts the stable hook copy under ~/.cloakcode (survives uninstall)", () => {
    expect(stableHookPath()).toBe(
      path.join(os.homedir(), ".cloakcode", "hook.cjs"),
    );
    // Shares the per-env dir with the spool so a whole `~/.cloakcode` wipe cleans both.
    expect(path.dirname(stableHookPath())).toBe(
      path.dirname(defaultSpoolDir()),
    );
  });

  it("puts the user-global config under ~/.copilot/hooks", () => {
    expect(hookConfigPath()).toBe(
      path.join(os.homedir(), ".copilot", "hooks", "cloakcode.json"),
    );
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

  it("delivers a pre-existing blocker to a LATE subscriber (initial snapshot on start)", async () => {
    const { base, spoolDir, transcriptFile } = await setup();
    // The question fired (hook wrote the record) BEFORE the phone subscribed —
    // the phone was not open at the time. Opening the session must still show it.
    await writeRecord(
      spoolDir,
      rec(RAW_QUESTION, "vscode_askQuestions", questionInput),
    );
    await fs.writeFile(transcriptFile, "");
    const snapshots: Array<Array<{ toolCallId: string }>> = [];
    const follower = new SpoolFollower(
      spoolDir,
      transcriptFile,
      "sessA",
      (b) => snapshots.push(b),
      { pollIntervalMs: 0 },
    );
    try {
      await follower.start();
      // start() emits the CURRENT pending state immediately (no fs event needed).
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.[0]?.toolCallId).toBe(BASE_QUESTION);
    } finally {
      follower.stop();
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it("self-heals: transcript catch-up clears AND unlinks a lingering file", async () => {
    const { base, spoolDir, transcriptFile } = await setup();
    await writeRecord(
      spoolDir,
      rec(RAW_RUN, "run_in_terminal", { command: "ls" }),
    );
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
      // Tool completed (its id lands in the transcript) but PostToolUse never
      // deleted the spool file — the follower must retire AND remove it.
      await fs.writeFile(
        transcriptFile,
        JSON.stringify({
          type: "tool.execution_start",
          data: { toolCallId: BASE_RUN },
        }),
      );
      await follower.refresh();
      expect(snapshots.at(-1)).toBe(0);
      expect(await fs.readdir(spoolDir)).toHaveLength(0);
    } finally {
      follower.stop();
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it("does not re-emit an unchanged snapshot", async () => {
    const { base, spoolDir, transcriptFile } = await setup();
    await writeRecord(
      spoolDir,
      rec(RAW_RUN, "run_in_terminal", { command: "ls" }),
    );
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

  it("debounce: hides a fresh record until it matures, then surfaces it", async () => {
    const { base, spoolDir, transcriptFile } = await setup();
    let clock = Date.parse("2026-07-09T12:00:00.000Z");
    await writeRecord(
      spoolDir,
      rec(
        RAW_RUN,
        "run_in_terminal",
        { command: "ls" },
        "sessA",
        new Date(clock).toISOString(),
      ),
    );
    await fs.writeFile(transcriptFile, "");
    const sizes: number[] = [];
    const follower = new SpoolFollower(
      spoolDir,
      transcriptFile,
      "sessA",
      (b) => sizes.push(b.length),
      { pollIntervalMs: 0, debounceMs: 1000, now: () => clock },
    );
    try {
      await follower.start();
      expect(sizes.at(-1)).toBe(0);
      clock += 1000;
      await follower.refresh();
      expect(sizes.at(-1)).toBe(1);
    } finally {
      follower.stop();
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it("debounce: a fast auto-approved call is retired before it ever surfaces", async () => {
    const { base, spoolDir, transcriptFile } = await setup();
    let clock = Date.parse("2026-07-09T12:00:00.000Z");
    await writeRecord(
      spoolDir,
      rec(
        RAW_RUN,
        "run_in_terminal",
        { command: "ls" },
        "sessA",
        new Date(clock).toISOString(),
      ),
    );
    await fs.writeFile(transcriptFile, "");
    const sizes: number[] = [];
    const follower = new SpoolFollower(
      spoolDir,
      transcriptFile,
      "sessA",
      (b) => sizes.push(b.length),
      { pollIntervalMs: 0, debounceMs: 1000, now: () => clock },
    );
    try {
      await follower.start();
      expect(sizes.at(-1)).toBe(0);
      await fs.writeFile(
        transcriptFile,
        JSON.stringify({
          type: "tool.execution_start",
          data: { toolCallId: BASE_RUN },
        }),
      );
      clock += 5000;
      await follower.refresh();
      expect(sizes.at(-1)).toBe(0);
      expect(await fs.readdir(spoolDir)).toHaveLength(0);
    } finally {
      follower.stop();
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe("computePendingBlockers awaitingDecision", () => {
  it("propagates awaitingDecision and the raw input onto the blocker", () => {
    const r: SpoolRecord = {
      sessionId: "sessA",
      toolCallId: BASE_RUN,
      toolName: "run_in_terminal",
      input: { command: "ls" },
      ts: "2026-07-09T00:00:00Z",
      awaitingDecision: true,
      resolveId: RAW_RUN,
    };
    const [b] = computePendingBlockers([r], "sessA");
    expect(b?.awaitingDecision).toBe(true);
    expect(b?.input).toEqual({ command: "ls" });
    expect(b?.resolveId).toBe(RAW_RUN);
  });
});

describe("buildCarouselAnswers", () => {
  it("uses the type-appropriate value shape per question so VS Code renders it", () => {
    const rec = buildCarouselAnswers(RAW_QUESTION, [
      { selected: ["tool-call-demo.txt"], freeText: null },
      { selected: [], freeText: "555" },
      { selected: ["Unit", "E2E"], freeText: null, multiSelect: true },
    ]);
    expect(rec[`${RAW_QUESTION}:0`]).toEqual({
      selectedValue: "tool-call-demo.txt",
    });
    expect(rec[`${RAW_QUESTION}:1`]).toBe("555");
    expect(rec[`${RAW_QUESTION}:2`]).toEqual({
      selectedValues: ["Unit", "E2E"],
    });
  });

  it("uses selectedValues for a multi-select even with a single pick", () => {
    // The [object Object] bug: a multi-select answered with one option must
    // still be delivered as selectedValues, not selectedValue.
    const rec = buildCarouselAnswers(RAW_QUESTION, [
      { selected: ["Integration"], freeText: null, multiSelect: true },
    ]);
    expect(rec[`${RAW_QUESTION}:0`]).toEqual({
      selectedValues: ["Integration"],
    });
  });

  it("delivers a free-text-only answer as a bare string (the [object Object] bug)", () => {
    // A no-options ('text') question renders its answer via String(answer) in
    // VS Code's carousel, so an OBJECT shows "[object Object]". Deliver a string.
    const rec = buildCarouselAnswers(RAW_QUESTION, [
      { selected: [], freeText: "this is from our cloakcode ui" },
    ]);
    expect(rec[`${RAW_QUESTION}:0`]).toBe("this is from our cloakcode ui");
  });
});
