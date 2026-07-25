import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createLogger,
  type LogRecord,
  type SessionEvent,
  type UsageSummary,
} from "@cloakcode/protocol";
import {
  SessionFollower,
  IncrementalTranscriptParser,
  IncrementalDebugLogParser,
  type StreamSource,
  findTranscript,
  findSessionLog,
  parseSessionEvents,
  parseDebugLogEvents,
  stitchEvents,
} from "./session-observer.js";
import { computeInTurnFromDebugLog } from "./scanner.js";

describe("stitchEvents", () => {
  const u = (id: string, text: string): SessionEvent => ({
    type: "append",
    seq: 0,
    part: { kind: "userMessage", id, text },
  });
  const m = (id: string): SessionEvent => ({
    type: "append",
    seq: 0,
    part: { kind: "markdown", id, text: "a" },
  });

  it("returns the debug-log unchanged when it opens at the transcript's start", () => {
    const tx = [u("user-0", "q0"), m("msg-0"), u("user-1", "q1"), m("msg-1")];
    const dl = [u("user-0", "q0"), m("msg-0"), u("user-1", "q1"), m("msg-1")];
    expect(stitchEvents(tx, dl)).toBe(dl);
  });

  it("prepends the transcript's older turns before where the debug-log opens", () => {
    // transcript has 3 turns; the debug-log opens on the last one (q2).
    const tx = [
      u("user-0", "q0"),
      m("msg-0"),
      u("user-1", "q1"),
      m("msg-1"),
      u("user-2", "q2"),
      m("msg-2"),
    ];
    const dl = [u("user-0", "q2"), m("msg-0")]; // opens on q2, re-keyed from 0
    const out = stitchEvents(tx, dl);
    expect(out).toHaveLength(6); // 2 older transcript turns + the debug-log turn
    expect(out.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]); // contiguous
    const ids = out.flatMap((e) => (e.type === "append" ? [e.part.id] : []));
    expect(ids).toEqual([
      "tx-user-0",
      "tx-msg-0",
      "tx-user-1",
      "tx-msg-1",
      "dl-user-0",
      "dl-msg-0",
    ]);
    expect(new Set(ids).size).toBe(ids.length); // no id collisions
  });

  it("uses the debug-log alone when its opening turn isn't in the transcript", () => {
    const tx = [u("user-0", "q0"), m("msg-0")];
    const dl = [u("user-0", "q-new"), m("msg-0")]; // newer than the transcript
    expect(stitchEvents(tx, dl)).toBe(dl);
  });

  it("falls back to the transcript when the debug-log has no turns", () => {
    const tx = [u("user-0", "q0"), m("msg-0")];
    expect(stitchEvents(tx, [])).toBe(tx);
  });

  it("picks the RIGHT boundary when a prompt text repeats (F7)", () => {
    // "A" appears twice in the transcript; the debug-log opens on the SECOND
    // one. Matching only the first text would stitch at the earlier "A" and
    // duplicate/omit history — aligning the sequence [A, q3] fixes it.
    const tx = [
      u("user-0", "q0"),
      m("msg-0"),
      u("user-1", "A"),
      m("msg-1"),
      u("user-2", "q1"),
      m("msg-2"),
      u("user-3", "A"),
      m("msg-3"),
      u("user-4", "q3"),
      m("msg-4"),
    ];
    const dl = [u("user-0", "A"), m("msg-0"), u("user-1", "q3"), m("msg-1")];
    const out = stitchEvents(tx, dl);
    // Prefix = the 6 events before the SECOND "A" (index 6); then the debug-log.
    expect(out).toHaveLength(6 + 4);
    const ids = out.flatMap((e) => (e.type === "append" ? [e.part.id] : []));
    expect(ids.slice(0, 6)).toEqual([
      "tx-user-0",
      "tx-msg-0",
      "tx-user-1",
      "tx-msg-1",
      "tx-user-2",
      "tx-msg-2",
    ]);
    expect(ids.slice(6)).toEqual([
      "dl-user-0",
      "dl-msg-0",
      "dl-user-1",
      "dl-msg-1",
    ]);
  });

  it("stitches at the opening even when LATER turns diverge (rehydration reorder, regression)", () => {
    // The debug-log opens on q2, but its NEXT message (q-x) differs from the
    // transcript's (q3) — VS Code rehydrated the transcript with reordered/retimed
    // turns (docs/06). A full-sequence match would fail and silently DROP all
    // earlier history; aligning on the opening (longest prefix) keeps it.
    const tx = [
      u("user-0", "q0"),
      m("msg-0"),
      u("user-1", "q1"),
      m("msg-1"),
      u("user-2", "q2"),
      m("msg-2"),
      u("user-3", "q3"),
      m("msg-3"),
    ];
    const dl = [u("user-0", "q2"), m("msg-0"), u("user-1", "q-x"), m("msg-1")];
    const out = stitchEvents(tx, dl);
    const ids = out.flatMap((e) => (e.type === "append" ? [e.part.id] : []));
    // Older turns (before q2) are prepended as tx-; the debug-log leads from q2.
    expect(ids.slice(0, 4)).toEqual([
      "tx-user-0",
      "tx-msg-0",
      "tx-user-1",
      "tx-msg-1",
    ]);
    expect(ids.slice(4)).toEqual([
      "dl-user-0",
      "dl-msg-0",
      "dl-user-1",
      "dl-msg-1",
    ]);
    expect(ids.some((i) => i.startsWith("tx-"))).toBe(true); // history preserved ⇒ partial
  });
});

const jsonl = (lines: object[]): string =>
  lines.map((l) => JSON.stringify(l)).join("\n");

