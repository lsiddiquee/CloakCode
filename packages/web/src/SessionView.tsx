import { memo, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  Decision,
  PendingBlocker,
  QuestionAnswer,
  SessionEvent,
  SessionPart,
  SessionSummary,
  ToolStatus,
} from "@cloakcode/protocol";
import {
  answerSession,
  decideSession,
  respondSession,
  subscribeSession,
  type ConnState,
} from "./bridge";
import {
  approvalSummary,
  dotClass,
  sessionActivity,
  toolSummary,
} from "./format";
import { Markdown } from "./Markdown";
import { nextScrollAction, readScroll, writeScroll } from "./scroll";

interface ViewState {
  parts: SessionPart[];
  resolved: Set<string>;
  pending: PendingBlocker[];
  error: string | null;
}

type ViewAction =
  | { type: "batch"; events: SessionEvent[] }
  | { type: "error"; message: string }
  | { type: "pending"; blockers: PendingBlocker[] };

/**
 * Fold a batch of session events into the view state in one pass. Opening a long
 * session replays its whole backlog as many discrete events; coalescing them
 * (see the subscribe effect) and applying them together rebuilds the parts array
 * at most once per batch instead of once per event — the difference between an
 * O(n) and an O(n²) open. Appends dedupe by id (a reconnect may resume with
 * overlap); status updates fold so the array is mapped at most once. Returns the
 * same reference when nothing effectively changed, so React can skip the render.
 */
export function applyEvents(
  state: ViewState,
  events: SessionEvent[],
): ViewState {
  if (events.length === 0) return state;
  const seen = new Set(state.parts.map((p) => p.id));
  let appended: SessionPart[] | null = null;
  let resolved: Set<string> | null = null;
  let statusUpdates: Map<string, ToolStatus> | null = null;

  for (const e of events) {
    if (e.type === "append") {
      if (seen.has(e.part.id)) continue;
      seen.add(e.part.id);
      (appended ??= []).push(e.part);
    } else if (e.type === "resolve") {
      (resolved ??= new Set(state.resolved)).add(e.id);
    } else {
      (statusUpdates ??= new Map()).set(e.id, e.status);
    }
  }

  let parts = appended ? [...state.parts, ...appended] : state.parts;
  if (statusUpdates) {
    const updates = statusUpdates;
    parts = parts.map((p) => {
      if (p.kind !== "toolCall") return p;
      const next = updates.get(p.id);
      return next ? { ...p, status: next } : p;
    });
  }
  if (parts === state.parts && !resolved) return state;
  return { ...state, parts, resolved: resolved ?? state.resolved };
}

function reducer(state: ViewState, action: ViewAction): ViewState {
  if (action.type === "error") return { ...state, error: action.message };
  if (action.type === "pending") return { ...state, pending: action.blockers };
  return applyEvents(state, action.events);
}

