import { describe, it, expect } from "vitest";
import type { Logger } from "@cloakcode/protocol";
import { buildActuators } from "./actuators.js";

const noopLogger: Logger = {
  log() {},
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
  level: "info",
};

/** A harness that records the commands the actuators fire + spool removals. */
function harness() {
  const calls: Array<[string, unknown[]]> = [];
  const removed: string[] = [];
  const actuators = buildActuators({
    execute: (command, ...args) => {
      calls.push([command, args]);
      return Promise.resolve();
    },
    sessionUri: (sessionId) => `uri:${sessionId}`,
    removeSpool: async (sessionId) => {
      removed.push(sessionId);
    },
    log: noopLogger,
  });
  return { actuators, calls, removed };
}

const cmds = (calls: Array<[string, unknown[]]>) => calls.map((c) => c[0]);

describe("buildActuators", () => {
  it("respond opens the session then submits the query", async () => {
    const { actuators, calls } = harness();
    await actuators.respond({ sessionId: "s", text: "hi" });
    expect(calls).toEqual([
      ["vscode.open", ["uri:s"]],
      ["workbench.action.chat.open", [{ query: "hi" }]],
    ]);
  });

  it("steer prefills as a partial query then fires steerWithMessage", async () => {
    const { actuators, calls } = harness();
    await actuators.steer({ sessionId: "s", text: "go left" });
    expect(cmds(calls)).toEqual([
      "vscode.open",
      "workbench.action.chat.open",
      "workbench.action.chat.steerWithMessage",
    ]);
    expect(calls[1][1]).toEqual([{ query: "go left", isPartialQuery: true }]);
  });

  it("stop cancels + GCs the spool, and does NOT send without text", async () => {
    const { actuators, calls, removed } = harness();
    await actuators.stop({ sessionId: "s" });
    expect(cmds(calls)).toEqual([
      "vscode.open",
      "workbench.action.chat.cancel",
    ]);
    expect(removed).toEqual(["s"]);
  });

  it("stop-and-send appends a fresh prompt when text is given", async () => {
    const { actuators, calls, removed } = harness();
    await actuators.stop({ sessionId: "s", text: "new task" });
    expect(cmds(calls)).toEqual([
      "vscode.open",
      "workbench.action.chat.cancel",
      "workbench.action.chat.open",
    ]);
    expect(calls[2][1]).toEqual([{ query: "new task" }]);
    expect(removed).toEqual(["s"]);
  });

  it("decide fires accept/skip targeted by the session resource", async () => {
    const allow = harness();
    await allow.actuators.decide({
      sessionId: "s",
      toolCallId: "t",
      decision: "allow",
    });
    expect(allow.calls).toEqual([
      ["workbench.action.chat.acceptTool", [{ sessionResource: "uri:s" }]],
    ]);

    const deny = harness();
    await deny.actuators.decide({
      sessionId: "s",
      toolCallId: "t",
      decision: "deny",
    });
    expect(deny.calls[0][0]).toBe("workbench.action.chat.skipTool");
  });

  it("decide with no session is a no-op (no command)", async () => {
    const { actuators, calls } = harness();
    await actuators.decide({
      sessionId: "",
      toolCallId: "t",
      decision: "allow",
    });
    expect(calls).toEqual([]);
  });

  it("answer delivers to BOTH the raw and base id for a suffixed carousel", async () => {
    const { actuators, calls } = harness();
    await actuators.answer({
      sessionId: "s",
      toolCallId: "tc__vscode-2",
      answers: [{ selected: ["y"] }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe("_chat.notifyQuestionCarouselAnswer");
    expect(calls[0][1][0]).toBe("tc__vscode-2");
    expect(calls[1][1][0]).toBe("tc"); // base id
  });

  it("answer delivers once for an unsuffixed id", async () => {
    const { actuators, calls } = harness();
    await actuators.answer({
      sessionId: "s",
      toolCallId: "tc",
      answers: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][1][0]).toBe("tc");
  });
});