describe("parseSessionEvents", () => {
  it("maps user + assistant + tool events onto ordered parts", () => {
    const content = jsonl([
      { type: "session.start", data: {} },
      { type: "user.message", data: { content: "Refactor auth" } },
      {
        type: "assistant.message",
        data: { reasoningText: "planning", content: "Doing it now." },
      },
      {
        type: "tool.execution_start",
        data: {
          toolCallId: "t1",
          toolName: "read_file",
          arguments: { p: "x" },
        },
      },
      {
        type: "tool.execution_complete",
        data: { toolCallId: "t1", success: true },
      },
    ]);

    const events = parseSessionEvents(content);
    // seqs are contiguous indices
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);

    expect(events[0]).toMatchObject({
      type: "append",
      part: { kind: "userMessage", text: "Refactor auth" },
    });
    expect(events[1]).toMatchObject({
      type: "append",
      part: { kind: "thinking", text: "planning" },
    });
    expect(events[2]).toMatchObject({
      type: "append",
      part: { kind: "markdown", text: "Doing it now." },
    });
    expect(events[3]).toMatchObject({
      type: "append",
      part: { kind: "toolCall", name: "read_file", status: "running" },
    });
    expect(events[4]).toMatchObject({ type: "updateStatus", status: "done" });
  });

  it("maps vscode_askQuestions (questions[]) to one confirmation per question, resolved on complete", () => {
    const content = jsonl([
      { type: "user.message", data: { content: "go" } },
      {
        type: "tool.execution_start",
        data: {
          toolCallId: "q1",
          toolName: "vscode_askQuestions",
          arguments: {
            questions: [
              {
                header: "File name",
                question: "Which file name?",
                options: [
                  { label: "a.txt", recommended: true },
                  { label: "b.txt" },
                ],
                allowFreeformInput: true,
              },
              {
                header: "Write mode",
                question: "Overwrite or append?",
                options: [
                  { label: "Overwrite", recommended: true },
                  { label: "Append" },
                ],
              },
            ],
          },
        },
      },
      {
        type: "tool.execution_complete",
        data: { toolCallId: "q1", success: true },
      },
    ]);
    const events = parseSessionEvents(content);

    const first = events[1];
    const second = events[2];
    if (
      first?.type !== "append" ||
      first.part.kind !== "confirmation" ||
      second?.type !== "append" ||
      second.part.kind !== "confirmation"
    ) {
      throw new Error("expected two confirmation appends");
    }
    expect(first.part.prompt).toBe("Which file name?");
    expect(first.part.options).toHaveLength(2);
    expect(first.part.options[0]).toMatchObject({
      label: "a.txt",
      recommended: true,
    });
    expect(first.part.allowFreeform).toBe(true);
    expect(second.part.prompt).toBe("Overwrite or append?");
    // Freeform defaults ON unless explicitly false — the VS Code picker always
    // offers "Enter custom answer" for a question with no allowFreeformInput.
    expect(second.part.allowFreeform).toBe(true);

    // Both confirmations resolve on the single tool.execution_complete.
    expect(events[3]).toMatchObject({ type: "resolve", id: first.part.id });
    expect(events[4]).toMatchObject({ type: "resolve", id: second.part.id });
  });

  it("matches a tool-call complete to its start by toolCallId", () => {
    const start = parseSessionEvents(
      jsonl([
        {
          type: "tool.execution_start",
          data: { toolCallId: "abc", toolName: "run_in_terminal" },
        },
      ]),
    );
    const done = parseSessionEvents(
      jsonl([
        {
          type: "tool.execution_start",
          data: { toolCallId: "abc", toolName: "run_in_terminal" },
        },
        {
          type: "tool.execution_complete",
          data: { toolCallId: "abc", success: false },
        },
      ]),
    );
    const startPart = start[0];
    const statusEvent = done[1];
    if (startPart?.type !== "append" || statusEvent?.type !== "updateStatus") {
      throw new Error("unexpected event shape");
    }
    expect(statusEvent.id).toBe(startPart.part.id);
    expect(statusEvent.status).toBe("error");
  });

  it("produces a stable prefix as the transcript grows", () => {
    const first = jsonl([{ type: "user.message", data: { content: "a" } }]);
    const grown = `${first}\n${JSON.stringify({
      type: "user.message",
      data: { content: "b" },
    })}`;
    const before = parseSessionEvents(first);
    const after = parseSessionEvents(grown);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe("SessionFollower", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0))
      await fs.rm(d, { recursive: true, force: true });
  });

  async function tmpFile(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-follow-"));
    dirs.push(dir);
    const file = path.join(dir, "s.jsonl");
    await fs.writeFile(file, content);
    return file;
  }

  it("emits the full log on start, then only the new tail on refresh", async () => {
    const file = await tmpFile(
      jsonl([{ type: "user.message", data: { content: "one" } }]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e));
    await follower.start();
    expect(seen).toHaveLength(1);

    await fs.appendFile(
      file,
      `\n${JSON.stringify({ type: "user.message", data: { content: "two" } })}`,
    );
    await follower.refresh();
    follower.stop();

    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      type: "append",
      seq: 1,
      part: { kind: "userMessage", text: "two" },
    });
  });

  it("auto-emits appended events via watch/poll (no manual refresh)", async () => {
    const file = await tmpFile(
      jsonl([{ type: "user.message", data: { content: "one" } }]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 0, {
      pollIntervalMs: 20,
    });
    await follower.start();
    expect(seen).toHaveLength(1);

    await fs.appendFile(
      file,
      `\n${JSON.stringify({ type: "user.message", data: { content: "two" } })}`,
    );
    // Do NOT call refresh() — the poll fallback must pick the append up on its own.
    const deadline = Date.now() + 1000;
    while (seen.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    follower.stop();

    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      part: { kind: "userMessage", text: "two" },
    });
  });

  it("resumes from sinceSeq (skips already-seen events)", async () => {
    const file = await tmpFile(
      jsonl([
        { type: "user.message", data: { content: "one" } },
        { type: "user.message", data: { content: "two" } },
      ]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 1);
    await follower.start();
    follower.stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ seq: 1, part: { text: "two" } });
  });

  it("emits only the last `limit` events on the initial load (tail window)", async () => {
    const file = await tmpFile(
      jsonl([
        { type: "user.message", data: { content: "one" } },
        { type: "user.message", data: { content: "two" } },
        { type: "user.message", data: { content: "three" } },
      ]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 0, {
      pollIntervalMs: 0,
      limit: 2,
    });
    await follower.start();
    follower.stop();
    // Only the last 2 of 3 replay; seq stays ABSOLUTE (prefix-stable) so the
    // client can page older via session.history from the first seq it received.
    expect(seen).toHaveLength(2);
    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
    expect(seen[0]).toMatchObject({ part: { text: "two" } });
  });

  it("bounds only the initial load — live events after the tail are not limited", async () => {
    const file = await tmpFile(
      jsonl([
        { type: "user.message", data: { content: "one" } },
        { type: "user.message", data: { content: "two" } },
      ]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 0, {
      limit: 1,
    });
    await follower.start(); // tail = last 1 → "two" (seq 1)
    await fs.appendFile(
      file,
      `\n${JSON.stringify({ type: "user.message", data: { content: "three" } })}`,
    );
    const deadline = Date.now() + 1000;
    while (seen.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    follower.stop();
    expect(seen.map((e) => e.seq)).toEqual([1, 2]); // "two" (tail) + "three" (live)
  });

  it("logs a read failure once (deduped) and surfaces it via onError", async () => {
    const file = await tmpFile(
      jsonl([{ type: "user.message", data: { content: "one" } }]),
    );
    const records: LogRecord[] = [];
    const logger = createLogger({
      sink: (r) => records.push(r),
      level: "debug",
    });
    const errors: { code: string; bytes?: number }[] = [];
    const follower = new SessionFollower(file, () => {}, 0, {
      pollIntervalMs: 0,
      logger,
      onError: (e) => errors.push(e),
    });
    await follower.start();
    const reads = (): LogRecord[] =>
      records.filter((r) => r.event === "follower.read_failed");
    expect(reads()).toHaveLength(0); // a clean read logs nothing

    await fs.rm(file); // now every read throws ENOENT
    await follower.refresh();
    await follower.refresh(); // same code → deduped, still ONE record
    follower.stop();

    expect(reads()).toHaveLength(1);
    expect(reads()[0]!.level).toBe("warn");
    expect(reads()[0]!.fields).toMatchObject({ code: "ENOENT" });
    // The read failure is ALSO surfaced to the client (deduped) so the phone
    // can show a reason instead of a silent blank.
    expect(errors).toEqual([{ code: "ENOENT" }]);
  });

  it("findSessionLog surfaces a non-ENOENT transcript read failure (silent on ENOENT)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-stitch-"));
    dirs.push(root);
    const base = path.join(root, "H", "GitHub.copilot-chat");
    await fs.mkdir(path.join(base, "debug-logs", "sessX"), { recursive: true });
    await fs.writeFile(
      path.join(base, "debug-logs", "sessX", "main.jsonl"),
      "",
    );
    await fs.mkdir(path.join(base, "transcripts"), { recursive: true });
    // A DIRECTORY where the transcript file is expected → readFile throws EISDIR.
    await fs.mkdir(path.join(base, "transcripts", "sessX.jsonl"));

    const records: LogRecord[] = [];
    const logger = createLogger({
      sink: (r) => records.push(r),
      level: "debug",
    });
    const log = await findSessionLog(root, "sessX", logger);
    expect(log?.file).toContain("main.jsonl"); // debug-log still leads
    const fails = records.filter(
      (r) => r.event === "stitch.transcript_read_failed",
    );
    expect(fails).toHaveLength(1);
    expect(fails[0]!.fields).toMatchObject({ code: "EISDIR" });

    // A MISSING transcript (ENOENT) is the normal case and must stay silent.
    await fs.mkdir(path.join(base, "debug-logs", "sessY"), { recursive: true });
    await fs.writeFile(
      path.join(base, "debug-logs", "sessY", "main.jsonl"),
      "",
    );
    records.length = 0;
    await findSessionLog(root, "sessY", logger);
    expect(
      records.filter((r) => r.event === "stitch.transcript_read_failed"),
    ).toHaveLength(0);
  });

  it("streams inTurn transitions via onTurn (open → close, only on change)", async () => {
    const file = await tmpFile(
      jsonl([{ type: "user.message", data: { content: "hi" } }]),
    );
    const turns: boolean[] = [];
    const follower = new SessionFollower(file, () => {}, 0, {
      onTurn: (t) => turns.push(t),
    });
    await follower.start();
    // No open turn in the transcript yet → the authoritative flag is false.
    expect(turns).toEqual([false]);

    // Assistant opens a turn AND does work → mid-turn.
    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "assistant.turn_start",
        data: { turnId: "t1" },
        timestamp: "2026-07-16T00:00:01.000Z",
      })}\n${JSON.stringify({
        type: "assistant.message",
        data: { content: "working" },
      })}`,
    );
    await follower.refresh();
    expect(turns).toEqual([false, true]);

    // A second refresh with no change must NOT re-emit (idempotent).
    await follower.refresh();
    expect(turns).toEqual([false, true]);

    // Turn ends → back to not-in-turn.
    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "assistant.turn_end",
        data: { turnId: "t1" },
      })}`,
    );
    await follower.refresh();
    follower.stop();
    expect(turns).toEqual([false, true, false]);
  });

  it("derives inTurn from a DEBUG-LOG's turn spans via computeTurn", async () => {
    // The debug-log has clean turn_start/turn_end spans; unlike the transcript it
    // does NOT append a placeholder turn_start after turn_end, so a completed
    // turn correctly reads not-in-turn (docs/02.2 convergence).
    const span = (type: string, n: number): string =>
      JSON.stringify({
        ts: 1,
        type,
        name: `${type}:${n}`,
        spanId: `${type}-s-${n}`,
      });
    const file = await tmpFile(span("turn_start", 0));
    const turns: boolean[] = [];
    const follower = new SessionFollower(file, () => {}, 0, {
      parse: () => [],
      computeTurn: computeInTurnFromDebugLog,
      onTurn: (t) => turns.push(t),
    });
    await follower.start();
    expect(turns).toEqual([true]); // an open turn_start

    // Turn closes cleanly — the debug-log ends on turn_end, so inTurn clears.
    await fs.appendFile(file, `\n${span("turn_end", 0)}`);
    await follower.refresh();
    follower.stop();
    expect(turns).toEqual([true, false]);
  });

  it("streams a non-interactive tool call: running append, then updateStatus done on completion", async () => {
    const file = await tmpFile(
      jsonl([{ type: "user.message", data: { content: "go" } }]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e));
    await follower.start();
    expect(seen).toHaveLength(1);

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "tool.execution_start",
        data: {
          toolCallId: "t1",
          toolName: "read_file",
          arguments: { p: "x" },
        },
      })}`,
    );
    await follower.refresh();
    expect(seen[1]).toMatchObject({
      type: "append",
      part: {
        kind: "toolCall",
        id: "tool-t1",
        name: "read_file",
        status: "running",
      },
    });

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: "t1", success: true },
      })}`,
    );
    await follower.refresh();
    follower.stop();
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({
      type: "updateStatus",
      id: "tool-t1",
      status: "done",
    });
  });

  it("marks a failed tool call as error on completion (success:false)", async () => {
    const file = await tmpFile(
      jsonl([
        {
          type: "tool.execution_start",
          data: { toolCallId: "t9", toolName: "run_in_terminal" },
        },
      ]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e));
    await follower.start();
    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: "t9", success: false },
      })}`,
    );
    await follower.refresh();
    follower.stop();
    expect(seen[seen.length - 1]).toMatchObject({
      type: "updateStatus",
      id: "tool-t9",
      status: "error",
    });
  });

  it("streams an interactive blocker: confirmation append, then resolve on completion", async () => {
    const file = await tmpFile(
      jsonl([{ type: "user.message", data: { content: "go" } }]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e));
    await follower.start();

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "tool.execution_start",
        data: {
          toolCallId: "q1",
          toolName: "vscode_askQuestions",
          arguments: {
            questions: [
              {
                question: "Proceed?",
                options: [{ label: "Yes" }, { label: "No" }],
              },
            ],
          },
        },
      })}`,
    );
    await follower.refresh();
    const conf = seen[1];
    if (conf?.type !== "append" || conf.part.kind !== "confirmation") {
      throw new Error("expected a confirmation append");
    }
    expect(conf.part).toMatchObject({
      id: "conf-q1-0",
      prompt: "Proceed?",
      allowFreeform: true,
    });
    expect(conf.part.options).toHaveLength(2);

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: "q1", success: true },
      })}`,
    );
    await follower.refresh();
    follower.stop();
    expect(seen[2]).toMatchObject({ type: "resolve", id: "conf-q1-0" });
  });

  it("streams assistant reasoning + message as thinking then markdown", async () => {
    const file = await tmpFile(
      jsonl([{ type: "user.message", data: { content: "go" } }]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e));
    await follower.start();
    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "assistant.message",
        data: { reasoningText: "planning", content: "On it." },
      })}`,
    );
    await follower.refresh();
    follower.stop();
    expect(seen.slice(1)).toMatchObject([
      { type: "append", part: { kind: "thinking", text: "planning" } },
      { type: "append", part: { kind: "markdown", text: "On it." } },
    ]);
  });

  it("tails a debug-log-format file (spans) via the parse option, emitting usage", async () => {
    const file = await tmpFile(
      jsonl([{ type: "user_message", attrs: { content: "go" } }]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 0, {
      parse: parseDebugLogEvents,
    });
    await follower.start();
    expect(seen[0]).toMatchObject({
      type: "append",
      part: { kind: "userMessage", text: "go" },
    });

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "agent_response",
        attrs: {
          reasoning: "think",
          response: [
            { role: "assistant", parts: [{ type: "text", content: "hello" }] },
          ],
        },
      })}`,
    );
    await follower.refresh();
    expect(seen.slice(1)).toMatchObject([
      { type: "append", part: { kind: "thinking", text: "think" } },
      { type: "append", part: { kind: "markdown", text: "hello" } },
    ]);

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "tool_call",
        spanId: "s1",
        name: "read_file",
        attrs: { args: { p: "x" } },
      })}`,
    );
    await follower.refresh();
    expect(seen[seen.length - 1]).toMatchObject({
      type: "append",
      part: {
        kind: "toolCall",
        id: "tool-s1",
        name: "read_file",
        status: "done",
      },
    });

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "llm_request",
        dur: 1200,
        attrs: {
          model: "gpt-4o",
          inputTokens: 10,
          outputTokens: 20,
          cachedTokens: 2,
          ttft: 300,
          copilotUsageNanoAiu: 5_000_000_000,
        },
      })}`,
    );
    await follower.refresh();
    follower.stop();
    expect(seen[seen.length - 1]).toMatchObject({
      type: "append",
      part: {
        kind: "usage",
        model: "gpt-4o",
        inputTokens: 10,
        outputTokens: 20,
        cachedTokens: 2,
        ttftMs: 300,
        durationMs: 1200,
        nanoAiu: 5_000_000_000,
      },
    });
  });

  it("tails through the real stitched closure (transcript history + debug-log lead)", async () => {
    // Mirrors findSessionLog's closure: history from the transcript, the
    // debug-log leads from where it opens; the debug-log file is what's tailed.
    const history = parseSessionEvents(
      jsonl([
        { type: "user.message", data: { content: "q0" } },
        { type: "assistant.message", data: { content: "a0" } },
        { type: "user.message", data: { content: "q1" } },
        { type: "assistant.message", data: { content: "a1" } },
      ]),
    );
    const file = await tmpFile(
      jsonl([{ type: "user_message", attrs: { content: "q1" } }]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 0, {
      parse: (c) => stitchEvents(history, parseDebugLogEvents(c)),
    });
    await follower.start();
    // Older transcript turn (q0/a0) prepended as tx-, then the debug-log opens (dl-).
    expect(
      seen.flatMap((e) => (e.type === "append" ? [e.part.id] : [])),
    ).toEqual(["tx-user-0", "tx-msg-0", "dl-user-0"]);

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "agent_response",
        attrs: {
          response: [
            {
              role: "assistant",
              parts: [{ type: "text", content: "a1-live" }],
            },
          ],
        },
      })}`,
    );
    await follower.refresh();
    follower.stop();
    // Only the NEW debug-log tail is emitted, keyed dl-, seq contiguous.
    expect(seen[seen.length - 1]).toMatchObject({
      type: "append",
      part: { kind: "markdown", id: "dl-msg-0", text: "a1-live" },
    });
    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("skips blank and malformed lines while tailing", async () => {
    const one = JSON.stringify({
      type: "user.message",
      data: { content: "one" },
    });
    const two = JSON.stringify({
      type: "user.message",
      data: { content: "two" },
    });
    const file = await tmpFile(`${one}\n\n{ not json ]\n${two}`);
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e));
    await follower.start();
    expect(
      seen.map((e) =>
        e.type === "append" && e.part.kind === "userMessage"
          ? e.part.text
          : null,
      ),
    ).toEqual(["one", "two"]);

    const three = JSON.stringify({
      type: "user.message",
      data: { content: "three" },
    });
    await fs.appendFile(file, `\n   \n{bad\n${three}`);
    await follower.refresh();
    follower.stop();
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({
      type: "append",
      part: { kind: "userMessage", text: "three" },
    });
  });
});

