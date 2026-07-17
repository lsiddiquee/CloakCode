import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEvent } from "@cloakcode/protocol";
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
