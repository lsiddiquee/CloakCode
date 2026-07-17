import { useEffect, useState } from "react";
import type { SessionSummary } from "@cloakcode/protocol";
import { bridgeUrl, fetchSessions } from "./bridge";
import { onEnrolmentRequired, onNeedsAuth } from "./auth";
import { AuthPrompt } from "./AuthPrompt";
import { EnrolView } from "./EnrolView";
import { dotClass, statusLabel } from "./format";
import { groupByWorkspace } from "./grouping";
import { SessionView } from "./SessionView";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; sessions: SessionSummary[]; gateway?: string };

export function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [enrolOpen, setEnrolOpen] = useState(false);

  async function load(): Promise<void> {
    setState({ kind: "loading" });
    try {
      const { sessions, gateway } = await fetchSessions();
      setState({
        kind: "ready",
        sessions,
        ...(gateway ? { gateway } : {}),
      });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // A socket refused with `needsAuth` raises the TOTP prompt; `enrolmentRequired`
  // raises first-run pairing (docs/04, F2a).
  useEffect(() => onNeedsAuth(() => setAuthOpen(true)), []);
  useEffect(() => onEnrolmentRequired(() => setEnrolOpen(true)), []);

  if (enrolOpen) {
    return (
      <EnrolView
        onDone={() => {
          setEnrolOpen(false);
          setSelected(null);
          void load();
        }}
      />
    );
  }

  if (authOpen) {
    return (
      <AuthPrompt
        onDone={() => {
          setAuthOpen(false);
          setSelected(null);
          void load();
        }}
      />
    );
  }

  if (selected) {
    return <SessionView session={selected} onBack={() => setSelected(null)} />;
  }

  const connected = state.kind === "ready";
  const blockedCount =
    state.kind === "ready"
      ? state.sessions.filter((s) => s.status === "blocked").length
      : 0;

  return (
    <div className="app">
      <header className="appbar">
        <div className="title">
          CloakCode
          <div className="sub">
            {state.kind === "ready"
              ? `${state.gateway ? `${state.gateway} · ` : ""}${
                  state.sessions.length
                } sessions${
                  blockedCount ? ` · ${blockedCount} needs input` : ""
                }`
              : state.kind === "loading"
                ? "connecting…"
                : "offline"}
          </div>
        </div>
        <button className="conn" onClick={() => void load()} title="Refresh">
          <span className={`dot ${connected ? "green" : "grey"}`} />
          {connected ? "connected" : "reconnect"}
        </button>
      </header>

      <main className="content">
        {state.kind === "loading" && (
          <p className="hint">Reaching the bridge…</p>
        )}

        {state.kind === "error" && (
          <div className="empty">
            <p className="hint">Can’t reach the bridge at {bridgeUrl()}.</p>
            <p className="hint dim">{state.message}</p>
            <button className="btn" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}

        {state.kind === "ready" && state.sessions.length === 0 && (
          <p className="hint">
            No Copilot sessions found in this environment yet.
          </p>
        )}

        {state.kind === "ready" &&
          groupByWorkspace(state.sessions).map((group) => {
            const owned = group.rows.every((s) => s.owned);
            return (
              <section key={group.workspaceHash}>
                <div className="group-label">
                  workspace {group.workspace}
                  {owned
                    ? ` · ${group.instanceId}`
                    : " · read-only (no extension here)"}
                </div>
                {group.rows.map((s) => (
                  <div
                    key={s.sessionId}
                    className={`row ${s.status === "blocked" ? "blocked" : ""}${
                      s.owned ? "" : " locked"
                    }`}
                    onClick={() => setSelected(s)}
                  >
                    <span className={`dot ${dotClass(s.status)}`} />
                    <div className="body">
                      <div className="name">{s.title}</div>
                      <div className="meta">
                        <span title={`session ${s.sessionId}`}>
                          session {s.sessionId.slice(0, 8)}
                        </span>
                        <span>·</span>
                        <span>{s.turns} turns</span>
                        <span>·</span>
                        <span>{statusLabel(s.status, s.idleSeconds)}</span>
                      </div>
                    </div>
                    {s.owned ? (
                      s.status === "blocked" && (
                        <span className="needs">Needs input</span>
                      )
                    ) : (
                      <span className="needs locked">read-only</span>
                    )}
                  </div>
                ))}
              </section>
            );
          })}
      </main>
    </div>
  );
}