describe("SessionFollower streaming (stream source)", () => {
  // The offset-streaming path (docs/02.6 §4.32): the follower tails by BYTE
  // OFFSET through a live IncrementalParser instead of re-reading the whole file
  // each poll — fixing the >512 MiB ERR_STRING_TOO_LONG crash (§4.31). These
  // tests prove the streamed output is BYTE-IDENTICAL to the whole-read `parse`
  // path (the 0-regression gate), so `seq === index` stays prefix-stable. Real
  // Copilot logs are newline-TERMINATED (verified: last byte 0x0a) and the byte
  // tail emits only COMPLETE lines, so every fixture terminates too — matching
  // production, where a half-written trailing record is (correctly) not emitted
  // until its newline lands.
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0))
      await fs.rm(d, { recursive: true, force: true });
  });
  /** Append one newline-TERMINATED record, as Copilot's writers do. */
  const rec = (obj: object): string => `${JSON.stringify(obj)}\n`;
  /** Raw stream source (no prepend) — a lone/aligned log's common case. */
  const txStream = (): StreamSource => ({
    makeParser: () => new IncrementalTranscriptParser(),
    prefix: [],
  });
  const dlStream = (): StreamSource => ({
    makeParser: () => new IncrementalDebugLogParser(),
    prefix: [],
  });
  async function tmpFile(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-stream-"));
    dirs.push(dir);
    const file = path.join(dir, "s.jsonl");
    // Terminate the fixture so the tail emits its last record (production format).
    await fs.writeFile(
      file,
      content && !content.endsWith("\n") ? `${content}\n` : content,
    );
    return file;
  }

  const sample = jsonl([
    { type: "session.start", data: {} },
    { type: "user.message", data: { content: "one" } },
    {
      type: "assistant.message",
      data: { reasoningText: "plan", content: "hi" },
    },
    {
      type: "tool.execution_start",
      data: { toolCallId: "t1", toolName: "read_file", arguments: { p: "x" } },
    },
    {
      type: "tool.execution_complete",
      data: { toolCallId: "t1", success: true },
    },
    { type: "user.message", data: { content: "two" } },
  ]);

  it("initial load: streamed events are byte-identical to a whole-file parse", async () => {
    const file = await tmpFile(sample);
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 0, {
      pollIntervalMs: 0,
      stream: txStream(),
    });
    await follower.start();
    follower.stop();
    expect(seen).toEqual(parseSessionEvents(sample));
  });

  it("streamed output equals the whole-read follower's, event for event", async () => {
    // Strongest 0-regression proof: same content + same append, two follower
    // modes, identical emitted stream (values AND seq).
    const file1 = await tmpFile(sample);
    const file2 = await tmpFile(sample);
    const whole: SessionEvent[] = [];
    const stream: SessionEvent[] = [];
    const fWhole = new SessionFollower(file1, (e) => whole.push(e), 0, {
      pollIntervalMs: 0,
      parse: parseSessionEvents,
    });
    const fStream = new SessionFollower(file2, (e) => stream.push(e), 0, {
      pollIntervalMs: 0,
      stream: txStream(),
    });
    await fWhole.start();
    await fStream.start();
    const append = rec({ type: "user.message", data: { content: "three" } });
    await fs.appendFile(file1, append);
    await fs.appendFile(file2, append);
    await fWhole.refresh();
    await fStream.refresh();
    fWhole.stop();
    fStream.stop();
    expect(stream).toEqual(whole);
    expect(stream.map((e) => e.seq)).toEqual(whole.map((e) => e.seq));
  });

  it("append across a refresh keeps seq contiguous (matches whole parse of the grown file)", async () => {
    const file = await tmpFile(sample);
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 0, {
      pollIntervalMs: 0,
      stream: txStream(),
    });
    await follower.start();
    const before = seen.length;
    await fs.appendFile(
      file,
      rec({ type: "user.message", data: { content: "three" } }),
    );
    await follower.refresh();
    follower.stop();
    expect(seen.length).toBeGreaterThan(before);
    expect(seen).toEqual(parseSessionEvents(await fs.readFile(file, "utf8")));
  });

  it("resumes from sinceSeq (skips already-seen events)", async () => {
    const file = await tmpFile(sample);
    const all = parseSessionEvents(sample);
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 3, {
      pollIntervalMs: 0,
      stream: txStream(),
    });
    await follower.start();
    follower.stop();
    expect(seen).toEqual(all.slice(3));
    expect(seen[0]!.seq).toBe(3);
  });

  it("tail window: emits only the last `limit` events on initial load, seq absolute", async () => {
    const file = await tmpFile(sample);
    const all = parseSessionEvents(sample);
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 0, {
      pollIntervalMs: 0,
      limit: 2,
      stream: txStream(),
    });
    await follower.start();
    follower.stop();
    expect(seen).toEqual(all.slice(all.length - 2));
    expect(seen.map((e) => e.seq)).toEqual([all.length - 2, all.length - 1]);
  });

  it("re-streams from the start after a shrink/rotation (reset)", async () => {
    const file = await tmpFile(sample);
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 0, {
      pollIntervalMs: 0,
      stream: txStream(),
    });
    await follower.start();
    const initial = seen.length;
    // The 581→85 MB recycle: replace with a SHORTER file. The offset now points
    // past EOF → TailReader resets → the parser rebuilds and re-streams from 0.
    const recycled = jsonl([
      { type: "user.message", data: { content: "fresh" } },
    ]);
    await fs.writeFile(file, `${recycled}\n`);
    await follower.refresh();
    follower.stop();
    expect(seen.slice(initial)).toEqual(parseSessionEvents(recycled));
    expect(seen[initial]!.seq).toBe(0);
  });

  it("derives inTurn from a tailed debug-log's turn spans (bounded tail-read)", async () => {
    const span = (type: string, n: number): string =>
      JSON.stringify({
        ts: 1,
        type,
        name: `${type}:${n}`,
        spanId: `${type}-s-${n}`,
      });
    const file = await tmpFile(span("turn_start", 0));
    const turns: boolean[] = [];
    const follower = new SessionFollower(file, () => {}, 0, {
      pollIntervalMs: 0,
      stream: dlStream(),
      computeTurn: computeInTurnFromDebugLog,
      onTurn: (t) => turns.push(t),
    });
    await follower.start();
    expect(turns).toEqual([true]); // an open turn_start
    await fs.appendFile(file, `${span("turn_end", 0)}\n`);
    await follower.refresh();
    follower.stop();
    expect(turns).toEqual([true, false]); // closed cleanly
  });

  it("streams an interactive blocker: confirmation append, then resolve across a refresh", async () => {
    const file = await tmpFile(
      jsonl([{ type: "user.message", data: { content: "go" } }]),
    );
    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 0, {
      pollIntervalMs: 0,
      stream: txStream(),
    });
    await follower.start();
    await fs.appendFile(
      file,
      rec({
        type: "tool.execution_start",
        data: {
          toolCallId: "q1",
          toolName: "vscode_askQuestions",
          arguments: {
            questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
          },
        },
      }),
    );
    await follower.refresh();
    await fs.appendFile(
      file,
      rec({
        type: "tool.execution_complete",
        data: { toolCallId: "q1", success: true },
      }),
    );
    await follower.refresh();
    follower.stop();
    // Interactive state (the open toolCallId → confirmation ids) is carried
    // across refreshes by the ONE parser, so the resolve matches.
    expect(
      seen.map((e) => (e.type === "append" ? e.part.kind : e.type)),
    ).toEqual(["userMessage", "confirmation", "resolve"]);
    expect(seen[seen.length - 1]).toMatchObject({
      type: "resolve",
      id: "conf-q1-0",
    });
  });
});

