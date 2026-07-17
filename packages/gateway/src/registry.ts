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

/**
 * Identity key for de-dup: the `sessionId` alone. A Copilot session id is a
 * globally-unique UUID, so the SAME id reported by several providers (its owner +
 * other windows' foreign scans of the shared storage) is one session — keying on
 * `instanceId` too would leak a read-only duplicate per foreign scanner.
 */
function sessionKey(s: SessionSummary): string {
  return s.sessionId;
}

/**
 * Merge session lists from multiple providers, de-duped by **`sessionId`** and
 * preferring the **owned** row so the actuatable copy (carrying the owning
 * instance, for routing) wins. This collapses the read-only duplicate that every
 * other window's foreign scan of the shared storage produces. Order-independent.
 * Pure.
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
 * `sessions.list` with de-dup and maps each `sessionId` to its owning provider
 * so the gateway can route session-addressed RPCs (instanceId is a display label
 * only). Transport-agnostic (pure); the
 * WebSocket layer adds/removes providers as connections come and go.
 */
export class ProviderRegistry {
  private readonly byInstance = new Map<string, Set<SessionProvider>>();
  private sessionOwner = new Map<string, SessionProvider>();

  add(provider: SessionProvider): void {
    const set = this.byInstance.get(provider.instanceId) ?? new Set();
    set.add(provider);
    this.byInstance.set(provider.instanceId, set);
  }

  remove(provider: SessionProvider): void {
    const set = this.byInstance.get(provider.instanceId);
    if (set) {
      set.delete(provider);
      if (set.size === 0) this.byInstance.delete(provider.instanceId);
    }
    // Purge routing entries that point at the departed provider so a session-
    // addressed RPC can't route to a disposed connection before the next
    // listSessions() rebuild (deleting while iterating a Map is safe).
    for (const [sessionId, owner] of this.sessionOwner) {
      if (owner === provider) this.sessionOwner.delete(sessionId);
    }
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
    const providers = this.all();
    const lists = await Promise.all(
      providers.map((p) => p.listSessions().catch(() => [])),
    );
    // Remember which provider owns each session so the gateway can route
    // session-addressed RPCs by `sessionId` — instanceId is a display label
    // only, never a routing key. Prefer the owning provider on a duplicate.
    const owner = new Map<string, SessionProvider>();
    lists.forEach((list, i) => {
      const p = providers[i];
      if (!p) return;
      for (const s of list) {
        if (!owner.has(s.sessionId) || s.owned) owner.set(s.sessionId, p);
      }
    });
    this.sessionOwner = owner;
    return mergeSessions(lists);
  }

  /**
   * The provider that owns `sessionId` (for routing a session-addressed RPC).
   * Populated by {@link listSessions}; the owning provider wins over a foreign
   * scan. Undefined when no listed provider reports the session.
   */
  providerForSession(sessionId: string): SessionProvider | undefined {
    return this.sessionOwner.get(sessionId);
  }
}