export function SessionView({
  session,
  onBack,
}: {
  session: SessionSummary;
  onBack: () => void;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, {
    parts: [],
    resolved: new Set<string>(),
    pending: [],
    error: null,
  });
  const [conn, setConn] = useState<ConnState>("connecting");

  // Coalesce the event stream. A long transcript replays as many discrete
  // events; buffering them and applying one batch per animation frame turns N
  // renders (and N markdown re-parses + layouts) into ~1 — the difference
  // between a snappy and an unusable open. Live events past the backlog still
  // flush within a frame, so the mirror stays effectively real-time.
  useEffect(() => {
    const buffer: SessionEvent[] = [];
    let raf: number | null = null;
    const flush = (): void => {
      raf = null;
      if (buffer.length > 0)
        dispatch({ type: "batch", events: buffer.splice(0) });
    };
    const unsubscribe = subscribeSession(
      { sessionId: session.sessionId },
      (event) => {
        buffer.push(event);
        if (raf === null) raf = requestAnimationFrame(flush);
      },
      (blockers) => dispatch({ type: "pending", blockers }),
      (message) => dispatch({ type: "error", message }),
      setConn,
    );
    return () => {
      unsubscribe();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [session.sessionId]);

  // Stick-to-bottom: follow the latest message unless the user scrolled up.
  // A ResizeObserver on the inner content re-pins on any growth — including the
  // markdown/table reflow after the initial load, which a parts-effect misses
  // (that's why it opened at the top).
  const scrollRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const restoredRef = useRef(false);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    // Release stick ONLY when the user scrolls UP. Content growing below (which
    // increases distance-to-bottom during progressive markdown/table reflow)
    // must not unstick, or the view strands mid-transcript on load. Re-stick when
    // the user returns near the bottom.
    if (top < lastTopRef.current - 4) {
      stickRef.current = false;
    } else if (el.scrollHeight - top - el.clientHeight < 80) {
      stickRef.current = true;
    }
    lastTopRef.current = top;
    writeScroll(session.sessionId, { top, atBottom: stickRef.current });
  };

  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    restoredRef.current = false;
    const saved = readScroll(session.sessionId);
    const settle = (): void => {
      const action = nextScrollAction({
        saved,
        restored: restoredRef.current,
        stick: stickRef.current,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
      switch (action.kind) {
        case "wait":
          return; // content not tall enough yet; a later growth retries
        case "restore":
          restoredRef.current = true;
          stickRef.current = false;
          el.scrollTop = action.top;
          break;
        case "stick":
          restoredRef.current = true;
          el.scrollTop = el.scrollHeight;
          break;
        case "none":
          restoredRef.current = true;
          return;
      }
      lastTopRef.current = el.scrollTop;
    };
    settle();
    const ro = new ResizeObserver(settle);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [session.sessionId]);

  const activity = useMemo(
    () =>
      sessionActivity(
        state.pending,
        state.parts,
        state.resolved,
        session.status,
        session.idleSeconds,
      ),
    [
      state.pending,
      state.parts,
      state.resolved,
      session.status,
      session.idleSeconds,
    ],
  );
  // Foreign workspace (no live extension here) => observe-only. Actuation is
  // gated in the UI; a receiving-side guard lands with the gateway (docs/03).
  const readOnly = !session.owned;

  return (
    <div className="app">
      <header className="appbar">
        <button className="icon-btn" onClick={onBack} title="Back">
          ‹
        </button>
        <div className="title">
          {session.title}
          <div className="sub">
            workspace {session.workspace} · session{" "}
            <span title={session.sessionId}>
              {session.sessionId.slice(0, 8)}
            </span>{" "}
            · {session.instanceId}
          </div>
        </div>
        <span className="conn">
          <span
            className={`dot ${activity.awaiting ? "amber" : dotClass(session.status)}`}
          />
          {activity.label}
        </span>
      </header>

      {conn !== "open" && (
        <div className={`conn-banner ${conn}`}>
          {conn === "closed"
            ? "Disconnected"
            : conn === "reconnecting"
              ? "Reconnecting…"
              : "Connecting…"}
        </div>
      )}

      <main
        className="content transcript"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        <div className="transcript-inner" ref={innerRef}>
          {state.error && <p className="hint dim">stream: {state.error}</p>}
          {state.parts.length === 0 && !state.error && (
            <p className="hint">Loading transcript…</p>
          )}
          {state.parts.map((part) => (
            <Part
              key={part.id}
              part={part}
              resolved={state.resolved.has(part.id)}
            />
          ))}
        </div>
      </main>

      {!readOnly && state.pending.length > 0 && (
        <footer className="pending-overlay">
          {state.pending.map((b) => (
            <PendingCard key={b.toolCallId} blocker={b} session={session} />
          ))}
        </footer>
      )}
      {readOnly ? (
        <p className="readonly-banner">
          Read-only — no CloakCode extension is running in this workspace, so
          you can view the transcript but not send, answer, or approve.
        </p>
      ) : (
        <ChatComposer session={session} />
      )}
    </div>
  );
}

const Part = memo(function Part({
  part,
  resolved,
}: {
  part: SessionPart;
  resolved: boolean;
}): JSX.Element {
  switch (part.kind) {
    case "userMessage":
      return (
        <>
          <div className="turn-label">You</div>
          <Markdown text={part.text} className="bubble-user markdown-body" />
        </>
      );
    case "thinking":
      return (
        <div className="thinking">
          <span>▸</span> {part.text}
        </div>
      );
    case "markdown":
      return <Markdown text={part.text} />;
    case "toolCall": {
      const summary = toolSummary(part.name, part.input);
      return (
        <div className="card-tool" title={part.name}>
          <div className="head">
            <span className="tlabel">{summary.label}</span>
            {summary.detail && (
              <span className="tdetail">{summary.detail}</span>
            )}
            <span className={`status ${part.status}`}>{part.status}</span>
          </div>
        </div>
      );
    }
    case "confirmation":
      return (
        <div className={`blocker ${resolved ? "resolved" : ""}`}>
          <span className="blocker-tag">
            <span className="dot amber" />{" "}
            {resolved ? "Answered" : "Needs your input"}
          </span>
          <div className="blocker-q">{part.prompt}</div>
          {part.options.map((o) => (
            <div key={o.id} className={`choice ${o.recommended ? "reco" : ""}`}>
              <div className="choice-label">
                <span>{o.label}</span>
                {o.recommended && <span className="reco-badge">REC</span>}
              </div>
              {o.detail && <div className="choice-detail">{o.detail}</div>}
            </div>
          ))}
          {!resolved && (
            <div className="blocker-note">
              View-only for now — answering arrives with the actuator.
            </div>
          )}
        </div>
      );
  }
});

/**
 * Shared send state for remote-operator text (a blocker answer or a free chat
 * message). Resets `sending` on BOTH success and failure (via `finally`) and
 * exposes `sent`, so callers never get stuck on a "Sending…" state.
 */
function useRemoteSend(session: SessionSummary): {
  sending: boolean;
  error: string | null;
  sent: boolean;
  send: (text: string, toolCallId?: string) => Promise<boolean>;
} {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const send = async (text: string, toolCallId?: string): Promise<boolean> => {
    setSending(true);
    setError(null);
    try {
      await respondSession({
        sessionId: session.sessionId,
        text,
        ...(toolCallId ? { toolCallId } : {}),
      });
      setSent(true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSending(false);
    }
  };
  return { sending, error, sent, send };
}

/**
 * Approve/deny state for one pending tool call. Records the verdict once (buttons
 * lock after) via `decideSession`; the extension host dispatches it to VS Code's
 * native confirmation via the acceptTool/skipTool command.
 */
function useDecide(session: SessionSummary): {
  deciding: boolean;
  decided: Decision | null;
  error: string | null;
  decide: (toolCallId: string, decision: Decision) => Promise<void>;
} {
  const [deciding, setDeciding] = useState(false);
  const [decided, setDecided] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (
    toolCallId: string,
    decision: Decision,
  ): Promise<void> => {
    setDeciding(true);
    setError(null);
    try {
      await decideSession({
        sessionId: session.sessionId,
        toolCallId,
        decision,
      });
      setDecided(decision);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeciding(false);
    }
  };
  return { deciding, decided, error, decide };
}

/**
 * Structured-answer state for one pending question carousel. Delivers the
 * operator's per-question selections via `answerSession` (which the extension
 * resolves through `_chat.notifyQuestionCarouselAnswer`) — the proper structured
 * answer, not a chat message that cancels the carousel (docs/02 §4.16).
 */
function useAnswer(session: SessionSummary): {
  sending: boolean;
  error: string | null;
  sent: boolean;
  answer: (toolCallId: string, answers: QuestionAnswer[]) => Promise<void>;
} {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const answer = async (
    toolCallId: string,
    answers: QuestionAnswer[],
  ): Promise<void> => {
    setSending(true);
    setError(null);
    try {
      await answerSession({
        sessionId: session.sessionId,
        toolCallId,
        answers,
      });
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };
  return { sending, error, sent, answer };
}

function PendingCard({
  blocker,
  session,
}: {
  blocker: PendingBlocker;
  session: SessionSummary;
}): JSX.Element {
  const confirmations = blocker.confirmations ?? [];
  const isQuestion = confirmations.length > 0;
  const total = confirmations.length;
  const approval = approvalSummary(blocker.toolName, blocker.input);

  // Per-question answer: chosen option labels (more than one for multi-select)
  // plus any freeform text.
  const [answers, setAnswers] = useState<
    Array<{ selected: string[]; freeText: string }>
  >([]);
  // One-question-at-a-time stepper index (docs/05 “one-question-at-a-time”): a
  // multi-question `vscode_askQuestions` blocker steps through its questions
  // instead of stacking them, mirroring the VS Code picker.
  const [step, setStep] = useState(0);
  const { sending, error, sent, answer } = useAnswer(session);
  const decision = useDecide(session);

  const getAns = (i: number): { selected: string[]; freeText: string } =>
    answers[i] ?? { selected: [], freeText: "" };
  const patch = (
    i: number,
    p: Partial<{ selected: string[]; freeText: string }>,
  ): void =>
    setAnswers((prev) => {
      const next = [...prev];
      next[i] = { ...getAns(i), ...p };
      return next;
    });
  // Single-select replaces the choice; multi-select toggles the label in/out.
  const toggle = (i: number, label: string, multi: boolean): void => {
    const cur = getAns(i).selected;
    patch(i, {
      selected: multi
        ? cur.includes(label)
          ? cur.filter((x) => x !== label)
          : [...cur, label]
        : [label],
    });
  };

  const structuredAnswers: QuestionAnswer[] = confirmations.map((c, qi) => {
    const a = getAns(qi);
    return {
      selected: a.selected,
      freeText: a.freeText || null,
      ...(c.multiSelect ? { multiSelect: true } : {}),
    };
  });
  const canSend =
    isQuestion &&
    confirmations.every((_, qi) => {
      const a = getAns(qi);
      return a.selected.length > 0 || a.freeText.trim() !== "";
    }) &&
    !sending &&
    !sent;
  // Whether the CURRENT question has an answer (gates “Next”).
  const curAnswered =
    getAns(step).selected.length > 0 || getAns(step).freeText.trim() !== "";

  return (
    <div className="blocker pending">
      <span className="blocker-tag">
        <span className="dot amber" /> Needs your input
      </span>
      {isQuestion ? (
        <>
          {total > 1 && (
            <div className="pending-progress">
              Question {step + 1} of {total}
            </div>
          )}
          {confirmations
            .filter((_, qi) => qi === step)
            .map((c) => (
              <div key={c.id} className="pending-q">
                <div className="blocker-q">{c.prompt}</div>
                {c.options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={`choice choice-btn ${o.recommended ? "reco" : ""} ${
                      getAns(step).selected.includes(o.label) ? "chosen" : ""
                    }`}
                    onClick={() =>
                      toggle(step, o.label, c.multiSelect ?? false)
                    }
                    disabled={sending}
                  >
                    <div className="choice-label">
                      <span>{o.label}</span>
                      {o.recommended && <span className="reco-badge">REC</span>}
                    </div>
                    {o.detail && (
                      <div className="choice-detail">{o.detail}</div>
                    )}
                  </button>
                ))}
                {c.allowFreeform && (
                  <input
                    className="pending-freeform"
                    type="text"
                    placeholder="Type a custom answer…"
                    value={getAns(step).freeText}
                    disabled={sending}
                    onChange={(e) => patch(step, { freeText: e.target.value })}
                  />
                )}
              </div>
            ))}
          {error && <div className="pending-error">send failed: {error}</div>}
          <div className="pending-nav">
            {step > 0 && (
              <button
                type="button"
                className="pending-back"
                onClick={() => setStep((s) => s - 1)}
                disabled={sending}
              >
                Back
              </button>
            )}
            {step < total - 1 ? (
              <button
                type="button"
                className="pending-next"
                onClick={() => setStep((s) => s + 1)}
                disabled={!curAnswered || sending}
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                className="pending-send"
                onClick={() =>
                  void answer(
                    blocker.resolveId ?? blocker.toolCallId,
                    structuredAnswers,
                  )
                }
                disabled={!canSend}
              >
                {sent ? "Answer sent ✓" : sending ? "Sending…" : "Send answer"}
              </button>
            )}
          </div>
          <div className="blocker-note">
            {sent
              ? "Answer delivered. If VS Code already auto-answered, this had no effect."
              : "Heads up: VS Code may auto-answer this itself; if it already did, your answer does nothing."}
          </div>
        </>
      ) : blocker.awaitingDecision ? (
        <>
          <div className="blocker-q">
            Approve <strong>{approval.label}</strong>
            {approval.detail && (
              <pre className="pending-cmd">{approval.detail}</pre>
            )}
          </div>
          {decision.error && (
            <div className="pending-error">decide failed: {decision.error}</div>
          )}
          <div className="approve-row">
            <button
              type="button"
              className="approve-btn deny"
              onClick={() => void decision.decide(blocker.toolCallId, "deny")}
              disabled={decision.deciding || decision.decided !== null}
            >
              {decision.decided === "deny" ? "Denied ✓" : "Deny"}
            </button>
            <button
              type="button"
              className="approve-btn allow"
              onClick={() => void decision.decide(blocker.toolCallId, "allow")}
              disabled={decision.deciding || decision.decided !== null}
            >
              {decision.decided === "allow"
                ? "Allowed ✓"
                : decision.deciding
                  ? "…"
                  : "Allow"}
            </button>
          </div>
          <div className="blocker-note">
            {decision.decided
              ? "Sent to VS Code. If it was already auto-approved, this had no effect."
              : "Heads up: VS Code may auto-approve this itself; if it already did, your tap does nothing."}
          </div>
        </>
      ) : (
        <>
          <div className="blocker-q">
            Approve <strong>{approval.label}</strong>
            {approval.detail && (
              <pre className="pending-cmd">{approval.detail}</pre>
            )}
          </div>
          <div className="blocker-note">
            Approve in VS Code — take control to approve from here.
          </div>
        </>
      )}
    </div>
  );
}

function ChatComposer({ session }: { session: SessionSummary }): JSX.Element {
  const [msg, setMsg] = useState("");
  const { sending, error, send } = useRemoteSend(session);

  const submit = async (): Promise<void> => {
    const text = msg.trim();
    if (text.length === 0 || sending) return;
    if (await send(text)) setMsg("");
  };

  return (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {error && <div className="pending-error">send failed: {error}</div>}
      <div className="chat-composer-row">
        <input
          className="chat-input"
          type="text"
          placeholder="Message the active chat…"
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          disabled={sending}
        />
        <button
          type="submit"
          className="chat-send"
          disabled={sending || msg.trim().length === 0}
        >
          {sending ? "…" : "Send"}
        </button>
      </div>
      <div className="blocker-note">
        Sends to the active chat in VS Code (remote-operator).
      </div>
    </form>
  );
}
