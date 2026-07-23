import { useEffect, useState, type JSX } from "react";
import type { SessionSummary } from "@cloakcode/protocol";
import { bridgeUrl, fetchSessions } from "./bridge";
import { onEnrolmentRequired, onNeedsAuth } from "./auth";
import { AuthPrompt } from "./AuthPrompt";
import { EnrolView } from "./EnrolView";
import { dotClass, statusLabel } from "./format";
import { groupByWorkspace, isOwnedGroup } from "./grouping";
import { loadPrefs, savePrefs, type SessionListPrefs } from "./prefs";
import { SessionView } from "./SessionView";
import { SettingsMenu, Toggle } from "./SettingsMenu";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; sessions: SessionSummary[]; gateway?: string };

export function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [enrolOpen, setEnrolOpen] = useState(false);
  const [prefs, setPrefs] = useState<SessionListPrefs>(() => loadPrefs());

  // Persist list preferences to the browser whenever they change.
  useEffect(() => savePrefs(prefs), [prefs]);

  function toggleCollapsed(hash: string): void {
    setPrefs((p) => ({
      ...p,
      collapsed: p.collapsed.includes(hash)
        ? p.collapsed.filter((h) => h !== hash)
        : [...p.collapsed, hash],
    }));
  }

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
  // Group once so the app bar (settings menu) and the list share one result.
  const groups = state.kind === "ready" ? groupByWorkspace(state.sessions) : [];
  const readOnlyCount = groups.filter((g) => !isOwnedGroup(g)).length;

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
        {state.kind === "ready" && (
          <SettingsMenu>
            <Toggle
              label="Show read-only workspaces"
              description={
                readOnlyCount === 0
                  ? "none in this environment"
                  : prefs.showReadOnly
                    ? `${readOnlyCount} shown`
                    : `${readOnlyCount} hidden — no local extension`
              }
              checked={prefs.showReadOnly}
              onChange={(next) =>
                setPrefs((p) => ({ ...p, showReadOnly: next }))
              }
            />
            <Toggle
              label="Show workspace ID"
              description="The workspaceStorage folder hash"
              checked={prefs.showWorkspaceId}
              onChange={(next) =>
                setPrefs((p) => ({ ...p, showWorkspaceId: next }))
              }
            />
          </SettingsMenu>
        )}
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
          state.sessions.length > 0 &&
          (() => {
            const collapsed = new Set(prefs.collapsed);
            const visible = groups.filter(
              (g) => prefs.showReadOnly || isOwnedGroup(g),
            );
            return (
              <>
                {visible.map((group) => {
                  const owned = isOwnedGroup(group);
                  const isCollapsed = collapsed.has(group.workspaceHash);
                  return (
                    <section key={group.workspaceHash}>
                      <button
                        type="button"
                        className="group-label"
                        aria-expanded={!isCollapsed}
                        onClick={() => toggleCollapsed(group.workspaceHash)}
                      >
                        <span
                          className={`chevron ${isCollapsed ? "collapsed" : ""}`}
                          aria-hidden="true"
                        >
                          ▾
                        </span>
                        <span className="group-name">
                          workspace {group.workspace}
                          {owned
                            ? ` · ${group.instanceId}`
                            : " · read-only (no extension here)"}
                        </span>
                        <span className="group-count">{group.rows.length}</span>
                      </button>
                      {prefs.showWorkspaceId && (
                        <div
                          className="group-hash"
                          title="workspaceStorage folder"
                        >
                          {group.workspaceHash}
                        </div>
                      )}
                      {!isCollapsed &&
                        group.rows.map((s) => (
                          <div
                            key={s.sessionId}
                            className={`row ${
                              s.status === "blocked" ? "blocked" : ""
                            }${s.owned ? "" : " locked"}`}
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
                                <span>
                                  {statusLabel(s.status, s.idleSeconds)}
                                </span>
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
              </>
            );
          })()}
      </main>
    </div>
  );
}
