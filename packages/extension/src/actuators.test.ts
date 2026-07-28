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
function harness(pending: string[] = ["t"]) {
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
    pendingToolCallIds: async () => pending,
    log: noopLogger,
  });
  return { actuators, calls, removed };
}

const cmds = (calls: Array<[string, unknown[]]>) => calls.map((c) => c[0]);

describe("buildActuators", () => {
  it("respond opens the session then submits the text (composer-free)", async () => {
    const { actuators, calls } = harness();
    await actuators.respond({ sessionId: "s", text: "hi" });
    expect(calls).toEqual([
      ["vscode.open", ["uri:s"]],
      ["workbench.action.chat.submit", [{ inputValue: "hi" }]],
    ]);
  });

  it("respond names NO queue kind — VS Code decides whether to hold it", async () => {
    // Upstream applies `options.queue ??= Queued` only while a request is in
    // flight, and its own Queue/Steer actions guard on `requestInProgress`
    // first. Naming a kind unconditionally holds the message even when nothing
    // is running — and a turn paused on a confirmation is NOT "in progress", so
    // the held row wedges the approval it is waiting on. docs/02.3 §4.35.
    const { actuators, calls } = harness();
    await actuators.respond({ sessionId: "s", text: "hi" });
    const submit = calls.find(
      ([cmd]) => cmd === "workbench.action.chat.submit",
    )?.[1][0] as { acceptInputOptions?: unknown };
    expect(submit.acceptInputOptions).toBeUndefined();
  });

  it("steer submits the text directly with the steering queue kind (no composer read)", async () => {
    const { actuators, calls } = harness();
    await actuators.steer({ sessionId: "s", text: "go left" });
    // ONE payload-carrying submit: `inputValue` means chat.submit uses our text
    // and never reads the shared composer, so there is no prefill→submit capture
    // window (fixes docs/06 bug-steer-composer-capture).
    expect(calls).toEqual([
      ["vscode.open", ["uri:s"]],
      [
        "workbench.action.chat.submit",
        [{ inputValue: "go left", acceptInputOptions: { queue: "steering" } }],
      ],
    ]);
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

  it("stop-and-send cancels + sends the text in one atomic submit", async () => {
    const { actuators, calls, removed } = harness();
    await actuators.stop({ sessionId: "s", text: "new task" });
    expect(calls).toEqual([
      ["vscode.open", ["uri:s"]],
      [
        "workbench.action.chat.submit",
        [
          {
            inputValue: "new task",
            acceptInputOptions: { cancelCurrentRequest: true },
          },
        ],
      ],
    ]);
    expect(removed).toEqual(["s"]);
  });

  it("decide fires accept/skip targeted by the session resource", async () => {
    const allow = harness();
    await allow.actuators.decide({
      sessionId: "s",
      toolCallId: "t",
      decision: "allow",
    });
    // OPEN first: `acceptTool` resolves the widget by session resource and
    // silently returns when no widget has that session loaded (vscode
    // `chatWidgetService.getWidgetBySessionResource`).
    expect(allow.calls).toEqual([
      ["vscode.open", ["uri:s"]],
      ["workbench.action.chat.acceptTool", [{ sessionResource: "uri:s" }]],
    ]);

    const deny = harness();
    await deny.actuators.decide({
      sessionId: "s",
      toolCallId: "t",
      decision: "deny",
    });
    expect(deny.calls[1][0]).toBe("workbench.action.chat.skipTool");
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

  it("decide fails closed when the toolCall is no longer pending (S5)", async () => {
    // Nothing pending for the session — a stale tap must NOT resolve a newer call.
    const gone = harness([]);
    await gone.actuators.decide({
      sessionId: "s",
      toolCallId: "t",
      decision: "allow",
    });
    expect(gone.calls).toEqual([]);

    // A DIFFERENT call is pending — the stale id for "t" is still refused.
    const other = harness(["t2"]);
    await other.actuators.decide({
      sessionId: "s",
      toolCallId: "t",
      decision: "deny",
    });
    expect(other.calls).toEqual([]);
  });

  it("decide matches on the BASE toolCallId (suffixed request still resolves)", async () => {
    const { actuators, calls } = harness(["tc"]);
    await actuators.decide({
      sessionId: "s",
      toolCallId: "tc__vscode-9",
      decision: "allow",
    });
    expect(calls[1]?.[0]).toBe("workbench.action.chat.acceptTool");
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
