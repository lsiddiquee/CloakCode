import {
  rpcErrorSchema,
  sessionsListResponseSchema,
  type SessionSummary,
} from "@cloakcode/protocol";

/** Default localhost bridge; override via VITE_BRIDGE_URL (e.g. a tunnel) at I3. */
export const BRIDGE_URL: string =
  (import.meta.env["VITE_BRIDGE_URL"] as string | undefined) ??
  "ws://localhost:7801";

/**
 * One-shot `sessions.list` over the bridge WebSocket. Validates the response
 * with the shared protocol schema so nothing untyped reaches the UI.
 */
export function fetchSessions(url: string = BRIDGE_URL): Promise<SessionSummary[]> {
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
          new Error(err.success ? err.data.error.message : "unexpected response"),
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
