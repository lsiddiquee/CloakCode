import {
  rpcErrorSchema,
  newTraceId,
  sessionSubscribeEventSchema,
  sessionsListResponseSchema,
  sessionRespondResponseSchema,
  sessionDecideResponseSchema,
  sessionAnswerResponseSchema,
  sessionSteerResponseSchema,
  sessionStopResponseSchema,
  type Decision,
  type PendingBlocker,
  type QuestionAnswer,
  type SessionEvent,
  type SessionSummary,
} from "@cloakcode/protocol";

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
 * One-shot `sessions.list` over the bridge WebSocket. Validates the response
 * with the shared protocol schema so nothing untyped reaches the UI.
 */
export function fetchSessions(
  url: string = bridgeUrl(),
): Promise<SessionSummary[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("bridge timed out"));
    }, 5000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, op: "sessions.list" }));
    });

    ws.addEventListener("message", (ev) => {
      clearTimeout(timer);
      try {
        const raw: unknown = JSON.parse(String(ev.data));
        const ok = sessionsListResponseSchema.safeParse(raw);
        if (ok.success) {
          resolve(ok.data.result);
          return;
        }
        const err = rpcErrorSchema.safeParse(raw);
        reject(
          new Error(
            err.success ? err.data.error.message : "unexpected response",
          ),
        );
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        ws.close();
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("cannot reach the bridge"));
    });
  });
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
  params: { sessionId: string; sinceSeq?: number },
  onEvent: (event: SessionEvent) => void,
  onPending: (blockers: PendingBlocker[]) => void = () => {},
  onError: (message: string) => void = () => {},
  onStatus: (status: ConnState) => void = () => {},
  url: string = bridgeUrl(),
  onTurn: (inTurn: boolean) => void = () => {},
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
    const id = Math.random().toString(36).slice(2);

    socket.addEventListener("open", () => {
      attempt = 0;
      onStatus("open");
      socket.send(
        JSON.stringify({
          id,
          op: "session.subscribe",
          traceId: newTraceId(),
          params: {
            sessionId: params.sessionId,
            sinceSeq: lastSeq,
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
      const frame = sessionSubscribeEventSchema.safeParse(raw);
      if (frame.success) {
        if (frame.data.kind === "event") {
          const event = frame.data.event;
          // Track the resume point so a reconnect replays only what we missed.
          if (event.seq >= lastSeq) lastSeq = event.seq + 1;
          onEvent(event);
        } else if (frame.data.kind === "pending") {
          onPending(frame.data.blockers);
        } else {
          onTurn(frame.data.inTurn);
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
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("bridge timed out"));
    }, 5000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, op, params, traceId: newTraceId() }));
    });

    ws.addEventListener("message", (ev) => {
      clearTimeout(timer);
      try {
        const raw: unknown = JSON.parse(String(ev.data));
        if (isOk(raw)) {
          resolve();
          return;
        }
        const err = rpcErrorSchema.safeParse(raw);
        reject(
          new Error(
            err.success ? err.data.error.message : "unexpected response",
          ),
        );
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        ws.close();
      }
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
