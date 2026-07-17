import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "./hook";

let dir: string;
let warnings: string[];
const warn = (m: string): void => {
  warnings.push(m);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cloakcode-hook-"));
  warnings = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A well-formed Copilot `PreToolUse` stdin payload. */
function preToolUse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "sess-1",
    tool_name: "run_in_terminal",
    tool_use_id: "toolu_abc__vscode-4",
    tool_input: { command: "ls" },
    ...overrides,
  });
}

describe("runHook — PreToolUse", () => {
  it("spools one record and DEFERs for a valid tool call", () => {
    const out = runHook("PreToolUse", preToolUse(), dir, {
      warn,
      now: () => "2026-07-17T00:00:00.000Z",
    });

    expect(out).toBe("{}");
    expect(warnings).toEqual([]);
    const files = readdirSync(dir);
    // The suffix is stripped to the base toolCallId (the dedup join key).
    expect(files).toEqual(["toolu_abc.json"]);
    const record = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    expect(record).toMatchObject({
      sessionId: "sess-1",
      toolCallId: "toolu_abc",
      toolName: "run_in_terminal",
      ts: "2026-07-17T00:00:00.000Z",
      awaitingDecision: true,
    });
  });

  it("DEFERs and warns (no file) on an unrecognized tool-call shape", () => {
    const out = runHook("PreToolUse", JSON.stringify({ foo: "bar" }), dir, {
      warn,
    });

    expect(out).toBe("{}");
    expect(readdirSync(dir)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unrecognized tool-call shape");
  });
});

describe("runHook — PostToolUse", () => {
  it("clears the matching spool file and DEFERs", () => {
    // Seed a spool file the way PreToolUse would have.
    runHook("PreToolUse", preToolUse(), dir, { warn });
    expect(readdirSync(dir)).toEqual(["toolu_abc.json"]);
    warnings = [];

    const out = runHook("PostToolUse", preToolUse(), dir, { warn });

    expect(out).toBe("{}");
    expect(readdirSync(dir)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("DEFERs and warns when the payload has no toolCallId", () => {
    const out = runHook(
      "PostToolUse",
      JSON.stringify({ session_id: "s" }),
      dir,
      {
        warn,
      },
    );

    expect(out).toBe("{}");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no toolCallId");
  });
});

describe("runHook — stdin parsing & unknown events", () => {
  it("DEFERs and warns on malformed JSON — WITHOUT leaking the raw payload", () => {
    const secret = '{"session_id":"s","secret":"p@ssw0rd", BROKEN';
    const out = runHook("PreToolUse", secret, dir, { warn });

    expect(out).toBe("{}");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not valid JSON");
    expect(warnings[0]).toContain(String(secret.length)); // byte count only
    // The diagnostic must never echo the untrusted payload (prompts/secrets/code).
    expect(warnings[0]).not.toContain("secret");
    expect(warnings[0]).not.toContain("p@ssw0rd");
  });

  it("does not warn about JSON on empty stdin, but flags the missing payload", () => {
    // Empty stdin isn't a parse error (nothing to parse), so no "not valid JSON"
    // warning — but an empty payload has no routing keys, so the handler still
    // surfaces the drop (a real PreToolUse always carries a payload).
    expect(runHook("PreToolUse", "", dir, { warn })).toBe("{}");
    expect(runHook("PostToolUse", "   ", dir, { warn })).toBe("{}");
    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => !w.includes("not valid JSON"))).toBe(true);
    expect(warnings[0]).toContain("unrecognized tool-call shape");
    expect(warnings[1]).toContain("no toolCallId");
  });

  it("DEFERs and warns for an unknown event name", () => {
    const out = runHook("SomethingElse", preToolUse(), dir, { warn });

    expect(out).toBe("{}");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("SomethingElse");
  });

  it("DEFERs silently for an empty event name", () => {
    expect(runHook("", preToolUse(), dir, { warn })).toBe("{}");
    expect(warnings).toEqual([]);
  });

  it("degrades to DEFER and warns if spooling throws (unwritable dir)", () => {
    const badDir = join(dir, "file-not-dir");
    writeFileSync(badDir, "x"); // now mkdir/write under it fails
    const out = runHook("PreToolUse", preToolUse(), join(badDir, "sub"), {
      warn,
    });

    expect(out).toBe("{}");
    expect(warnings.some((w) => w.startsWith("degraded to defer"))).toBe(true);
  });
});