describe("findSessionLog streaming resolution", () => {
  // A log at/over the threshold resolves with a `stream` source, so the follower
  // tails it by byte offset instead of reading it whole; a huge debug-log that
  // opens partway into the session STILL gets the transcript prepend (docs/02.6
  // §4.32).
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0))
      await fs.rm(d, { recursive: true, force: true });
  });
  async function makeEnv(
    sessionId: string,
    files: { debug?: string; transcript?: string },
  ): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-resolve-"));
    dirs.push(root);
    const base = path.join(root, "H", "GitHub.copilot-chat");
    if (files.debug !== undefined) {
      await fs.mkdir(path.join(base, "debug-logs", sessionId), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(base, "debug-logs", sessionId, "main.jsonl"),
        files.debug,
      );
    }
    if (files.transcript !== undefined) {
      await fs.mkdir(path.join(base, "transcripts"), { recursive: true });
      await fs.writeFile(
        path.join(base, "transcripts", `${sessionId}.jsonl`),
        files.transcript,
      );
    }
    return root;
  }

  it("resolves a debug-log at/over the threshold with a stream source (else whole-read)", async () => {
    const root = await makeEnv("sessS", {
      debug: `${jsonl([{ type: "user_message", attrs: { content: "go" } }])}\n`,
    });
    // Over the (tiny) threshold → streaming. No transcript → raw (no prepend).
    const streamed = await findSessionLog(root, "sessS", undefined, 1);
    expect(streamed?.stream?.makeParser).toBeTypeOf("function");
    expect(streamed?.stream?.prefix).toEqual([]);
    // Under the (default) threshold → whole-read, no stream.
    const whole = await findSessionLog(root, "sessS");
    expect(whole?.stream).toBeUndefined();
  });

  it("a follower from the streamed debug-log emits the whole-read stitch, byte-identical", async () => {
    // The debug-log opens at the transcript's start → boundary 0 → the stitch
    // returns it RAW, which is exactly what the raw stream emits.
    const transcript = `${jsonl([
      { type: "user.message", data: { content: "q0" } },
      { type: "assistant.message", data: { content: "a0" } },
    ])}\n`;
    const debug = `${jsonl([
      { type: "user_message", attrs: { content: "q0" } },
      {
        type: "agent_response",
        attrs: {
          response: [
            { role: "assistant", parts: [{ type: "text", content: "a0" }] },
          ],
        },
      },
    ])}\n`;
    const root = await makeEnv("sessE", { debug, transcript });

    const streamLog = await findSessionLog(root, "sessE", undefined, 1);
    const wholeLog = await findSessionLog(root, "sessE"); // whole-read stitch
    expect(streamLog?.stream?.makeParser).toBeTypeOf("function");

    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(
      streamLog!.file,
      (e) => seen.push(e),
      0,
      {
        pollIntervalMs: 0,
        parse: streamLog!.parse,
        ...(streamLog!.stream ? { stream: streamLog!.stream } : {}),
      },
    );
    await follower.start();
    follower.stop();

    const wholeContent = await fs.readFile(wholeLog!.file, "utf8");
    expect(seen).toEqual(wholeLog!.parse(wholeContent));
  });

  it("PREPENDS the transcript when a (huge) debug-log opens partway (post-recycle)", async () => {
    // The debug-log RECYCLED: it opens at the 2nd turn (q1), missing q0 — which is
    // still in the transcript. Size forces streaming; the head-peek seam finds
    // boundary > 0, so the older turn is prepended (tx-) and the lead retagged dl-.
    // This is the case the size-only gate got WRONG: huge does NOT imply raw.
    const transcript = `${jsonl([
      { type: "user.message", data: { content: "q0" } },
      { type: "assistant.message", data: { content: "a0" } },
      { type: "user.message", data: { content: "q1" } },
      { type: "assistant.message", data: { content: "a1" } },
    ])}\n`;
    const debug = `${jsonl([
      { type: "user_message", attrs: { content: "q1" } },
      {
        type: "agent_response",
        attrs: {
          response: [
            { role: "assistant", parts: [{ type: "text", content: "a1" }] },
          ],
        },
      },
    ])}\n`;
    const root = await makeEnv("sessP", { debug, transcript });

    const streamLog = await findSessionLog(root, "sessP", undefined, 1);
    // The seam prepends q0/a0 (tx-) and retags the debug-log lead dl-.
    expect(streamLog?.stream?.retagTag).toBe("dl-");
    expect(
      streamLog?.stream?.prefix.flatMap((e) =>
        e.type === "append" ? [e.part.id] : [],
      ),
    ).toEqual(["tx-user-0", "tx-msg-0"]);

    const seen: SessionEvent[] = [];
    const follower = new SessionFollower(
      streamLog!.file,
      (e) => seen.push(e),
      0,
      {
        pollIntervalMs: 0,
        parse: streamLog!.parse,
        ...(streamLog!.stream ? { stream: streamLog!.stream } : {}),
      },
    );
    await follower.start();
    follower.stop();

    // Byte-identical to the whole-read stitch (the prepend path).
    const wholeLog = await findSessionLog(root, "sessP");
    const wholeContent = await fs.readFile(wholeLog!.file, "utf8");
    expect(seen).toEqual(wholeLog!.parse(wholeContent));
    // Concretely: tx- prefix (q0/a0) then dl- lead (q1/a1), seq contiguous.
    expect(
      seen.flatMap((e) => (e.type === "append" ? [e.part.id] : [])),
    ).toEqual(["tx-user-0", "tx-msg-0", "dl-user-0", "dl-msg-0"]);
    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("resolves a transcript FALLBACK at/over the threshold with a stream source", async () => {
    // No debug-log → the transcript is the source; over the threshold it streams
    // raw (a lone transcript has no prepend).
    const root = await makeEnv("sessT", {
      transcript: `${jsonl([{ type: "user.message", data: { content: "hi" } }])}\n`,
    });
    const streamed = await findSessionLog(root, "sessT", undefined, 1);
    expect(streamed?.file).toContain("sessT.jsonl");
    expect(streamed?.stream?.makeParser).toBeTypeOf("function");
    expect(streamed?.stream?.prefix).toEqual([]);
    const whole = await findSessionLog(root, "sessT");
    expect(whole?.stream).toBeUndefined();
  });
});

