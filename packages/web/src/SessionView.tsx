import { useEffect, useReducer, useRef, useState } from "react";
import type {
  Decision,
  PendingBlocker,
  SessionEvent,
  SessionPart,
  SessionSummary,
} from "@cloakcode/protocol";
import {
  controlSession,
  decideSession,
  respondSession,
  subscribeSession,
} from "./bridge";
import {
  approvalSummary,
  buildAnswerText,
  statusLabel,
  toolSummary,
} from "./format";
import { Markdown } from "./Markdown";

interface ViewState {
  parts: SessionPart[];
  resolved: Set<string>;
  pending: PendingBlocker[];
  error: string | null;
}

type ViewAction =
  | SessionEvent
  | { type: "error"; message: string }
  | { type: "pending"; blockers: PendingBlocker[] };

function reducer(state: ViewState, action: ViewAction): ViewState {
  if (action.type === "error") return { ...state, error: action.message };
  if (action.type === "pending") return { ...state, pending: action.blockers };
  if (action.type === "append") {
    if (state.parts.some((p) => p.id === action.part.id)) return state;
    return { ...state, parts: [...state.parts, action.part] };
  }
  if (action.type === "resolve") {
    const resolved = new Set(state.resolved);
    resolved.add(action.id);
    return { ...state, resolved };
  }
  // updateStatus
  return {
    ...state,
    parts: state.parts.map((p) =>
      p.kind === "toolCall" && p.id === action.id
        ? { ...p, status: action.status }
        : p,
    ),
  };
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

  const control = useControl(session);

  useEffect(() => {
    const unsubscribe = subscribeSession(
      { instanceId: session.instanceId, sessionId: session.sessionId },
      (event) => dispatch(event),
      (blockers) => dispatch({ type: "pending", blockers }),
      (message) => dispatch({ type: "error", message }),
    );
    return unsubscribe;
  }, [session.instanceId, session.sessionId]);

  // Stick-to-bottom: follow the latest message unless the user scrolled up.
  // A ResizeObserver on the inner content re-pins on any growth — including the
  // markdown/table reflow after the initial load, which a parts-effect misses
  // (that's why it opened at the top).
  const scrollRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const toBottom = (): void => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(toBottom);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const awaiting =
    state.pending.length > 0 ||
    state.parts.some(
      (p) => p.kind === "confirmation" && !state.resolved.has(p.id),
    );

  return (
    <div className="app">
      <header className="appbar">
        <button className="icon-btn" onClick={onBack} title="Back">
          ‹
        </button>
        <div className="title">
          {session.title}
          <div className="sub">
            {session.workspace} · {session.instanceId}
          </div>
        </div>
        <span className="conn">
          <span
            className={`dot ${awaiting ? "amber" : dotClass(session.status)}`}
          />
          {awaiting
            ? "awaiting input"
            : statusLabel(session.status, session.idleSeconds)}
        </span>
      </header>

      <div className={`control-bar ${control.control ? "on" : ""}`}>
        <button
          type="button"
          className="control-toggle"
          onClick={() => void control.toggle()}
          disabled={control.pending}
        >
          {control.pending
            ? "…"
            : control.control
              ? "\u25c9 In control"
              : "\u25cb Take control"}
        </button>
        <span className="control-hint">
          {control.error
            ? control.error
            : control.control
              ? "Holding confirmable tool calls for your approval"
              : "VS Code drives approvals (native)"}
        </span>
      </div>

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

      {state.pending.length > 0 && (
        <footer className="pending-overlay">
          {state.pending.map((b) => (
            <PendingCard key={b.toolCallId} blocker={b} session={session} />
          ))}
        </footer>
      )}
      <ChatComposer session={session} />
    </div>
  );
}

function Part({
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
}

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
        instanceId: session.instanceId,
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
 * Take-control toggle state for one session. Flips on ack; `pending` guards the
 * button and `error` surfaces a failed toggle. The blocking hook reads the
 * resulting on-disk policy (see the extension's `setControl`).
 */
function useControl(session: SessionSummary): {
  control: boolean;
  pending: boolean;
  error: string | null;
  toggle: () => Promise<void>;
} {
  const [control, setControl] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (): Promise<void> => {
    const next = !control;
    setPending(true);
    setError(null);
    try {
      await controlSession({
        instanceId: session.instanceId,
        sessionId: session.sessionId,
        control: next,
      });
      setControl(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  return { control, pending, error, toggle };
}

/**
 * Approve/deny state for one held tool call. Records the verdict once (buttons
 * lock after) via `decideSession`, which the extension writes as the hook's
 * on-disk decision file to unblock the held PreToolUse.
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
        instanceId: session.instanceId,
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

function PendingCard({
  blocker,
  session,
}: {
  blocker: PendingBlocker;
  session: SessionSummary;
}): JSX.Element {
  const confirmations = blocker.confirmations ?? [];
  const isQuestion = confirmations.length > 0;
  const approval = approvalSummary(blocker.toolName, blocker.input);

  // One chosen answer per question (option label or freeform text).
  const [answers, setAnswers] = useState<Array<string | undefined>>([]);
  const { sending, error, sent, send } = useRemoteSend(session);
  const decision = useDecide(session);

  const setAnswer = (i: number, value: string): void =>
    setAnswers((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });

  const text = buildAnswerText(
    confirmations.map((c, qi) => ({
      question: c.prompt,
      answer: answers[qi] ?? "",
    })),
  );
  const canSend = isQuestion && text.length > 0 && !sending && !sent;

  return (
    <div className="blocker pending">
      <span className="blocker-tag">
        <span className="dot amber" /> Needs your input
      </span>
      {isQuestion ? (
        <>
          {confirmations.map((c, qi) => (
            <div key={c.id} className="pending-q">
              <div className="blocker-q">{c.prompt}</div>
              {c.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`choice choice-btn ${o.recommended ? "reco" : ""} ${
                    answers[qi] === o.label ? "chosen" : ""
                  }`}
                  onClick={() => setAnswer(qi, o.label)}
                  disabled={sending}
                >
                  <div className="choice-label">
                    <span>{o.label}</span>
                    {o.recommended && <span className="reco-badge">REC</span>}
                  </div>
                  {o.detail && <div className="choice-detail">{o.detail}</div>}
                </button>
              ))}
              {c.allowFreeform && (
                <input
                  className="pending-freeform"
                  type="text"
                  placeholder="Type a custom answer…"
                  disabled={sending}
                  onChange={(e) => setAnswer(qi, e.target.value)}
                />
              )}
            </div>
          ))}
          {error && <div className="pending-error">send failed: {error}</div>}
          <button
            type="button"
            className="pending-send"
            onClick={() => void send(text, blocker.toolCallId)}
            disabled={!canSend}
          >
            {sent ? "Answer sent ✓" : sending ? "Sending…" : "Send answer"}
          </button>
          <div className="blocker-note">
            {sent
              ? "Sent to the active chat — waiting for VS Code to pick it up."
              : "Sends to the active chat in VS Code (remote-operator)."}
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
              ? "Sent — the held tool call will resume in VS Code."
              : "You're in control — allow or deny this tool call."}
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

function dotClass(status: SessionSummary["status"]): string {
  if (status === "blocked") return "amber";
  if (status === "active") return "green";
  return "grey";
}
