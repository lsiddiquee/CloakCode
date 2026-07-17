import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

interface RelayEntry {
  operator: WebSocket;
  originalId: string;
  /** Opaque identity of the routed-to provider, so a provider disconnect can
   *  drop its in-flight relays (see dropProvider). Kept transport-agnostic. */
  provider: object;
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

  /**
   * Forward one operator request under a fresh relay id via `send` (a provider
   * socket writer), remembering how to route the replies back to `operator`.
   */
  forward(
    operator: WebSocket,
    request: { id: string; op: string; params: unknown; traceId?: string },
    provider: object,
    send: (text: string) => void,
  ): void {
    const relayId = `rl:${randomUUID()}`;
    this.#entries.set(relayId, { operator, originalId: request.id, provider });
    send(
      JSON.stringify({
        id: relayId,
        op: request.op,
        params: request.params,
        ...(request.traceId !== undefined ? { traceId: request.traceId } : {}),
      }),
    );
  }

  /**
   * If `text` is a provider frame for an active relay, rewrite its id back to
   * the operator's original and deliver it. `from` is the provider that sent the
   * frame: only the provider a relay was routed to may answer it, so a frame
   * carrying another provider's relay id is dropped, not delivered (F13).
   * Returns whether it was handled (so the caller can fall through to the
   * provider's own request/response path).
   */
  routeProviderFrame(text: string, from: object): boolean {
    let msg: { id?: unknown };
    try {
      msg = JSON.parse(text) as { id?: unknown };
    } catch {
      return false;
    }
    if (typeof msg.id !== "string") return false;
    const entry = this.#entries.get(msg.id);
    if (!entry) return false;
    // Bind the reply to its provider: swallow (don't deliver) a relay-id frame
    // that arrives from a different provider than the one it was routed to.
    if (entry.provider !== from) return true;
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

  /** Drop every relay routed to a disconnected provider so stale mappings don't
   *  linger until the operator leaves (F5). `provider` is the identity passed to
   *  {@link forward}. */
  dropProvider(provider: object): void {
    for (const [id, entry] of this.#entries) {
      if (entry.provider === provider) this.#entries.delete(id);
    }
  }

  /** Number of active relays (test/diagnostic aid). */
  get size(): number {
    return this.#entries.size;
  }
}
