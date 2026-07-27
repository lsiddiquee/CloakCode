import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type JSX,
} from "react";
import type {
  Decision,
  PendingBlocker,
  QuestionAnswer,
  SessionEvent,
  SessionPart,
  SessionStatus,
  SessionSummary,
  ToolStatus,
  UsageSummary,
  UsageTotals,
} from "@cloakcode/protocol";
import {
  answerSession,
  decideSession,
  fetchHistory,
  respondSession,
  steerSession,
  stopSession,
  subscribeSession,
  type ConnState,
} from "./bridge";
import {
  answerSummary,
  approvalSummary,
  dotClass,
  sessionActivity,
  toolSummary,
} from "./format";
import { Markdown } from "./Markdown";
import { nextScrollAction, readScroll, writeScroll } from "./scroll";
import { compactTokens, formatAiu, interleaveTurnUsage } from "./telemetry";

/**
 * Idle-age (seconds) under which a followed session reads "active" — matches the
 * scanner's liveness window (docs/02.2) so the header agrees with the list.
 */
const LIVE_WINDOW_SECONDS = 120;

interface ViewState {
  parts: SessionPart[];
  resolved: Set<string>;
  pending: PendingBlocker[];
  error: string | null;
  inTurn: boolean;
  /**
   * Epoch ms of the last LIVE turn transition, seeded from the summary's
   * `idleSeconds`. Drives a fresh active/idle header while following, since the
   * `session` prop is a frozen open-time snapshot (App never refreshes it).
   */
  lastActivityAt: number;
  /**
   * Windowing watermarks (docs/02.6 "wire windowing"): `lowSeq` = the lowest
   * event seq held — page older via `session.history` while it is finite and
   * `> 0`; `highSeq` = the next expected seq (the resume point, cached so
   * back→re-select resumes instead of refetching from 0). `lowSeq` starts at
   * +Infinity (nothing held yet).
   */
  lowSeq: number;
  highSeq: number;
  /**
   * Session usage TOTAL, computed SERVER-SIDE over the whole log and pushed via
   * the `usage` subscribe frame (docs/02.6 §4.32) — so it's correct even though
   * the client holds only the tail window. `null` until the first frame / when
   * the session has no telemetry.
   */
  usage: UsageSummary | null;
}

type ViewAction =
  | { type: "batch"; events: SessionEvent[] }
  | { type: "prepend"; events: SessionEvent[] }
  | { type: "error"; message: string }
  | { type: "pending"; blockers: PendingBlocker[] }
  | { type: "turn"; inTurn: boolean }
  | { type: "usage"; usage: UsageSummary }
  | { type: "reset" };

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
  let lowSeq = state.lowSeq;
  let highSeq = state.highSeq;

  for (const e of events) {
    if (e.seq < lowSeq) lowSeq = e.seq;
    if (e.seq + 1 > highSeq) highSeq = e.seq + 1;
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
  if (
    parts === state.parts &&
    !resolved &&
    lowSeq === state.lowSeq &&
    highSeq === state.highSeq
  )
    return state;
  return {
    ...state,
    parts,
    resolved: resolved ?? state.resolved,
    lowSeq,
    highSeq,
  };
}

/**
 * Prepend an OLDER page (from `session.history`) ahead of the held parts — the
 * scroll-up lazy-load. The page is ascending-seq and entirely older than
 * `state.lowSeq`, so `[...older, ...parts]` keeps global order; only `lowSeq`
 * moves (the `highSeq` ceiling is unchanged). Dedupes by id and folds any
 * resolve/status the page carries. Same-ref when nothing changed.
 */
