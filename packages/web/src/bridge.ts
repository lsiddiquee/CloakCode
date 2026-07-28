import {
  rpcErrorSchema,
  newTraceId,
  sessionSubscribeEventSchema,
  sessionsChangedSchema,
  sessionsListResponseSchema,
  sessionHistoryResponseSchema,
  sessionRespondResponseSchema,
  sessionDecideResponseSchema,
  sessionAnswerResponseSchema,
  sessionSteerResponseSchema,
  sessionStopResponseSchema,
  gatewayConnectInfoResponseSchema,
  type Decision,
  type GatewayConnectInfo,
  type PendingBlocker,
  type QuestionAnswer,
  type SessionEvent,
  type SessionSummary,
  type UsageSummary,
} from "@cloakcode/protocol";
import {
  authKind,
  authInstanceId,
  emitEnrolmentRequired,
  emitNeedsAuth,
  getStoredToken,
  tokenAuthFrame,
} from "./auth";

/**
 * Send the operator `auth` resume frame first when a session token is stored, so
 * a fresh socket is already authenticated before its op (docs/04, F2a). No-op
 * without a token — the op then draws a `needsAuth` refusal that prompts a login.
 */
function sendAuthPrelude(ws: WebSocket): void {
  const token = getStoredToken();
  if (token) ws.send(tokenAuthFrame(token));
}

/**
 * Resolve the bridge WebSocket URL. Defaults to a **same-origin** `/bridge`
 * path (Vite proxies it in dev; the extension host will in prod), so the PWA
 * connects to whatever host it was served from — localhost, a LAN IP, or a
 * tunnel — over a single port, using `wss` when the page is served over https.
 * Override with `VITE_BRIDGE_URL` for a direct/custom endpoint.
 */
export function bridgeUrl(): string {
  const override = import.meta.env["VITE_BRIDGE_URL"] as string | undefined;
  if (override) return override;
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/bridge`;
}

/**
 * True when the PWA's OWN link to the gateway is **unencrypted** — the page was
 * served over plain `http` (so {@link bridgeUrl} is `ws://`), which happens when
 * the operator listener is exposed off-loopback with no tunnel. A confidentiality
 * signal for the UI's insecure-mode warning (docs/04): the transcript + answers
 * cross the network in clear. Served over `https` (the tunnel) it is false.
 */
export function isBridgeInsecure(): boolean {
  const override = import.meta.env["VITE_BRIDGE_URL"] as string | undefined;
  if (override) return /^ws:/i.test(override);
  return window.location.protocol !== "https:";
}

/**
 * Result of a `sessions.list` fetch: the session rows plus the optional display
 * name of the gateway that served them (a standalone hub reports its instance id
 * — office/home/hostname; the embedded bridge omits it).
 */
export interface SessionsListResult {
  sessions: SessionSummary[];
  gateway?: string;
}

/**
 * One-shot `sessions.list` over the bridge WebSocket. Validates the response
 * with the shared protocol schema so nothing untyped reaches the UI.
 */
export function fetchSessions(
  url: string = bridgeUrl(),
): Promise<SessionsListResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("bridge timed out"));
    }, 5000);

    ws.addEventListener("open", () => {
      sendAuthPrelude(ws);
      ws.send(JSON.stringify({ id, op: "sessions.list" }));
    });

    ws.addEventListener("message", (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const kind = authKind(raw);
      if (kind === "ack") return; // resume ack precedes the real reply; keep open
      clearTimeout(timer);
      ws.close();
      if (kind === "needs") {
        emitNeedsAuth(authInstanceId(raw));
        reject(new Error("authentication required"));
        return;
      }
      if (kind === "enrol") {
        emitEnrolmentRequired(authInstanceId(raw));
        reject(new Error("enrolment required"));
        return;
      }
      const ok = sessionsListResponseSchema.safeParse(raw);
      if (ok.success) {
        resolve({
          sessions: ok.data.result,
          ...(ok.data.gateway ? { gateway: ok.data.gateway } : {}),
        });
        return;
      }
      const err = rpcErrorSchema.safeParse(raw);
      reject(
        new Error(err.success ? err.data.error.message : "unexpected response"),
      );
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("cannot reach the bridge"));
    });
  });
}

/**
 * One-shot `session.history` backward page for scroll-up lazy-loading — the
 * seq'd events with index in `[beforeSeq - limit, beforeSeq)` (older than what
 * the client holds). An empty array means the client has reached the top. The
 * live tail keeps arriving on the separate {@link subscribeSession} stream.
 * Validated with the shared protocol schema so nothing untyped reaches the UI.
 */
