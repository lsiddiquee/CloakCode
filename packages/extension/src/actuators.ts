import type { Logger } from "@cloakcode/protocol";
import { baseToolCallId, buildCarouselAnswers } from "./hook-spool.js";
import type { BridgeDeps } from "./bridge.js";

/**
 * Ports the actuators need from the extension host, injected so the actuator
 * WIRING (which command fires, in what order, with what args) is unit-testable
 * WITHOUT an extension host — the reason this lives apart from `extension.ts`.
 */
export interface ActuatorPorts {
  /** Run a VS Code command (wired to `vscode.commands.executeCommand`). */
  execute: (command: string, ...args: unknown[]) => Thenable<unknown>;
  /** The chat resource URI for a session (wired to `vscode.Uri.parse ∘ localChatSessionUri`). */
  sessionUri: (sessionId: string) => unknown;
  /** GC a session's spool files (force-stop cleanup). */
  removeSpool: (sessionId: string) => Promise<void>;
  /** Structured actuator-action log. */
  log: Logger;
}

/** The `remote-operator` actuator subset of {@link BridgeDeps}. */
export type Actuators = Required<
  Pick<BridgeDeps, "respond" | "steer" | "stop" | "decide" | "answer">
>;

/**
 * Build the actuator handlers (`respond` / `steer` / `stop` / `decide` /
 * `answer`) from the injected host ports. Each is a `remote-operator` action
 * (docs/04) that resolves to VS Code commands, targeted by the session URI
 * (EXACT-match, so a stale id is a safe no-op; docs/02 §4.16). Pure wiring — no
 * `vscode` import — so it's testable with a mock `execute`.
 */
export function buildActuators({
  execute,
  sessionUri,
  removeSpool,
  log,
}: ActuatorPorts): Actuators {
  return {
    respond: async ({ sessionId, text, traceId }) => {
      // M3b targeted-send: focus the SPECIFIC local session by its resource URI,
      // then submit — instead of only the active chat. `sessionId` names the
      // transcript AND is what Copilot base64url-encodes into
      // `vscode-chat-session://local/<id>`, a registered editor. See docs/02.
      const uri = sessionUri(sessionId);
      log.info("actuator.respond", { sessionId, traceId });
      await execute("vscode.open", uri);
      await execute("workbench.action.chat.open", { query: text });
    },
    steer: async ({ sessionId, text, traceId }) => {
      // Redirect the IN-FLIGHT turn (docs/02 §4.28): focus the session, PREFILL
      // the composer without sending (`isPartialQuery`), then fire
      // `steerWithMessage` — VS Code folds the text into the running turn.
      const uri = sessionUri(sessionId);
      log.info("actuator.steer", { sessionId, traceId });
      await execute("vscode.open", uri);
      await execute("workbench.action.chat.open", {
        query: text,
        isPartialQuery: true,
      });
      await execute("workbench.action.chat.steerWithMessage");
    },
    stop: async ({ sessionId, text, traceId }) => {
      // Cancel the in-flight turn (`chat.cancel` acts on the focused session).
      // With a follow-up `text`, send it as a fresh prompt (stop-and-send).
      const uri = sessionUri(sessionId);
      log.info("actuator.stop", { sessionId, send: Boolean(text), traceId });
      await execute("vscode.open", uri);
      await execute("workbench.action.chat.cancel");
      // Force-stop abandons the in-flight turn's pending tool call(s): we're
      // ignoring that blocker, so GC its spool file NOW rather than waiting for
      // `isSuperseded` on the next turn (force-stop spool leak; docs/02 §4.19).
      await removeSpool(sessionId);
      if (text) {
        await execute("workbench.action.chat.open", { query: text });
      }
    },
    decide: async ({ sessionId, toolCallId, decision, traceId }) => {
      // Resolve VS Code's OWN native tool confirmation via command, targeted by
      // the session URI (EXACT-match, so a wrong id is a safe no-op; docs/02
      // §4.16). No per-tool id: accept/skip act on that session's first waiting
      // confirmation; `toolCallId` is logged for traceability.
      if (!sessionId) {
        log.warn("actuator.decide_no_session");
        return;
      }
      const uri = sessionUri(sessionId);
      const cmd =
        decision === "allow"
          ? "workbench.action.chat.acceptTool"
          : "workbench.action.chat.skipTool";
      log.info("actuator.decide", { sessionId, decision, toolCallId, traceId });
      await execute(cmd, { sessionResource: uri });
    },
    answer: async ({ sessionId, toolCallId, answers, traceId }) => {
      // Deliver the operator's STRUCTURED answer to the pending question carousel
      // (docs/02 §4.16). VS Code keys it on the BASE id while the hook hands us
      // the RAW suffixed id — so try BOTH forms; the non-matching fire no-ops.
      const base = baseToolCallId(toolCallId);
      const ids = base === toolCallId ? [toolCallId] : [toolCallId, base];
      log.info("actuator.answer", {
        sessionId,
        questions: answers.length,
        traceId,
      });
      for (const rid of ids) {
        await execute(
          "_chat.notifyQuestionCarouselAnswer",
          rid,
          buildCarouselAnswers(rid, answers),
        );
      }
    },
  };
}