export function prependEvents(
  state: ViewState,
  events: SessionEvent[],
): ViewState {
  if (events.length === 0) return state;
  const seen = new Set(state.parts.map((p) => p.id));
  const older: SessionPart[] = [];
  let resolved: Set<string> | null = null;
  let statusUpdates: Map<string, ToolStatus> | null = null;
  let lowSeq = state.lowSeq;

  for (const e of events) {
    if (e.seq < lowSeq) lowSeq = e.seq;
    if (e.type === "append") {
      if (seen.has(e.part.id)) continue;
      seen.add(e.part.id);
      older.push(e.part);
    } else if (e.type === "resolve") {
      (resolved ??= new Set(state.resolved)).add(e.id);
    } else {
      (statusUpdates ??= new Map()).set(e.id, e.status);
    }
  }

  let parts = older.length ? [...older, ...state.parts] : state.parts;
  if (statusUpdates) {
    const updates = statusUpdates;
    parts = parts.map((p) => {
      if (p.kind !== "toolCall") return p;
      const next = updates.get(p.id);
      return next ? { ...p, status: next } : p;
    });
  }
  if (parts === state.parts && !resolved && lowSeq === state.lowSeq)
    return state;
  return { ...state, parts, resolved: resolved ?? state.resolved, lowSeq };
}

function reducer(state: ViewState, action: ViewAction): ViewState {
  if (action.type === "error") return { ...state, error: action.message };
  if (action.type === "pending") return { ...state, pending: action.blockers };
  if (action.type === "turn")
    return action.inTurn === state.inTurn
      ? state
      : { ...state, inTurn: action.inTurn, lastActivityAt: Date.now() };
  if (action.type === "usage") return { ...state, usage: action.usage };
  if (action.type === "reset")
    // The tailed SOURCE changed (rotation, or the debug-log appeared post-
    // rehydration — docs/02.6 §4.32, §4.22/§4.23). Drop the loaded window; the
    // subscribe effect re-runs (nonce) and re-resolves the source from scratch.
    return {
      ...state,
      parts: [],
      resolved: new Set<string>(),
      pending: [],
      lowSeq: Number.POSITIVE_INFINITY,
      highSeq: 0,
      usage: null,
    };
  if (action.type === "prepend") return prependEvents(state, action.events);
  return applyEvents(state, action.events);
}

/** Events requested on a fresh open (the tail window) and per "Load older" page. */
const INITIAL_WINDOW = 150;
const HISTORY_PAGE = 100;

interface CachedSession {
  parts: SessionPart[];
  resolved: Set<string>;
  lowSeq: number;
  highSeq: number;
  usage: UsageSummary | null;
}

/**
 * In-memory per-session window cache (wire-bandwidth #5). Module-scoped so it
 * SURVIVES SessionView unmount — back→re-select restores the parts already
 * loaded and the subscribe resumes from `highSeq` instead of refetching from
 * seq 0. Cleared on a full page reload (then a small `limit` tail re-fetch).
 */
const sessionCache = new Map<string, CachedSession>();

/** Test-only: drop the in-memory window cache so specs start from a clean slate. */
export function clearSessionCache(): void {
  sessionCache.clear();
}

function initialState(session: SessionSummary): ViewState {
  const cached = sessionCache.get(session.sessionId);
  return {
    parts: cached?.parts ?? [],
    resolved: cached?.resolved ?? new Set<string>(),
    pending: [],
    error: null,
    inTurn: session.inTurn,
    lastActivityAt: Date.now() - session.idleSeconds * 1000,
    lowSeq: cached?.lowSeq ?? Number.POSITIVE_INFINITY,
    highSeq: cached?.highSeq ?? 0,
    usage: cached?.usage ?? null,
  };
}

