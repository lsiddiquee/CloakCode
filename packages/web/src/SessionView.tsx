import { useEffect, useReducer } from "react";
import type { SessionEvent, SessionPart, SessionSummary } from "@cloakcode/protocol";
import { subscribeSession } from "./bridge";
import { statusLabel } from "./format";

interface ViewState {
  parts: SessionPart[];
  error: string | null;
}

function reducer(state: ViewState, action: SessionEvent | { type: "error"; message: string }): ViewState {
  if (action.type === "error") return { ...state, error: action.message };
  if (action.type === "append") {
    if (state.parts.some((p) => p.id === action.part.id)) return state;
    return { ...state, parts: [...state.parts, action.part] };
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
  const [state, dispatch] = useReducer(reducer, { parts: [], error: null });

  useEffect(() => {
    const unsubscribe = subscribeSession(
      { instanceId: session.instanceId, sessionId: session.sessionId },
      (event) => dispatch(event),
      (message) => dispatch({ type: "error", message }),
    );
    return unsubscribe;
  }, [session.instanceId, session.sessionId]);

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
          <span className={`dot ${dotClass(session.status)}`} />
          {statusLabel(session.status, session.idleSeconds)}
        </span>
      </header>

      <main className="content transcript">
        {state.error && <p className="hint dim">stream: {state.error}</p>}
        {state.parts.length === 0 && !state.error && (
          <p className="hint">Loading transcript…</p>
        )}
        {state.parts.map((part) => (
          <Part key={part.id} part={part} />
        ))}
      </main>
    </div>
  );
}

function Part({ part }: { part: SessionPart }): JSX.Element {
  switch (part.kind) {
    case "userMessage":
      return (
        <>
          <div className="turn-label">You</div>
          <div className="bubble-user">{part.text}</div>
        </>
      );
    case "thinking":
      return (
        <div className="thinking">
          <span>▸</span> {part.text}
        </div>
      );
    case "markdown":
      return <div className="assistant">{part.text}</div>;
    case "toolCall":
      return (
        <div className="card-tool">
          <div className="head">
            <span className="tname">{part.name}</span>
            <span className={`status ${part.status}`}>{part.status}</span>
          </div>
        </div>
      );
  }
}

function dotClass(status: SessionSummary["status"]): string {
  if (status === "blocked") return "amber";
  if (status === "active") return "green";
  return "grey";
}
