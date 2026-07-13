import type { WebSocket } from "ws";

interface RelayEntry {
  operator: WebSocket;
  originalId: string;
}

/**
 * Routes an operator's session-addressed RPC to the owning provider and pipes
 * the provider's frames back. The operator's request `id` is rewritten to a
 * unique relay id on the wire (so concurrent operators never collide) and
 * rewritten back on the way out. A streaming `session.subscribe` keeps its
 * mapping until the operator disconnects; one-shot acks reuse the same path.
 * Transport-agnostic — it only touches the sockets it is handed.
 */
export class Relay {
  readonly #entries = new Map<string, RelayEntry>();
  #seq = 0;

  /**
   * Forward one operator request under a fresh relay id via `send` (a provider
   * socket writer), remembering how to route the replies back to `operator`.
   */
  forward(
    operator: WebSocket,
    request: { id: string; op: string; params: unknown },
    send: (text: string) => void,
  ): void {
    const relayId = `rl:${this.#seq++}`;
    this.#entries.set(relayId, { operator, originalId: request.id });
    send(
      JSON.stringify({ id: relayId, op: request.op, params: request.params }),
    );
  }

  /**
   * If `text` is a provider frame for an active relay, rewrite its id back to
   * the operator's original and deliver it. Returns whether it was handled (so
   * the caller can fall through to the provider's own request/response path).
   */
  routeProviderFrame(text: string): boolean {
    let msg: { id?: unknown };
    try {
      msg = JSON.parse(text) as { id?: unknown };
    } catch {
      return false;
    }
    if (typeof msg.id !== "string") return false;
    const entry = this.#entries.get(msg.id);
    if (!entry) return false;
    const out = { ...msg, id: entry.originalId };
    if (entry.operator.readyState === entry.operator.OPEN) {
      entry.operator.send(JSON.stringify(out));
    }
    return true;
  }

  /** Drop every relay for a disconnected operator (later frames are ignored). */
  dropOperator(operator: WebSocket): void {
    for (const [id, entry] of this.#entries) {
      if (entry.operator === operator) this.#entries.delete(id);
    }
  }

  /** Number of active relays (test/diagnostic aid). */
  get size(): number {
    return this.#entries.size;
  }
}