export function fetchHistory(
  params: { sessionId: string; beforeSeq: number; limit: number },
  url: string = bridgeUrl(),
): Promise<SessionEvent[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("bridge timed out"));
    }, 5000);

    ws.addEventListener("open", () => {
      sendAuthPrelude(ws);
      ws.send(JSON.stringify({ id, op: "session.history", params }));
    });

    ws.addEventListener("message", (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const kind = authKind(raw);
      if (kind === "ack") return; // resume ack precedes the real reply
      clearTimeout(timer);
      ws.close();
      if (kind === "needs") {
        emitNeedsAuth(authInstanceId(raw));
        reject(new Error("authentication required"));
        return;
      }
      if (kind === "enrol") {
        emitEnrolmentRequired(authInstanceId(raw));
        reject(new Error("enrolment required"));
        return;
      }
      const ok = sessionHistoryResponseSchema.safeParse(raw);
      if (ok.success) {
        resolve(ok.data.result.events);
        return;
      }
      const err = rpcErrorSchema.safeParse(raw);
      reject(
        new Error(err.success ? err.data.error.message : "unexpected response"),
      );
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("cannot reach the bridge"));
    });
  });
}

/**
 * One-shot `gateway.connectInfo` fetch (C4): how to pair an EXTENSION with the
 * gateway's `wss://` provider listener — the reachable URLs and the SHA-256
 * fingerprint pin (public; neither the key nor the certificate is sent). Refused
 * with `needsAuth` until the operator is logged in — same auth prelude as the
 * other ops. Mirrors {@link fetchSessions}.
 */
export function fetchConnectInfo(
  url: string = bridgeUrl(),
): Promise<GatewayConnectInfo> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("bridge timed out"));
    }, 5000);

    ws.addEventListener("open", () => {
      sendAuthPrelude(ws);
      ws.send(JSON.stringify({ id, op: "gateway.connectInfo" }));
    });

    ws.addEventListener("message", (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const kind = authKind(raw);
      if (kind === "ack") return; // resume ack precedes the real reply; keep open
      clearTimeout(timer);
      ws.close();
      if (kind === "needs") {
        emitNeedsAuth(authInstanceId(raw));
        reject(new Error("authentication required"));
        return;
      }
      if (kind === "enrol") {
        emitEnrolmentRequired(authInstanceId(raw));
        reject(new Error("enrolment required"));
        return;
      }
      const ok = gatewayConnectInfoResponseSchema.safeParse(raw);
      if (ok.success) {
        resolve(ok.data.result);
        return;
      }
      const err = rpcErrorSchema.safeParse(raw);
      reject(
        new Error(err.success ? err.data.error.message : "unexpected response"),
      );
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("cannot reach the bridge"));
    });
  });
}

/**
 * A human reason for a terminal `session.subscribe` error frame — maps the
 * redaction-safe `code` (+ optional size) to a message the operator sees in
 * place of a silent blank session (docs/02.6 §4.31).
 */
export function describeSubscribeError(code: string, bytes?: number): string {
  if (code === "ERR_STRING_TOO_LONG") {
    const size = bytes ? ` (${Math.round(bytes / 1_000_000)} MB)` : "";
    return `This session is too large to load${size} — it exceeds the size CloakCode can read in one pass.`;
  }
  return `Couldn't load this session (${code}).`;
}

/** Live connection lifecycle of a session subscription. */
export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

/**
 * Subscribe to a session's live event stream. Calls `onEvent` for each
 * validated seq'd `SessionEvent` (history channel), `onPending` for each
 * live-pending snapshot (replace-semantics overlay), `onError` for server-side
 * RPC errors, `onStatus` for the connection lifecycle, and `onTurn` for the live
 * mid-turn flag (so the composer flips steer/queue↔send without a list refresh).
 * **Auto-reconnects** with capped exponential backoff on drop, resuming from the
 * last seq it saw so only missed events replay. Returns an unsubscribe function
 * that stops reconnecting and closes the socket.
 */
