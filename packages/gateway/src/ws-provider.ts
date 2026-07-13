import {
  sessionsListResponseSchema,
  type SessionSummary,
} from "@cloakcode/protocol";
import type { WebSocket } from "ws";
import type { SessionProvider } from "./registry.js";

interface Pending {
  resolve: (msg: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A {@link SessionProvider} backed by a WebSocket to an extension in **client
 * mode** (docs/03 "Explicit gateway"). The gateway sends it the usual RPC
 * requests and correlates the responses by `id`; the extension answers from its
 * own observer/actuator. Kept transport-thin so the registry stays testable.
 */
export class WsProvider implements SessionProvider {
  readonly instanceId: string;
  readonly #socket: WebSocket;
  readonly #pending = new Map<string, Pending>();
  #seq = 0;

  constructor(instanceId: string, socket: WebSocket) {
    this.instanceId = instanceId;
    this.#socket = socket;
  }

  /** Feed a raw provider→gateway message so it can resolve a pending request. */
  handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const id = (msg as { id?: unknown }).id;
    if (typeof id !== "string") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(msg);
  }

  /** Write a raw frame to the provider socket (used by the relay). */
  send(text: string): void {
    if (this.#socket.readyState === this.#socket.OPEN) {
      this.#socket.send(text);
    }
  }

  /** Reject every in-flight request (the socket closed). */
  dispose(reason = "provider disconnected"): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }

  #request(op: string, params: object, timeoutMs = 10_000): Promise<unknown> {
    const id = `gw:${this.instanceId}:${this.#seq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`provider ${this.instanceId} timed out on ${op}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, op, params }));
    });
  }

  async listSessions(): Promise<SessionSummary[]> {
    const res = await this.#request("sessions.list", {});
    const parsed = sessionsListResponseSchema.safeParse(res);
    return parsed.success ? parsed.data.result : [];
  }
}
