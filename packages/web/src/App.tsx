import { useEffect, useState } from "react";
import type { SessionSummary } from "@cloakcode/protocol";
import { bridgeUrl, fetchSessions } from "./bridge";
import { statusLabel } from "./format";
import { SessionView } from "./SessionView";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; sessions: SessionSummary[] };

function groupByWorkspace(
  sessions: SessionSummary[],
): Array<{ instanceId: string; workspace: string; rows: SessionSummary[] }> {
  const map = new Map<
    string,
    { instanceId: string; workspace: string; rows: SessionSummary[] }
  >();
  for (const s of sessions) {
    const key = `${s.instanceId}|${s.workspace}`;
    const g = map.get(key) ?? {
      instanceId: s.instanceId,
      workspace: s.workspace,
      rows: [],
    };
    g.rows.push(s);
    map.set(key, g);
  }
  return [...map.values()];
}

export function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState<SessionSummary | null>(null);

  async function load(): Promise<void> {
    setState({ kind: "loading" });
    try {
      const sessions = await fetchSessions();
      setState({ kind: "ready", sessions });
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
              ? `${state.sessions.length} sessions${
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
          groupByWorkspace(state.sessions).map((group) => (
            <section key={`${group.instanceId}|${group.workspace}`}>
              <div className="group-label">
                workspace {group.workspace} · instance {group.instanceId}
              </div>
              {group.rows.map((s) => (
                <div
                  key={`${s.instanceId}:${s.sessionId}`}
                  className={`row ${s.status === "blocked" ? "blocked" : ""}`}
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
                  {s.status === "blocked" && (
                    <span className="needs">Needs input</span>
                  )}
                </div>
              ))}
            </section>
          ))}
      </main>
    </div>
  );
}

function dotClass(status: SessionSummary["status"]): string {
  if (status === "blocked") return "amber";
  if (status === "active") return "green";
  return "grey";
}