export function subscribeSession(
  params: { sessionId: string; sinceSeq?: number; limit?: number },
  onEvent: (event: SessionEvent) => void,
  onPending: (blockers: PendingBlocker[]) => void = () => {},
  onError: (message: string) => void = () => {},
  onStatus: (status: ConnState) => void = () => {},
  url: string = bridgeUrl(),
  onTurn: (inTurn: boolean) => void = () => {},
  onUsage: (usage: UsageSummary) => void = () => {},
  onReset: () => void = () => {},
): () => void {
  let ws: WebSocket | null = null;
  let lastSeq = params.sinceSeq ?? 0;
  let attempt = 0;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const connect = (): void => {
    if (stopped) return;
    onStatus(attempt === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(url);
    ws = socket;
    const id = crypto.randomUUID();

    socket.addEventListener("open", () => {
      attempt = 0;
      onStatus("open");
      sendAuthPrelude(socket);
      socket.send(
        JSON.stringify({
          id,
          op: "session.subscribe",
          traceId: newTraceId(),
          params: {
            sessionId: params.sessionId,
            sinceSeq: lastSeq,
            // Tail-window the INITIAL load only (a fresh open, lastSeq 0). On a
            // reconnect-resume send NO limit so every missed event still replays.
            ...(params.limit !== undefined && lastSeq === 0
              ? { limit: params.limit }
              : {}),
          },
        }),
      );
    });

    socket.addEventListener("message", (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const kind = authKind(raw);
      if (kind === "ack") return; // resume ack precedes the subscribe reply
      if (kind === "needs") {
        // Refused: prompt the operator. Stay open (no reconnect storm) — the App
        // re-subscribes once a token is obtained.
        emitNeedsAuth(authInstanceId(raw));
        onError("authentication required");
        return;
      }
      if (kind === "enrol") {
        emitEnrolmentRequired(authInstanceId(raw));
        onError("enrolment required");
        return;
      }
      const frame = sessionSubscribeEventSchema.safeParse(raw);
      if (frame.success) {
        if (frame.data.kind === "event") {
          const event = frame.data.event;
          // Track the resume point so a reconnect replays only what we missed.
          if (event.seq >= lastSeq) lastSeq = event.seq + 1;
          onEvent(event);
        } else if (frame.data.kind === "pending") {
          onPending(frame.data.blockers);
        } else if (frame.data.kind === "turn") {
          onTurn(frame.data.inTurn);
        } else if (frame.data.kind === "usage") {
          // Session usage TOTAL, aggregated server-side over the whole log so
          // the tail window can't undercount it (docs/02.6 §4.32).
          onUsage(frame.data.usage);
        } else if (frame.data.kind === "reset") {
          // The tailed SOURCE changed under the follower (rotation, or the
          // debug-log appeared post-rehydration — docs/02.6 §4.32, §4.22/§4.23).
          // Resume from scratch so a reconnect can't replay onto the old source.
          lastSeq = 0;
          onReset();
        } else {
          // kind === "error": the session couldn't be read (e.g. too large to
          // read in one pass, docs/02.6 §4.31) — show a reason, not a blank.
          onError(describeSubscribeError(frame.data.code, frame.data.bytes));
        }
        return;
      }
      const err = rpcErrorSchema.safeParse(raw);
      if (err.success) onError(err.data.error.message);
    });

    // A socket error is always followed by `close`, which drives the reconnect.
    socket.addEventListener("close", () => {
      if (stopped) {
        onStatus("closed");
        return;
      }
      onStatus("reconnecting");
      const delay = Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    });
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}

/**
 * Keep a socket open on the LIST view and invoke `onChange` on each
 * `sessions.changed` ping (1B live list) — so a new session appears without a
 * manual refresh. Sends the auth prelude + `sessions.subscribe`, then reconnects
 * with capped backoff on drops. A `needsAuth` refusal STOPS it (the App's
 * ready-gated effect re-subscribes after re-auth, so it never storm-loops while
 * unauthenticated). Returns an unsubscribe fn.
 */
export function subscribeSessionsChanges(
  onChange: () => void,
  url: string = bridgeUrl(),
): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const connect = (): void => {
    if (stopped) return;
    const socket = new WebSocket(url);
    ws = socket;
    socket.addEventListener("open", () => {
      attempt = 0;
      sendAuthPrelude(socket);
      socket.send(
        JSON.stringify({
          id: crypto.randomUUID(),
          op: "sessions.subscribe",
          traceId: newTraceId(),
        }),
      );
    });
    socket.addEventListener("message", (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (authKind(raw) === "needs") {
        stopped = true; // stay unsubscribed; the App re-subscribes after re-auth
        socket.close();
        return;
      }
      if (sessionsChangedSchema.safeParse(raw).success) onChange();
    });
    socket.addEventListener("close", () => {
      if (stopped) return;
      const delay = Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    });
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}

/**
 * One-shot request/ack over the bridge WebSocket: open, send `{id, op, params}`,
 * resolve when `isOk` accepts the reply, reject on an error envelope / bad reply
 * / timeout. Shared by every fire-and-ack actuator call so the socket lifecycle
 * lives in one place.
 */
function oneShotRpc(
  op: string,
  params: unknown,
  isOk: (raw: unknown) => boolean,
  url: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("bridge timed out"));
    }, 5000);

    ws.addEventListener("open", () => {
      sendAuthPrelude(ws);
      ws.send(JSON.stringify({ id, op, params, traceId: newTraceId() }));
    });

    ws.addEventListener("message", (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const kind = authKind(raw);
      if (kind === "ack") return; // resume ack precedes the real reply; keep open
      clearTimeout(timer);
      ws.close();
      if (kind === "needs") {
        emitNeedsAuth(authInstanceId(raw));
        reject(new Error("authentication required"));
        return;
      }
      if (kind === "enrol") {
        emitEnrolmentRequired(authInstanceId(raw));
        reject(new Error("enrolment required"));
        return;
      }
      if (isOk(raw)) {
        resolve();
        return;
      }
      const err = rpcErrorSchema.safeParse(raw);
      reject(
        new Error(err.success ? err.data.error.message : "unexpected response"),
      );
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("cannot reach the bridge"));
    });
  });
}

