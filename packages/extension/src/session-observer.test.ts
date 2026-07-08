import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEvent } from "@cloakcode/protocol";
import {
  SessionFollower,
  findTranscript,
  parseSessionEvents,
} from "./session-observer.js";

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
        data: { toolCallId: "t1", toolName: "read_file", arguments: { p: "x" } },
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
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
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
});

describe("findTranscript", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
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