describe("SessionFollower usage aggregation", () => {
  // The session usage TOTAL is computed SERVER-SIDE over the WHOLE log and sent
  // via onUsage (docs/02.6 §4.32) — so the client shows correct tokens/AIU/req
  // even under the tail window, which a client-side sum would undercount.
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0))
      await fs.rm(d, { recursive: true, force: true });
  });
  async function tmpFile(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-usage-"));
    dirs.push(dir);
    const file = path.join(dir, "s.jsonl");
    await fs.writeFile(file, content);
    return file;
  }
  /** A debug-log `llm_request` span (the source of a `usage` part). */
  const req = (over: Record<string, unknown>): object => ({
    type: "llm_request",
    dur: 1000,
    attrs: {
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 0,
      ...over,
    },
  });

  it("emits the session usage TOTAL over the whole log via onUsage", async () => {
    const file = await tmpFile(
      jsonl([
        { type: "user_message", attrs: { content: "go" } },
        req({ copilotUsageNanoAiu: 1_500_000_000 }),
        req({
          model: "gpt-5",
          inputTokens: 200,
          copilotUsageNanoAiu: 500_000_000,
        }),
      ]),
    );
    const totals: UsageSummary[] = [];
    const follower = new SessionFollower(file, () => {}, 0, {
      pollIntervalMs: 0,
      parse: parseDebugLogEvents,
      onUsage: (u) => totals.push(u),
    });
    await follower.start();
    follower.stop();
    const last = totals.at(-1)!;
    expect(last.requests).toBe(2);
    expect(last.inputTokens).toBe(300);
    expect(last.outputTokens).toBe(40);
    expect(last.aiu).toBeCloseTo(2, 5);
    expect(last.models).toEqual(["gpt-4o", "gpt-5"]);
    expect(last.partial).toBe(false);
  });

  it("counts the WHOLE log even when the tail `limit` clamps what is emitted (the fix)", async () => {
    // Two requests; limit=1 emits only the last event, but the total must still
    // cover BOTH — the client-side sum used to undercount here (docs/02.6 §4.32).
    const file = await tmpFile(
      jsonl([
        { type: "user_message", attrs: { content: "go" } },
        req({ copilotUsageNanoAiu: 1_000_000_000 }),
        req({ copilotUsageNanoAiu: 1_000_000_000 }),
      ]),
    );
    const seen: SessionEvent[] = [];
    const totals: UsageSummary[] = [];
    const follower = new SessionFollower(file, (e) => seen.push(e), 0, {
      pollIntervalMs: 0,
      limit: 1,
      parse: parseDebugLogEvents,
      onUsage: (u) => totals.push(u),
    });
    await follower.start();
    follower.stop();
    // The emitted tail is clamped small…
    expect(seen.length).toBeLessThan(4);
    // …but the usage total counts BOTH requests.
    expect(totals.at(-1)!.requests).toBe(2);
    expect(totals.at(-1)!.aiu).toBeCloseTo(2, 5);
  });

  it("re-emits the updated total when a new request arrives (live)", async () => {
    const file = await tmpFile(
      jsonl([
        { type: "user_message", attrs: { content: "go" } },
        req({ copilotUsageNanoAiu: 1_000_000_000 }),
      ]),
    );
    const totals: UsageSummary[] = [];
    const follower = new SessionFollower(file, () => {}, 0, {
      pollIntervalMs: 0,
      parse: parseDebugLogEvents,
      onUsage: (u) => totals.push(u),
    });
    await follower.start();
    expect(totals.at(-1)!.requests).toBe(1);
    await fs.appendFile(
      file,
      `\n${JSON.stringify(req({ copilotUsageNanoAiu: 1_000_000_000 }))}`,
    );
    await follower.refresh();
    follower.stop();
    expect(totals.at(-1)!.requests).toBe(2);
  });

  it("re-folds the total from scratch when the whole-read log is truncated/recycled", async () => {
    // Keep-adding must not linger or double-count across a shrink: two requests →
    // start (total 2) → the log recycles to ONE request → the total re-folds to 1,
    // not stays 2 or doubles to 3 (docs/02.6 §4.32).
    const file = await tmpFile(
      jsonl([
        { type: "user_message", attrs: { content: "go" } },
        req({ copilotUsageNanoAiu: 1_000_000_000 }),
        req({ copilotUsageNanoAiu: 1_000_000_000 }),
      ]),
    );
    const totals: UsageSummary[] = [];
    const follower = new SessionFollower(file, () => {}, 0, {
      pollIntervalMs: 0,
      parse: parseDebugLogEvents,
      onUsage: (u) => totals.push(u),
    });
    await follower.start();
    expect(totals.at(-1)!.requests).toBe(2);
    await fs.writeFile(
      file,
      jsonl([
        { type: "user_message", attrs: { content: "fresh" } },
        req({ copilotUsageNanoAiu: 1_000_000_000 }),
      ]),
    );
    await follower.refresh();
    follower.stop();
    expect(totals.at(-1)!.requests).toBe(1); // re-folded, not 2 or 3
  });

  it("flags the total partial when transcript history is prepended (streaming tx- prefix)", async () => {
    const file = await tmpFile(
      `${jsonl([
        { type: "user_message", attrs: { content: "q1" } },
        req({ copilotUsageNanoAiu: 1_000_000_000 }),
      ])}\n`,
    );
    const prefix: SessionEvent[] = [
      {
        type: "append",
        seq: 0,
        part: { kind: "userMessage", id: "tx-user-0", text: "q0" },
      },
    ];
    const totals: UsageSummary[] = [];
    const follower = new SessionFollower(file, () => {}, 0, {
      pollIntervalMs: 0,
      stream: {
        makeParser: () => new IncrementalDebugLogParser(),
        prefix,
        retagTag: "dl-",
      },
      onUsage: (u) => totals.push(u),
    });
    await follower.start();
    follower.stop();
    const last = totals.at(-1)!;
    expect(last.partial).toBe(true);
    expect(last.requests).toBe(1);
  });

  it("flags partial on the WHOLE-READ stitched path too (small prepended debug-log)", async () => {
    // A small debug-log that opens partway (q1) → the whole-read `parse` closure
    // stitches the transcript's older turn (q0) as a `tx-` prefix. accrueUsage
    // must see the `tx-` id and flag the total partial — same as the streaming
    // path, but via the OTHER pump (docs/02.6 §4.32).
    const history = parseSessionEvents(
      jsonl([
        { type: "user.message", data: { content: "q0" } },
        { type: "assistant.message", data: { content: "a0" } },
        { type: "user.message", data: { content: "q1" } },
      ]),
    );
    const file = await tmpFile(
      jsonl([
        { type: "user_message", attrs: { content: "q1" } },
        req({ copilotUsageNanoAiu: 1_000_000_000 }),
      ]),
    );
    const totals: UsageSummary[] = [];
    const follower = new SessionFollower(file, () => {}, 0, {
      pollIntervalMs: 0,
      parse: (c) => stitchEvents(history, parseDebugLogEvents(c)),
      onUsage: (u) => totals.push(u),
    });
    await follower.start();
    follower.stop();
    const last = totals.at(-1)!;
    expect(last.partial).toBe(true); // tx- prefix seen on the whole-read path
    expect(last.requests).toBe(1);
  });

  it("does not emit usage for a session with no telemetry", async () => {
    const file = await tmpFile(
      jsonl([{ type: "user_message", attrs: { content: "go" } }]),
    );
    const totals: UsageSummary[] = [];
    const follower = new SessionFollower(file, () => {}, 0, {
      pollIntervalMs: 0,
      parse: parseDebugLogEvents,
      onUsage: (u) => totals.push(u),
    });
    await follower.start();
    follower.stop();
    expect(totals).toHaveLength(0);
  });
});

