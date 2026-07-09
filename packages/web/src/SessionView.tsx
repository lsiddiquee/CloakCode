import { useEffect, useReducer, useRef } from "react";
import type {
  PendingBlocker,
  SessionEvent,
  SessionPart,
  SessionSummary,
} from "@cloakcode/protocol";
import { subscribeSession } from "./bridge";
import { approvalSummary, statusLabel, toolSummary } from "./format";
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
            <PendingCard key={b.toolCallId} blocker={b} />
          ))}
        </footer>
      )}
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

function PendingCard({ blocker }: { blocker: PendingBlocker }): JSX.Element {
  const isQuestion =
    Array.isArray(blocker.confirmations) && blocker.confirmations.length > 0;
  const approval = approvalSummary(blocker.toolName, blocker.input);
  return (
    <div className="blocker pending">
      <span className="blocker-tag">
        <span className="dot amber" /> Needs your input
      </span>
      {isQuestion ? (
        blocker.confirmations?.map((c) => (
          <div key={c.id} className="pending-q">
            <div className="blocker-q">{c.prompt}</div>
            {c.options.map((o) => (
              <div
                key={o.id}
                className={`choice ${o.recommended ? "reco" : ""}`}
              >
                <div className="choice-label">
                  <span>{o.label}</span>
                  {o.recommended && <span className="reco-badge">REC</span>}
                </div>
                {o.detail && <div className="choice-detail">{o.detail}</div>}
              </div>
            ))}
          </div>
        ))
      ) : (
        <div className="blocker-q">
          Approve <strong>{approval.label}</strong>
          {approval.detail && (
            <pre className="pending-cmd">{approval.detail}</pre>
          )}
        </div>
      )}
      <div className="blocker-note">
        Answer in VS Code — remote answering arrives with the actuator.
      </div>
    </div>
  );
}

function dotClass(status: SessionSummary["status"]): string {
  if (status === "blocked") return "amber";
  if (status === "active") return "green";
  return "grey";
}