export function SessionView({
  session,
  onBack,
}: {
  session: SessionSummary;
  onBack: () => void;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, session, initialState);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Bumped on a `reset` frame (the tailed source changed) to RE-RUN the subscribe
  // effect below — which drops the cache + re-subscribes from scratch, so the
  // server re-resolves the source (docs/02.6 §4.32, §4.22/§4.23).
  const [resetNonce, setResetNonce] = useState(0);
  const prependAnchorRef = useRef<number | null>(null);

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
    const cached = sessionCache.get(session.sessionId);
    const unsubscribe = subscribeSession(
      cached
        ? { sessionId: session.sessionId, sinceSeq: cached.highSeq }
        : { sessionId: session.sessionId, limit: INITIAL_WINDOW },
      (event) => {
        buffer.push(event);
        if (raf === null) raf = requestAnimationFrame(flush);
      },
      (blockers) => dispatch({ type: "pending", blockers }),
      (message) => dispatch({ type: "error", message }),
      setConn,
      undefined,
      (inTurn) => dispatch({ type: "turn", inTurn }),
      (usage) => dispatch({ type: "usage", usage }),
      () => {
        // Source changed: drop the stale window cache so the re-run below
        // re-subscribes fresh (with `limit`), and clear the view.
        sessionCache.delete(session.sessionId);
        dispatch({ type: "reset" });
        setResetNonce((n) => n + 1);
      },
    );
    return () => {
      unsubscribe();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [session.sessionId, resetNonce]);

  // Persist the loaded window per session (wire-bandwidth #5) so back→re-select
  // restores it and the subscribe above resumes from `highSeq` instead of
  // refetching from 0.
  useEffect(() => {
    sessionCache.set(session.sessionId, {
      parts: state.parts,
      resolved: state.resolved,
      lowSeq: state.lowSeq,
      highSeq: state.highSeq,
      usage: state.usage,
    });
  }, [
    session.sessionId,
    state.parts,
    state.resolved,
    state.lowSeq,
    state.highSeq,
    state.usage,
  ]);

  // Stick-to-bottom: follow the latest message unless the user scrolled up.
  // A ResizeObserver on the inner content re-pins on any growth — including the
  // markdown/table reflow after the initial load, which a parts-effect misses
  // (that's why it opened at the top).
  const scrollRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const restoredRef = useRef(false);
  // Show a "jump to latest" affordance whenever the view is parked away from the
  // bottom (scrolled up, or a restored mid-conversation position on a long chat).
  const [showJump, setShowJump] = useState(false);

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
    setShowJump(el.scrollHeight - top - el.clientHeight > 120);
    writeScroll(session.sessionId, { top, atBottom: stickRef.current });
  };

  const jumpToBottom = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
  };

  // Older history remains to page in while the lowest held seq is finite and
  // above 0 (the tail window didn't reach the session start).
  const showLoadOlder = Number.isFinite(state.lowSeq) && state.lowSeq > 0;

  const loadOlder = async (): Promise<void> => {
    if (loadingOlder || !showLoadOlder) return;
    setLoadingOlder(true);
    try {
      const older = await fetchHistory({
        sessionId: session.sessionId,
        beforeSeq: state.lowSeq,
        limit: HISTORY_PAGE,
      });
      // Capture distance-from-bottom BEFORE the prepend; the layout effect below
      // restores it so the viewport stays put as content grows above the fold.
      const el = scrollRef.current;
      if (el) prependAnchorRef.current = el.scrollHeight - el.scrollTop;
      dispatch({ type: "prepend", events: older });
    } catch {
      // transient — leave the view as-is; the button stays for a retry.
    } finally {
      setLoadingOlder(false);
    }
  };

  // Keep the viewport steady when older messages are prepended: restore the
  // pre-prepend distance-from-bottom (a prepend grows content above the fold).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prependAnchorRef.current;
    if (el && anchor !== null) {
      el.scrollTop = el.scrollHeight - anchor;
      prependAnchorRef.current = null;
    }
  }, [state.parts]);

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

  // Re-render every 30s so the header's idle age stays live — the `session` prop
  // is a frozen snapshot (App never refreshes it while a view is open).
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  // Idle age + status from the LIVE last-activity (not the frozen summary), so a
  // just-ended turn reads "active" instead of a stale "idle 16m" (docs/02.2).
  const liveIdleSeconds = Math.max(
    0,
    Math.floor((Date.now() - state.lastActivityAt) / 1000),
  );
  const liveStatus: SessionStatus =
    liveIdleSeconds < LIVE_WINDOW_SECONDS ? "active" : "idle";
  const activity = useMemo(
    () =>
      sessionActivity(
        state.pending,
        state.parts,
        state.resolved,
        liveStatus,
        state.inTurn,
        liveIdleSeconds,
      ),
    [
      state.pending,
      state.parts,
      state.resolved,
      liveStatus,
      state.inTurn,
      liveIdleSeconds,
    ],
  );
  // Foreign workspace (no live extension here) => observe-only. Actuation is
  // gated in the UI; a receiving-side guard lands with the gateway (docs/03).
  const readOnly = !session.owned;

  // Session telemetry (docs/02 §4.14): the TOTAL is computed server-side over the
  // whole log and pushed via the `usage` frame, so it's correct under the tail
  // window (docs/02.6 §4.32) — the client no longer sums its partial parts.
  const usage = state.usage;
  // Interleave a per-turn usage badge into the transcript rows (turn-local, so a
  // client-side sum stays correct for the turns actually loaded).
  const rows = useMemo(() => interleaveTurnUsage(state.parts), [state.parts]);

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
            className={`dot ${activity.awaiting ? "amber" : dotClass(liveStatus)}`}
          />
          {activity.label}
        </span>
        {showJump && (
          <button
            className="icon-btn jump-btn"
            onClick={jumpToBottom}
            title="Jump to latest"
            aria-label="Jump to latest"
          >
            ↓
          </button>
        )}
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

      {usage && <UsageBar usage={usage} />}

      <main
        className="content transcript"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        <div className="transcript-inner" ref={innerRef}>
          {state.error && <p className="hint dim">stream: {state.error}</p>}
          {showLoadOlder && (
            <button
              className="btn small load-older"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
            >
              {loadingOlder ? "Loading…" : "Load older messages"}
            </button>
          )}
          {state.parts.length === 0 && !state.error && (
            <p className="hint">Loading transcript…</p>
          )}
          {rows.map((row) =>
            row.kind === "part" ? (
              <Part
                key={row.part.id}
                part={row.part}
                resolved={state.resolved.has(row.part.id)}
              />
            ) : (
              <TurnBadge key={row.id} usage={row.usage} />
            ),
          )}
        </div>
      </main>

      {!readOnly && state.pending.length > 0 && (
        <footer className="pending-overlay">
          {state.pending.map((b) => (
            <PendingCard key={b.toolCallId} blocker={b} session={session} />
          ))}
        </footer>
      )}
      {session.logSource === "transcript" && (
        <p className="lag-banner" role="status">
          ⚠ Transcript-based — the latest reply can lag. Enable Copilot’s agent
          debug log for live updates.
        </p>
      )}
      {readOnly ? (
        <p className="readonly-banner">
          Read-only — no CloakCode extension is running in this workspace, so
          you can view the transcript but not send, answer, or approve.
        </p>
      ) : (
        <ChatComposer
          session={session}
          inTurn={state.inTurn}
          onStopped={() => dispatch({ type: "turn", inTurn: false })}
        />
      )}
    </div>
  );
}

