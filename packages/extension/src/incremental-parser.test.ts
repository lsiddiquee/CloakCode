import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@cloakcode/protocol";
import {
  IncrementalTranscriptParser,
  IncrementalDebugLogParser,
  parseSessionEvents,
  parseDebugLogEvents,
} from "./session-observer.js";

// A rich transcript: user + assistant (thinking+markdown), a NON-interactive
// tool (start→complete, resolved via updateStatus) and an INTERACTIVE tool
// (start→complete, resolved via the carried interactiveIds map) — the two cases
// whose state must survive a read boundary.
const transcriptLines = [
  JSON.stringify({ type: "user.message", data: { content: "hello" } }),
  JSON.stringify({
    type: "assistant.message",
    data: { reasoningText: "hmm", content: "hi there" },
  }),
  JSON.stringify({
    type: "tool.execution_start",
    data: {
      toolCallId: "tc1",
      toolName: "read_file",
      arguments: { path: "a" },
    },
  }),
  JSON.stringify({ type: "user.message", data: { content: "between" } }),
  JSON.stringify({
    type: "tool.execution_complete",
    data: { toolCallId: "tc1", success: true },
  }),
  JSON.stringify({
    type: "tool.execution_start",
    data: {
      toolCallId: "tc2",
      toolName: "vscode_askQuestions",
      arguments: { questions: [{ question: "pick one", options: ["a", "b"] }] },
    },
  }),
  JSON.stringify({ type: "assistant.message", data: { content: "deciding" } }),
  JSON.stringify({
    type: "tool.execution_complete",
    data: { toolCallId: "tc2", success: true },
  }),
  JSON.stringify({ type: "user.message", data: { content: "done" } }),
];

const debugLogLines = [
  JSON.stringify({ type: "user_message", attrs: { content: "hello" } }),
  JSON.stringify({
    type: "agent_response",
    attrs: {
      reasoning: "hmm",
      response: [
        { role: "assistant", parts: [{ type: "text", content: "hi" }] },
      ],
    },
  }),
  JSON.stringify({
    type: "tool_call",
    spanId: "sp1",
    name: "read_file",
    attrs: { args: { path: "a" } },
  }),
  JSON.stringify({
    type: "llm_request",
    dur: 1200,
    attrs: {
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 2,
      ttft: 300,
    },
  }),
  JSON.stringify({ type: "user_message", attrs: { content: "done" } }),
];

/** Feed `lines` in TWO batches at every possible boundary — proving the carried
 *  state (seq, *Idx, interactiveIds) is independent of where the reads split. */
function allSplits<P extends { push(line: string): SessionEvent[] }>(
  make: () => P,
  lines: string[],
): SessionEvent[][] {
  const results: SessionEvent[][] = [];
  for (let split = 0; split <= lines.length; split += 1) {
    const p = make();
    results.push([
      ...lines.slice(0, split).flatMap((l) => p.push(l)),
      ...lines.slice(split).flatMap((l) => p.push(l)),
    ]);
  }
  return results;
}

describe("incremental parser equivalence (2b)", () => {
  it("transcript: every read-boundary split === the whole-string parse", () => {
    const whole = parseSessionEvents(transcriptLines.join("\n"));
    for (const out of allSplits(
      () => new IncrementalTranscriptParser(),
      transcriptLines,
    )) {
      expect(out).toEqual(whole);
    }
  });

  it("debug-log: every read-boundary split === the whole-string parse", () => {
    const whole = parseDebugLogEvents(debugLogLines.join("\n"));
    for (const out of allSplits(
      () => new IncrementalDebugLogParser(),
      debugLogLines,
    )) {
      expect(out).toEqual(whole);
    }
  });

  it("resolves an interactive tool whose start/complete straddle the boundary", () => {
    // Feed everything up to (not incl.) tc2's complete, then the rest — the
    // complete must resolve the confirmation part the start emitted (carried map).
    const completeIdx = transcriptLines.findIndex(
      (l) => l.includes('"tc2"') && l.includes("execution_complete"),
    );
    const p = new IncrementalTranscriptParser();
    const merged = [
      ...transcriptLines.slice(0, completeIdx).flatMap((l) => p.push(l)),
      ...transcriptLines.slice(completeIdx).flatMap((l) => p.push(l)),
    ];
    expect(merged).toEqual(parseSessionEvents(transcriptLines.join("\n")));
    // The confirmation emitted by tc2's start is resolved after the boundary.
    expect(
      merged.some((e) => e.type === "resolve" && e.id.startsWith("conf-tc2")),
    ).toBe(true);
  });

  it("keeps seq contiguous (0..n-1) across a split — the 2c/2d/#5 invariant", () => {
    const p = new IncrementalTranscriptParser();
    const out = [
      ...transcriptLines.slice(0, 3).flatMap((l) => p.push(l)),
      ...transcriptLines.slice(3).flatMap((l) => p.push(l)),
    ];
    expect(out.map((e) => e.seq)).toEqual(out.map((_, i) => i));
  });
});
