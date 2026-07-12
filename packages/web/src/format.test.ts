import { describe, expect, it } from "vitest";
import type { PendingBlocker, SessionPart } from "@cloakcode/protocol";
import {
  approvalSummary,
  buildAnswerText,
  humanAge,
  sessionActivity,
  statusLabel,
  toolSummary,
} from "./format";

describe("humanAge", () => {
  it("formats seconds, minutes, hours, days", () => {
    expect(humanAge(0)).toBe("0s");
    expect(humanAge(45)).toBe("45s");
    expect(humanAge(6 * 60)).toBe("6m");
    expect(humanAge(2 * 3600)).toBe("2h");
    expect(humanAge(3 * 86400)).toBe("3d");
  });

  it("never returns a negative age", () => {
    expect(humanAge(-5)).toBe("0s");
  });
});

describe("statusLabel", () => {
  it("labels each status", () => {
    expect(statusLabel("active", 0)).toBe("active");
    expect(statusLabel("blocked", 180)).toBe("blocked 3m");
    expect(statusLabel("idle", 7200)).toBe("idle 2h");
  });
});

describe("sessionActivity", () => {
  const none = new Set<string>();
  const noParts: SessionPart[] = [];
  const approval: PendingBlocker = {
    toolCallId: "t1",
    toolName: "run_in_terminal",
    createdAt: "2026-07-12T00:00:00Z",
    input: { command: "ls" },
  };
  const question: PendingBlocker = {
    toolCallId: "t2",
    toolName: "vscode_askQuestions",
    createdAt: "2026-07-12T00:00:00Z",
    confirmations: [{ kind: "confirmation", id: "c0", prompt: "Pick", options: [] }],
  };

  it("labels a tool approval as blocked on approval", () => {
    expect(sessionActivity([approval], noParts, none, "active", 0)).toEqual({
      label: "blocked on approval",
      awaiting: true,
    });
  });

  it("labels a question as awaiting response", () => {
    expect(sessionActivity([question], noParts, none, "blocked", 0)).toEqual({
      label: "awaiting response",
      awaiting: true,
    });
  });

  it("labels an unresolved transcript confirmation as awaiting response", () => {
    const parts: SessionPart[] = [
      { kind: "confirmation", id: "c1", prompt: "?", options: [] },
    ];
    expect(sessionActivity([], parts, none, "blocked", 0).label).toBe(
      "awaiting response",
    );
  });

  it("labels a running tool as tool calling", () => {
    const parts: SessionPart[] = [
      { kind: "toolCall", id: "x", name: "read_file", input: {}, status: "running" },
    ];
    expect(sessionActivity([], parts, none, "active", 0)).toEqual({
      label: "tool calling",
      awaiting: false,
    });
  });

  it("falls back to the scan status label", () => {
    expect(sessionActivity([], noParts, none, "idle", 7200).label).toBe("idle 2h");
  });
});

describe("toolSummary", () => {
  it("summarizes reads with line range", () => {
    expect(
      toolSummary("read_file", {
        filePath: "src/auth/middleware.ts",
        startLine: 1,
        endLine: 48,
      }),
    ).toEqual({ label: "Read", detail: "middleware.ts (1–48)" });
  });

  it("summarizes edits by file name", () => {
    expect(
      toolSummary("replace_string_in_file", { filePath: "a/b/App.tsx" }),
    ).toEqual({ label: "Edited", detail: "App.tsx" });
  });

  it("summarizes multi-edits (one file vs many)", () => {
    expect(
      toolSummary("multi_replace_string_in_file", {
        replacements: [{ filePath: "x/App.tsx" }, { filePath: "x/App.tsx" }],
      }),
    ).toEqual({ label: "Edited", detail: "App.tsx" });
    expect(
      toolSummary("multi_replace_string_in_file", {
        replacements: [{ filePath: "a.ts" }, { filePath: "b.ts" }],
      }),
    ).toEqual({ label: "Edited", detail: "2 files" });
  });

  it("summarizes terminal commands", () => {
    expect(toolSummary("run_in_terminal", { command: "pnpm test" })).toEqual({
      label: "Ran",
      detail: "pnpm test",
    });
  });

  it("parses a JSON-string input", () => {
    expect(toolSummary("create_file", '{"filePath":"/tmp/x.txt"}')).toEqual({
      label: "Created",
      detail: "x.txt",
    });
  });

  it("falls back to the raw tool name", () => {
    expect(toolSummary("weird_custom_tool", {})).toEqual({
      label: "weird_custom_tool",
    });
  });
});

describe("approvalSummary", () => {
  it("phrases pending approvals in the present tense", () => {
    expect(approvalSummary("create_file", { filePath: "/tmp/x.txt" })).toEqual({
      label: "Create",
      detail: "x.txt",
    });
    expect(
      approvalSummary("replace_string_in_file", { filePath: "a/App.tsx" }),
    ).toEqual({ label: "Edit", detail: "App.tsx" });
    expect(approvalSummary("run_in_terminal", { command: "rm -rf x" })).toEqual(
      {
        label: "Run",
        detail: "rm -rf x",
      },
    );
  });

  it("leaves labels without a present-tense form unchanged", () => {
    expect(approvalSummary("weird_custom_tool", {})).toEqual({
      label: "weird_custom_tool",
    });
  });
});

describe("buildAnswerText", () => {
  it("pairs each question with its answer, one per line", () => {
    expect(
      buildAnswerText([
        {
          question: "Which file name should I use in /tmp/?",
          answer: "scratch.txt",
        },
        { question: "Overwrite or append?", answer: "Overwrite" },
      ]),
    ).toBe(
      "Which file name should I use in /tmp/? → scratch.txt\nOverwrite or append? → Overwrite",
    );
  });

  it("skips unanswered questions and trims", () => {
    expect(
      buildAnswerText([
        { question: "Q1", answer: "  " },
        { question: "  Q2  ", answer: "  Append  " },
      ]),
    ).toBe("Q2 → Append");
  });
});