/**
 * Compact session-telemetry bar (docs/02 §4.14): total tokens, AI Units, request
 * count, and the model(s). An **ⓘ** marker is ALWAYS shown — the counts come from
 * the on-disk debug log, so the authoritative figure is VS Code's own Session
 * Cost. A firm **partial** chip is added when history was transcript-stitched
 * (`tx-` parts), whose turns carry no telemetry, so the totals cover the recent
 * (debug-log) turns only.
 */
function UsageBar({ usage }: { usage: UsageSummary }): JSX.Element {
  return (
    <div className="usage-bar">
      <span title="input tokens">{compactTokens(usage.inputTokens)} in</span>
      <span title="output tokens">{compactTokens(usage.outputTokens)} out</span>
      <span title="cached input tokens">
        {compactTokens(usage.cachedTokens)} cached
      </span>
      {usage.aiu !== undefined && (
        <span
          className="usage-aiu"
          title="AI Units (copilotUsageNanoAiu ÷ 1e9) — what Copilot bills against"
        >
          {formatAiu(usage.aiu)} AIU
        </span>
      )}
      {usage.credits !== undefined && (
        <span className="usage-aiu" title="Copilot credits">
          {usage.credits} cr
        </span>
      )}
      <span title="llm_request spans">{usage.requests} req</span>
      <span className="usage-model" title={usage.models.join(", ")}>
        {usage.models[0]}
        {usage.models.length > 1 ? ` +${usage.models.length - 1}` : ""}
      </span>
      {usage.partial && (
        <span
          className="usage-partial"
          title="Partial: earlier history was stitched from the transcript, which carries no telemetry — so these totals cover the recent (debug-log) turns only."
        >
          partial
        </span>
      )}
      <span
        className="usage-info"
        title="Usage is counted from the on-disk debug log. The authoritative figure is VS Code's own Session Cost (and your GitHub Copilot usage)."
        aria-label="About these usage numbers"
      >
        ⓘ
      </span>
    </div>
  );
}