describe("findTranscript", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0))
      await fs.rm(d, { recursive: true, force: true });
  });

  it("finds a session file by id and returns undefined otherwise", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-find-"));
    dirs.push(root);
    const tx = path.join(root, "hashX", "GitHub.copilot-chat", "transcripts");
    await fs.mkdir(tx, { recursive: true });
    await fs.writeFile(path.join(tx, "sessZ.jsonl"), "");

    expect(await findTranscript(root, "sessZ")).toBe(
      path.join(tx, "sessZ.jsonl"),
    );
    expect(await findTranscript(root, "nope")).toBeUndefined();
  });

  it("rejects a path-escape sessionId without touching the filesystem (S2)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-find-"));
    dirs.push(root);
    for (const bad of ["../../../../etc/passwd", "..", "a/b", "a\\b"]) {
      expect(await findTranscript(root, bad)).toBeUndefined();
      expect(await findSessionLog(root, bad)).toBeUndefined();
    }
  });
});

describe("parseDebugLogEvents", () => {
  const otel = (lines: object[]): string =>
    lines.map((l) => JSON.stringify(l)).join("\n");

  it("maps OTel spans (user_message, tool_call, agent_response) onto parts", () => {
    const content = otel([
      {
        type: "session_start",
        name: "session_start",
        attrs: { copilotVersion: "0.56.0" },
      },
      {
        type: "user_message",
        name: "user_message",
        attrs: { content: "Refactor auth" },
      },
      {
        type: "llm_request",
        name: "chat:claude-opus-4.8",
        dur: 4903,
        attrs: {
          model: "claude-opus-4.8",
          inputTokens: 100,
          outputTokens: 42,
          cachedTokens: 80,
          ttft: 3266,
          copilotUsageNanoAiu: 18901475000,
        },
      },
      {
        type: "tool_call",
        name: "read_file",
        spanId: "s1",
        attrs: { args: JSON.stringify({ p: "x" }), result: "ok" },
      },
      {
        type: "tool_call",
        name: "run_in_terminal",
        spanId: "s2",
        attrs: { args: "{}", error: "Canceled" },
      },
      { type: "hook", name: "PreToolUse", attrs: {} },
      {
        type: "agent_response",
        name: "agent_response",
        attrs: {
          reasoning: "planning",
          response: JSON.stringify([
            {
              role: "assistant",
              parts: [
                { type: "text", content: "Doing it now." },
                {
                  type: "tool_call",
                  id: "x",
                  name: "read_file",
                  arguments: {},
                },
              ],
            },
          ]),
        },
      },
    ]);
    const events = parseDebugLogEvents(content);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(events[0]).toMatchObject({
      type: "append",
      part: { kind: "userMessage", text: "Refactor auth" },
    });
    expect(events[1]).toMatchObject({
      type: "append",
      part: {
        kind: "usage",
        model: "claude-opus-4.8",
        inputTokens: 100,
        outputTokens: 42,
        cachedTokens: 80,
        ttftMs: 3266,
        durationMs: 4903,
        nanoAiu: 18901475000,
      },
    });
    expect(events[2]).toMatchObject({
      type: "append",
      part: {
        kind: "toolCall",
        name: "read_file",
        status: "done",
        input: { p: "x" },
      },
    });
    expect(events[3]).toMatchObject({
      type: "append",
      part: { kind: "toolCall", name: "run_in_terminal", status: "error" },
    });
    expect(events[4]).toMatchObject({
      type: "append",
      part: { kind: "thinking", text: "planning" },
    });
    expect(events[5]).toMatchObject({
      type: "append",
      part: { kind: "markdown", text: "Doing it now." },
    });
  });

  it("maps an interactive tool_call to confirmations, resolved (completed span)", () => {
    const content = otel([
      {
        type: "tool_call",
        name: "vscode_askQuestions",
        spanId: "q1",
        attrs: {
          args: JSON.stringify({
            questions: [
              {
                question: "Which file?",
                options: [
                  { label: "a.txt", recommended: true },
                  { label: "b.txt" },
                ],
              },
            ],
          }),
        },
      },
    ]);
    const events = parseDebugLogEvents(content);
    const appended = events[0];
    if (appended?.type !== "append" || appended.part.kind !== "confirmation") {
      throw new Error("expected a confirmation append");
    }
    expect(appended.part.prompt).toBe("Which file?");
    expect(appended.part.options).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "resolve", id: appended.part.id });
  });

  it("salvages assistant text when `response` is truncated/unparseable", () => {
    // VS Code caps the debug-log `response` attr at ~5 KB and appends a
    // `[truncated]` marker, so it no longer parses to the message array. The
    // parser must salvage the `text` parts, not dump the raw `[{"role":…}]`
    // blob into the transcript (bug: 2026-07-11).
    const args = JSON.stringify({ content: "FILEDATA", filePath: "/x" });
    const truncated =
      '[{"role":"assistant","parts":[' +
      '{"type":"text","content":"First part."},' +
      `{"type":"tool_call","id":"x","name":"create_file","arguments":${JSON.stringify(
        args,
      )}},` +
      '{"type":"text","content":"Second part that got cut of[truncated]';
    const content = otel([
      {
        type: "agent_response",
        name: "agent_response",
        attrs: { response: truncated },
      },
    ]);
    const events = parseDebugLogEvents(content);
    const md = events.find(
      (e) => e.type === "append" && e.part.kind === "markdown",
    );
    if (md?.type !== "append" || md.part.kind !== "markdown") {
      throw new Error("expected a markdown append");
    }
    expect(md.part.text).not.toContain('"role":"assistant"');
    expect(md.part.text).toContain("First part.");
    expect(md.part.text).toContain("Second part that got cut of");
    expect(md.part.text).not.toContain("FILEDATA");
  });
});

