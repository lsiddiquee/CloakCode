import type { SessionSummary } from "@cloakcode/protocol";

/**
 * A source of sessions for one `instanceId` — an extension connected to the
 * gateway as a **provider** (docs/03 "Explicit gateway"). The WebSocket
 * transport implements this over a socket; the registry stays pure and
 * transport-agnostic so its aggregation/routing is unit-testable without a
 * network.
 */
export interface SessionProvider {
  readonly instanceId: string;
  /** The provider's current sessions (each already `instanceId`-tagged). */
  listSessions(): Promise<SessionSummary[]>;
}

/** Unique key for a session across every provider. */
function sessionKey(s: SessionSummary): string {
  return `${s.instanceId}\u0000${s.sessionId}`;
}

/**
 * Merge session lists from multiple providers, de-duped by
 * `(instanceId, sessionId)` and preferring the **owned** row so the actuatable
 * copy wins when several providers (e.g. multiple windows of one environment)
 * report the same session. Order-independent. Pure.
 */
export function mergeSessions(
  lists: readonly (readonly SessionSummary[])[],
): SessionSummary[] {
  const byKey = new Map<string, SessionSummary>();
  for (const list of lists) {
    for (const s of list) {
      const key = sessionKey(s);
      const existing = byKey.get(key);
      if (!existing || (s.owned && !existing.owned)) byKey.set(key, s);
    }
  }
  return [...byKey.values()];
}

/**
 * In-memory registry of connected providers, keyed by `instanceId` (several can
 * share one — e.g. multiple windows of the same environment). Aggregates
 * `sessions.list` with de-dup and exposes the providers for an `instanceId` so
 * the gateway can route session-addressed RPCs. Transport-agnostic (pure); the
 * WebSocket layer adds/removes providers as connections come and go.
 */
export class ProviderRegistry {
  private readonly byInstance = new Map<string, Set<SessionProvider>>();

  add(provider: SessionProvider): void {
    const set = this.byInstance.get(provider.instanceId) ?? new Set();
    set.add(provider);
    this.byInstance.set(provider.instanceId, set);
  }

  remove(provider: SessionProvider): void {
    const set = this.byInstance.get(provider.instanceId);
    if (!set) return;
    set.delete(provider);
    if (set.size === 0) this.byInstance.delete(provider.instanceId);
  }

  /** Every connected provider, in no particular order. */
  all(): SessionProvider[] {
    return [...this.byInstance.values()].flatMap((set) => [...set]);
  }

  /** Providers registered for `instanceId` (empty when none are connected). */
  forInstance(instanceId: string): SessionProvider[] {
    return [...(this.byInstance.get(instanceId) ?? [])];
  }

  /**
   * Aggregate `sessions.list` across every provider, de-duped and
   * owned-preferred. A provider that rejects is skipped — one bad connection
   * can't sink the whole list.
   */
  async listSessions(): Promise<SessionSummary[]> {
    const lists = await Promise.all(
      this.all().map((p) => p.listSessions().catch(() => [])),
    );
    return mergeSessions(lists);
  }
}