/**
 * A compact per-turn usage badge (docs/02 §4.14): the turn's model(s), generated
 * tokens, and cost, placed at the end of the turn. Aggregates every `llm_request`
 * in the turn into one tag.
 */
function TurnBadge({ usage }: { usage: UsageTotals }): JSX.Element {
  return (
    <div className="turn-usage" title="This turn's model usage">
      <span className="turn-usage-model">
        {usage.models[0]}
        {usage.models.length > 1 ? ` +${usage.models.length - 1}` : ""}
      </span>
      <span>{compactTokens(usage.inputTokens)} in</span>
      <span>{compactTokens(usage.outputTokens)} out</span>
      <span>{compactTokens(usage.cachedTokens)} cached</span>
      {usage.aiu !== undefined && (
        <span className="usage-aiu">{formatAiu(usage.aiu)} AIU</span>
      )}
      {usage.credits !== undefined && (
        <span className="usage-aiu">{usage.credits} cr</span>
      )}
      {usage.requests > 1 && <span>{usage.requests} req</span>}
    </div>
  );
}

const Part = memo(function Part({
  part,
  resolved,
}: {
  part: SessionPart;
  resolved: boolean;
}): JSX.Element | null {
  switch (part.kind) {
    case "usage":
      return null; // metadata — aggregated into the UsageBar, not rendered inline
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
    case "confirmation": {
      // Once the answer is known, the highlight must follow what was CHOSEN.
      // Keeping the `recommended` highlight on a resolved card read as "this is
      // what was picked" and was routinely wrong (bug: 2026-07-27).
      const answer = part.answer;
      return (
        <div className={`blocker ${resolved ? "resolved" : ""}`}>
          <span className="blocker-tag">
            <span className="dot amber" />{" "}
            {resolved ? "Answered" : "Needs your input"}
          </span>
          <div className="blocker-q">{part.prompt}</div>
          {part.options.map((o) => {
            const chosen = answer?.selected.includes(o.label);
            const highlight = answer
              ? chosen
                ? "chosen"
                : ""
              : o.recommended
                ? "reco"
                : "";
            return (
              <div key={o.id} className={`choice ${highlight}`}>
                <div className="choice-label">
                  <span>{o.label}</span>
                  {o.recommended && <span className="reco-badge">REC</span>}
                </div>
                {o.detail && <div className="choice-detail">{o.detail}</div>}
              </div>
            );
          })}
          {answer && (
            <div className="blocker-answer">{answerSummary(answer)}</div>
          )}
          {!resolved && (
            <div className="blocker-note">
              Shown here for context — answer it from the pending panel.
            </div>
          )}
        </div>
      );
    }
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
  steer: (text: string) => Promise<boolean>;
  stop: (text?: string) => Promise<boolean>;
} {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setSending(true);
    setError(null);
    try {
      await fn();
      setSent(true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSending(false);
    }
  };
  const send = (text: string, toolCallId?: string): Promise<boolean> =>
    run(() =>
      respondSession({
        sessionId: session.sessionId,
        text,
        ...(toolCallId ? { toolCallId } : {}),
      }),
    );
  const steer = (text: string): Promise<boolean> =>
    run(() => steerSession({ sessionId: session.sessionId, text }));
  const stop = (text?: string): Promise<boolean> =>
    run(() =>
      stopSession({
        sessionId: session.sessionId,
        ...(text ? { text } : {}),
      }),
    );
  return { sending, error, sent, send, steer, stop };
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
  // Single-select holds exactly ONE answer, so picking replaces (and a second
  // click on the chosen option CLEARS it — there was no way back); multi-select
  // toggles the label in/out. Picking an option on a single-select also drops
  // any typed custom answer, the mirror of `setFreeText` below: what the card
  // shows is exactly what gets sent.
  const toggle = (i: number, label: string, multi: boolean): void => {
    const cur = getAns(i).selected;
    if (multi) {
      patch(i, {
        selected: cur.includes(label)
          ? cur.filter((x) => x !== label)
          : [...cur, label],
      });
      return;
    }
    patch(i, {
      selected: cur.includes(label) ? [] : [label],
      freeText: "",
    });
  };
  // Typing a custom answer takes PRIORITY on a single-select, so it clears the
  // chosen option (the extension would otherwise have to drop one of the two —
  // it used to silently drop the text). A multi-select legitimately carries
  // both ("pick all that apply, plus add your own"), so clearing stays manual.
  const setFreeText = (i: number, value: string, multi: boolean): void =>
    patch(i, { freeText: value, ...(multi ? {} : { selected: [] }) });

  const structuredAnswers: QuestionAnswer[] = confirmations.map((c, qi) => {
    const a = getAns(qi);
    return {
      selected: a.selected,
      freeText: a.freeText || null,
      ...(c.multiSelect ? { multiSelect: true } : {}),
      // Lets the extension pick the right freeform shape: an options-bearing
      // carousel reads `freeformValue`, a no-options `text` one a bare string
      // (docs/02.3 §4.16 correction).
      ...(c.options.length > 0 ? { hasOptions: true } : {}),
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
                    onChange={(e) =>
                      setFreeText(step, e.target.value, c.multiSelect ?? false)
                    }
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

function ChatComposer({
  session,
  inTurn,
  onStopped,
}: {
  session: SessionSummary;
  inTurn: boolean;
  onStopped: () => void;
}): JSX.Element {
  const [msg, setMsg] = useState("");
  const { sending, error, send, steer, stop } = useRemoteSend(session);
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = msg.trim();
  const hasText = text.length > 0;

  // Run a text action and clear the box on success. Guards empty/in-flight.
  const act = async (fn: () => Promise<boolean>): Promise<void> => {
    if (sending || !hasText) return;
    if (await fn()) setMsg("");
  };
  const doQueue = (): Promise<void> => act(() => send(text));
  const doSteer = (): Promise<void> => act(() => steer(text));
  const doStopSend = (): Promise<void> => act(() => stop(text));
  // Pure cancel: needs no message, works with an empty box, and must NOT clear
  // whatever the operator is drafting. On ack, optimistically clear the mid-turn
  // flag so the composer flips back to Send immediately — `chat.cancel` writes no
  // debug-log `turn_end`, so the follower won't emit `inTurn:false` on its own
  // (docs/05 known issue); the next real turn reconciles it.
  const doStop = async (): Promise<void> => {
    if (!sending && (await stop())) onStopped();
  };
  // The submit/Enter action: steer while mid-turn, else a plain queued send.
  const primary = inTurn ? doSteer : doQueue;

  // Grow the textarea with its content (capped) so multi-line messages are
  // visible. Enter inserts a newline; Ctrl/⌘+Enter runs the primary action.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [msg]);

  return (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void primary();
      }}
    >
      {error && <div className="pending-error">send failed: {error}</div>}
      <div className="chat-composer-row">
        <textarea
          ref={ref}
          className="chat-input"
          rows={1}
          placeholder={
            inTurn
              ? "Redirect this turn…  (⏎ newline · ⌘/Ctrl+⏎ steer)"
              : "Message the active chat…  (⏎ newline · ⌘/Ctrl+⏎ send)"
          }
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void primary();
            }
          }}
          disabled={sending}
        />
        <button
          type="submit"
          className="chat-send"
          disabled={sending || !hasText}
        >
          {sending ? "…" : inTurn ? "Steer" : "Send"}
        </button>
      </div>
      {inTurn && (
        <div className="chat-actions">
          <button
            type="button"
            className="chat-send secondary"
            onClick={() => void doQueue()}
            disabled={sending || !hasText}
            title="Send after the current step completes (or immediately if the turn has already ended)"
          >
            Queue
          </button>
          <button
            type="button"
            className="chat-send danger"
            onClick={() => void doStopSend()}
            disabled={sending || !hasText}
          >
            Stop &amp; send
          </button>
          <button
            type="button"
            className="chat-send danger"
            onClick={() => void doStop()}
            disabled={sending}
          >
            Stop
          </button>
        </div>
      )}
      <div className="blocker-note">
        {inTurn
          ? "Mid-turn: Steer redirects now · Queue sends after this step · Stop & send cancels then sends. remote-operator."
          : "Sends to the active chat in VS Code (remote-operator)."}
      </div>
    </form>
  );
}
