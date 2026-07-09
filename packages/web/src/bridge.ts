import {
  rpcErrorSchema,
  sessionSubscribeEventSchema,
  sessionsListResponseSchema,
  type PendingBlocker,
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

/**
 * Subscribe to a session's live event stream. Calls `onEvent` for each
 * validated seq'd `SessionEvent` (history channel) and `onPending` for each
 * live-pending snapshot (replace-semantics overlay). Returns an unsubscribe
 * function that closes the socket. Resumable via `sinceSeq`.
 */
export function subscribeSession(
  params: { instanceId: string; sessionId: string; sinceSeq?: number },
  onEvent: (event: SessionEvent) => void,
  onPending: (blockers: PendingBlocker[]) => void = () => {},
  onError: (message: string) => void = () => {},
  url: string = bridgeUrl(),
): () => void {
  const ws = new WebSocket(url);
  const id = Math.random().toString(36).slice(2);

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        id,
        op: "session.subscribe",
        params: {
          instanceId: params.instanceId,
          sessionId: params.sessionId,
          sinceSeq: params.sinceSeq ?? 0,
        },
      }),
    );
  });

  ws.addEventListener("message", (ev) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const frame = sessionSubscribeEventSchema.safeParse(raw);
    if (frame.success) {
      if (frame.data.kind === "event") onEvent(frame.data.event);
      else onPending(frame.data.blockers);
      return;
    }
    const err = rpcErrorSchema.safeParse(raw);
    if (err.success) onError(err.data.error.message);
  });

  ws.addEventListener("error", () => onError("connection lost"));

  return () => ws.close();
}