/**
 * Send a `remote-operator` message to a session's active chat (M3b). With a
 * `toolCallId` it answers a specific pending blocker; without one it's a
 * free-form chat prompt. One-shot over the bridge; resolves on the ack, rejects
 * on error or timeout. The extension host turns this into
 * `workbench.action.chat.open`.
 */
export function respondSession(
  params: {
    sessionId: string;
    toolCallId?: string;
    text: string;
  },
  url: string = bridgeUrl(),
): Promise<void> {
  return oneShotRpc(
    "session.respond",
    params,
    (raw) => sessionRespondResponseSchema.safeParse(raw).success,
    url,
  );
}

/**
 * Approve or deny a pending tool call (the operator's verdict for a blocker that
 * is `awaitingDecision`). Resolves on the ack; the extension host dispatches it
 * to VS Code's native confirmation via the `acceptTool`/`skipTool` command,
 * targeted by the session URI. A `remote-operator` action.
 */
export function decideSession(
  params: {
    sessionId: string;
    toolCallId: string;
    decision: Decision;
  },
  url: string = bridgeUrl(),
): Promise<void> {
  return oneShotRpc(
    "session.decide",
    params,
    (raw) => sessionDecideResponseSchema.safeParse(raw).success,
    url,
  );
}

/**
 * Deliver a STRUCTURED answer to a pending `vscode_askQuestions` carousel — one
 * entry per question, by index. `toolCallId` is the blocker's `resolveId` (the
 * raw suffixed id). The extension host resolves the tool with `{answers}` via
 * `_chat.notifyQuestionCarouselAnswer`, instead of the chat-text path (which
 * cancels the carousel). See docs/02 §4.16.
 */
export function answerSession(
  params: {
    sessionId: string;
    toolCallId: string;
    answers: QuestionAnswer[];
  },
  url: string = bridgeUrl(),
): Promise<void> {
  return oneShotRpc(
    "session.answer",
    params,
    (raw) => sessionAnswerResponseSchema.safeParse(raw).success,
    url,
  );
}

/**
 * Steer the in-flight turn: inject `text` INTO the running turn to redirect it
 * (not queued after). Only meaningful while `SessionSummary.inTurn`. The
 * extension host prefills the composer then fires `steerWithMessage`. A
 * `remote-operator` action; resolves on the ack, rejects on error/timeout.
 */
export function steerSession(
  params: { sessionId: string; text: string },
  url: string = bridgeUrl(),
): Promise<void> {
  return oneShotRpc(
    "session.steer",
    params,
    (raw) => sessionSteerResponseSchema.safeParse(raw).success,
    url,
  );
}

/**
 * Stop the in-flight turn (`chat.cancel`). With `text` it's STOP-AND-SEND
 * (cancel, then send `text` as a fresh prompt); without, a pure stop. A
 * `remote-operator` action; resolves on the ack, rejects on error/timeout.
 */
export function stopSession(
  params: { sessionId: string; text?: string },
  url: string = bridgeUrl(),
): Promise<void> {
  return oneShotRpc(
    "session.stop",
    params,
    (raw) => sessionStopResponseSchema.safeParse(raw).success,
    url,
  );
}
