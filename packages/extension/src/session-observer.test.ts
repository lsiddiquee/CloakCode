import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createLogger,
  type LogRecord,
  type SessionEvent,
} from "@cloakcode/protocol";
import {
  SessionFollower,
  findTranscript,
  findSessionLog,
  parseSessionEvents,
  parseDebugLogEvents,
  stitchEvents,
} from "./session-observer.js";

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

  it("logs a read failure once (deduped) via the injected logger", async () => {
    const file = await tmpFile(
      jsonl([{ type: "user.message", data: { content: "one" } }]),
    );
    const records: LogRecord[] = [];
    const logger = createLogger({
      sink: (r) => records.push(r),
      level: "debug",
    });
    const follower = new SessionFollower(file, () => {}, 0, {
      pollIntervalMs: 0,
      logger,
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
      turnFile: file,
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
