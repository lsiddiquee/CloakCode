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
  /**
   * Base toolCallIds currently pending (in the spool) for a session. `decide`
   * uses it to fail closed when a stale approval would otherwise resolve a
   * DIFFERENT, now-current pending call (drift audit S5).
   */
  pendingToolCallIds: (sessionId: string) => Promise<string[]>;
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
 * (EXACT-match on the URI); `decide` additionally **fails closed** if its
 * toolCallId is no longer the session's pending call (S5). Pure wiring — no
 * `vscode` import — so it's testable with a mock `execute`.
 */
export function buildActuators({
  execute,
  sessionUri,
  removeSpool,
  pendingToolCallIds,
  log,
}: ActuatorPorts): Actuators {
  return {
    respond: async ({ sessionId, text, traceId }) => {
      // M3b targeted-send: focus the SPECIFIC local session by its resource URI,
      // then submit the text DIRECTLY (`chat.submit {inputValue}`) — our payload,
      // never the shared composer, so a local draft is untouched.
      // `sessionId` names the transcript AND is what Copilot base64url-encodes
      // into `vscode-chat-session://local/<id>`, a registered editor. See docs/02.
      //
      // NO queue kind, deliberately: VS Code holds the message itself
      // (`options.queue ??= Queued`) only while a request is genuinely in
      // flight, which is a state we cannot observe as reliably as it can
      // (docs/02.3 §4.35). Naming a kind here would hold it unconditionally.
      const uri = sessionUri(sessionId);
      log.info("actuator.respond", { sessionId, traceId });
      await execute("vscode.open", uri);
      await execute("workbench.action.chat.submit", { inputValue: text });
    },
    steer: async ({ sessionId, text, traceId }) => {
      // Redirect the IN-FLIGHT turn (docs/02 §4.28): focus the session, then
      // SUBMIT the text directly with the `steering` queue kind. Passing
      // `inputValue` makes `chat.submit` use OUR payload — VS Code never reads
      // the shared composer — so there is no prefill→submit capture window
      // (fixes docs/06 bug-steer-composer-capture). `workbench.action.chat.submit`
      // is a registered command whose handler runs regardless of precondition
      // (Action2 preconditions gate menus/keybindings, not `executeCommand`), and
      // it forwards `inputValue` + `acceptInputOptions` straight to the widget's
      // `acceptInput`. The earlier "Failed to find command" (docs/02.1) was the
      // string-only command-runner probe, not the extension's object invocation.
      const uri = sessionUri(sessionId);
      log.info("actuator.steer", { sessionId, traceId });
      await execute("vscode.open", uri);
      await execute("workbench.action.chat.submit", {
        inputValue: text,
        acceptInputOptions: { queue: "steering" },
      });
    },
    stop: async ({ sessionId, text, traceId }) => {
      // Cancel the in-flight turn. Plain stop → `chat.cancel` (acts on the
      // focused session). Stop-and-send → ONE atomic `chat.submit` with
      // `cancelCurrentRequest` (VS Code's native "Stop and Send"): cancels the
      // running turn AND sends `text` as a fresh turn, composer-free. NOTE this
      // path can still raise the local pending-requests modal (docs/02.3 §4.35):
      // the `cancelCurrentRequest` branch sets `options.queue = undefined`
      // upstream, so naming a queue kind here would just be discarded.
      const uri = sessionUri(sessionId);
      log.info("actuator.stop", { sessionId, send: Boolean(text), traceId });
      await execute("vscode.open", uri);
      if (text) {
        await execute("workbench.action.chat.submit", {
          inputValue: text,
          acceptInputOptions: { cancelCurrentRequest: true },
        });
      } else {
        await execute("workbench.action.chat.cancel");
      }
      // Force-stop abandons the in-flight turn's pending tool call(s): we're
      // ignoring that blocker, so GC its spool file NOW rather than waiting for
      // `isSuperseded` on the next turn (force-stop spool leak; docs/02 §4.19).
      await removeSpool(sessionId);
    },
    decide: async ({ sessionId, toolCallId, decision, traceId }) => {
      // Resolve VS Code's OWN native tool confirmation via command, targeted by
      // the session URI. `acceptTool`/`skipTool` resolve that session's FIRST
      // waiting confirmation and are NOT keyed on `toolCallId`, so a STALE tap
      // (for a call that already completed) would otherwise resolve whatever is
      // now current (drift audit S5). Guard: only fire if the requested
      // toolCallId is still pending in the spool; else fail closed. docs/02 §4.16.
      if (!sessionId) {
        log.warn("actuator.decide_no_session");
        return;
      }
      const base = baseToolCallId(toolCallId);
      if (!(await pendingToolCallIds(sessionId)).includes(base)) {
        log.warn("actuator.decide_stale", {
          sessionId,
          toolCallId,
          decision,
          traceId,
        });
        return;
      }
      const uri = sessionUri(sessionId);
      const cmd =
        decision === "allow"
          ? "workbench.action.chat.acceptTool"
          : "workbench.action.chat.skipTool";
      log.info("actuator.decide", { sessionId, decision, toolCallId, traceId });
      // OPEN the session first, like every other actuator. The command resolves
      // its target with `getWidgetBySessionResource` — which matches only
      // widgets that ALREADY have that session loaded — and returns SILENTLY
      // (no throw, so no `rpc.failed`) when there is none. A remote approval for
      // a session no window happens to be showing was therefore a silent no-op.
      // docs/02.3 §4.20.
      await execute("vscode.open", uri);
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
