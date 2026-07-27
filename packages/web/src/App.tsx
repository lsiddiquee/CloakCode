import { useEffect, useState, type JSX } from "react";
import type { SessionSummary } from "@cloakcode/protocol";
import {
  bridgeUrl,
  fetchSessions,
  isBridgeInsecure,
  subscribeSessionsChanges,
} from "./bridge";
import { onEnrolmentRequired, onNeedsAuth } from "./auth";
import { AuthPrompt } from "./AuthPrompt";
import { EnrolView } from "./EnrolView";
import { ConnectExtensionView } from "./ConnectExtensionView";
import { InsecureBanner } from "./InsecureBanner";
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
  // The instance-id hint from an auth refusal (which paired instance the code is
  // for) — display-only, shown on the OTP prompt / enrol screen (mfa-otp-hint).
  const [authInstanceId, setAuthInstanceId] = useState<string | undefined>();
  const [connectOpen, setConnectOpen] = useState(false);
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

  async function load(opts?: { silent?: boolean }): Promise<void> {
    // A silent refresh (focus/visibility or a manual tap) updates in place —
    // never blank a working list to the loading state (session-list-liveness).
    if (!opts?.silent) setState({ kind: "loading" });
    try {
      const { sessions, gateway } = await fetchSessions();
      setState({
        kind: "ready",
        sessions,
        ...(gateway ? { gateway } : {}),
      });
    } catch (e) {
      // A silent refresh keeps the current list on failure — don't flip a working
      // view to an error on a transient hiccup (the conn dot already signals it).
      if (opts?.silent) return;
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Refresh the list when the app regains focus / becomes visible (e.g. the phone
  // is picked back up) so new sessions appear without a manual reload — silently,
  // so a working list never blanks (session-list-liveness).
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === "visible") void load({ silent: true });
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  // Live list (1B): while the list is showing (authed → ready), keep a socket
  // open and silently refresh on each `sessions.changed` ping, so a new session
  // appears without a manual refresh. Ready-gated so it never runs pre-auth.
  const listReady = state.kind === "ready";
  useEffect(() => {
    if (!listReady) return;
    return subscribeSessionsChanges(() => void load({ silent: true }));
  }, [listReady]);

  // A socket refused with `needsAuth` raises the TOTP prompt; `enrolmentRequired`
  // raises first-run pairing (docs/04, F2a). The refusal's instance-id hint (if
  // any) is stashed for the prompt/enrol screen.
  useEffect(
    () =>
      onNeedsAuth((id) => {
        setAuthInstanceId(id);
        setAuthOpen(true);
      }),
    [],
  );
  useEffect(
    () =>
      onEnrolmentRequired((id) => {
        setAuthInstanceId(id);
        setEnrolOpen(true);
      }),
    [],
  );

  if (enrolOpen) {
    return (
      <EnrolView
        instanceId={authInstanceId}
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
        instanceId={authInstanceId}
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

  if (connectOpen) {
    return <ConnectExtensionView onBack={() => setConnectOpen(false)} />;
  }

  const connected = state.kind === "ready";
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
                } sessions`
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
            <button
              type="button"
              className="menu-action"
              role="menuitem"
              onClick={() => setConnectOpen(true)}
            >
              Connect an extension…
            </button>
          </SettingsMenu>
        )}
        <button
          className="icon-btn"
          onClick={() => void load({ silent: true })}
          title="Refresh sessions"
          aria-label="Refresh sessions"
        >
          ↻
        </button>
        <button
          className="conn"
          onClick={() => void load({ silent: true })}
          title="Refresh"
        >
          <span className={`dot ${connected ? "green" : "grey"}`} />
          {connected ? "connected" : "reconnect"}
        </button>
      </header>

      <InsecureBanner
        aspects={
          isBridgeInsecure()
            ? [
                "This phone’s connection to the gateway is plain http/ws (no tunnel) — anyone on this network can read the session transcript and the answers you send.",
              ]
            : []
        }
      />

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
                            className={`row${s.owned ? "" : " locked"}`}
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
                            {!s.owned && (
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
