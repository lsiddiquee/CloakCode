import { PENDING, SESSIONS, TRANSCRIPTS } from "./fixtures";

// A minimal in-browser stand-in for the browser `WebSocket`, wired ONLY to the
// bridge protocol the App speaks (@cloakcode/protocol). Every bridge call in
// @cloakcode/web funnels through `new WebSocket(url)` — list, subscribe, and the
// actuator RPCs — so swapping this single global lets the REAL app run against
// fixtures with zero changes to production code. It connects to nothing (no
// network, no egress); it just replays canned frames back to the caller.

type Listener = (ev: { data?: string }) => void;

interface RequestFrame {
  id?: string;
  op?: string;
  params?: { sessionId?: string };
}

export class FakeBridgeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeBridgeSocket.CONNECTING;
  private readonly listeners: Record<string, Listener[]> = {};

  constructor(readonly url: string) {
    // Open on the next tick, mirroring a real socket's async handshake.
    setTimeout(() => {
      this.readyState = FakeBridgeSocket.OPEN;
      this.emit("open");
    }, 0);
  }

  addEventListener(type: string, cb: Listener): void {
    (this.listeners[type] ??= []).push(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb);
  }

  send(data: string): void {
    let frame: RequestFrame;
    try {
      frame = JSON.parse(data) as RequestFrame;
    } catch {
      return;
    }
    // Ignore the auth prelude and anything we don't model — the playground
    // origin has no stored token, so no auth is needed.
    if (frame.op === "sessions.list") {
      this.reply({
        id: frame.id,
        ok: true,
        op: "sessions.list",
        result: SESSIONS,
        gateway: "playground",
      });
    } else if (frame.op === "session.subscribe") {
      this.streamSession(frame);
    } else if (
      typeof frame.op === "string" &&
      frame.op.startsWith("session.")
    ) {
      // Actuator acks (respond/decide/answer/steer/stop) — fire-and-ack.
      this.reply({ id: frame.id, ok: true, op: frame.op });
    }
  }

  close(): void {
    this.readyState = FakeBridgeSocket.CLOSED;
    this.emit("close");
  }

  private streamSession(frame: RequestFrame): void {
    const sessionId = frame.params?.sessionId ?? "";
    for (const event of TRANSCRIPTS[sessionId] ?? []) {
      this.reply({
        id: frame.id,
        op: "session.subscribe",
        kind: "event",
        event,
      });
    }
    const blockers = PENDING[sessionId];
    if (blockers) {
      this.reply({
        id: frame.id,
        op: "session.subscribe",
        kind: "pending",
        blockers,
      });
    }
    const inTurn =
      SESSIONS.find((s) => s.sessionId === sessionId)?.inTurn ?? false;
    this.reply({ id: frame.id, op: "session.subscribe", kind: "turn", inTurn });
  }

  private reply(obj: unknown): void {
    if (this.readyState !== FakeBridgeSocket.OPEN) return;
    setTimeout(() => this.emit("message", { data: JSON.stringify(obj) }), 10);
  }

  private emit(type: string, ev: { data?: string } = {}): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

/** Install the fake as the global `WebSocket` for the playground session. */
export function installFakeBridge(): void {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket =
    FakeBridgeSocket;
}