describe("findSessionLog", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0))
      await fs.rm(d, { recursive: true, force: true });
  });

  it("prefers the complete debug-log over the transcript", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-log-"));
    dirs.push(root);
    const base = path.join(root, "hashX", "GitHub.copilot-chat");
    await fs.mkdir(path.join(base, "transcripts"), { recursive: true });
    await fs.writeFile(path.join(base, "transcripts", "sessZ.jsonl"), "");
    await fs.mkdir(path.join(base, "debug-logs", "sessZ"), { recursive: true });
    await fs.writeFile(
      path.join(base, "debug-logs", "sessZ", "main.jsonl"),
      jsonl([{ type: "user_message", attrs: { content: "from debug-log" } }]),
    );

    const log = await findSessionLog(root, "sessZ");
    expect(log?.file).toBe(
      path.join(base, "debug-logs", "sessZ", "main.jsonl"),
    );
    // The parser reads the debug-log (the leading source), not just the transcript.
    const parsed = log ? log.parse(await fs.readFile(log.file, "utf8")) : [];
    const userTexts = parsed.flatMap((e) =>
      e.type === "append" && e.part.kind === "userMessage" ? [e.part.text] : [],
    );
    expect(userTexts).toContain("from debug-log");
  });

  it("falls back to the transcript when no debug-log exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-log2-"));
    dirs.push(root);
    const base = path.join(root, "hashX", "GitHub.copilot-chat");
    await fs.mkdir(path.join(base, "transcripts"), { recursive: true });
    await fs.writeFile(path.join(base, "transcripts", "sessZ.jsonl"), "");

    const log = await findSessionLog(root, "sessZ");
    expect(log?.file).toBe(path.join(base, "transcripts", "sessZ.jsonl"));
    expect(log?.parse).toBe(parseSessionEvents);
    expect(await findSessionLog(root, "nope")).toBeUndefined();
  });
});
