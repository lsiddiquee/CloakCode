import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@cloakcode/protocol";
import { type ConnState, subscribeSession } from "./bridge";

type Listener = (ev: unknown) => void;

/** Minimal WebSocket stand-in that lets a test drive open/message/close. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close");
  }

  // --- test drivers ---
  open(): void {
    this.emit("open");
  }

  message(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  /** Decoded `params` of the last frame this socket sent. */
  lastParams(): { sessionId: string; sinceSeq: number } {
    return JSON.parse(this.sent.at(-1) ?? "{}").params;
  }

  private emit(type: string, ev?: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

/** The n-th socket the code under test opened (throws if absent). */
function socket(n: number): MockWebSocket {
  const ws = MockWebSocket.instances[n];
  if (!ws) throw new Error(`no socket #${n}`);
  return ws;
}

/** A valid `{kind:"event"}` subscribe frame carrying an `append` at `seq`. */
function appendFrame(seq: number): unknown {
  const event: SessionEvent = {
    type: "append",
    seq,
    part: { kind: "markdown", id: `m${seq}`, text: "hi" },
  };
  return { id: "srv", op: "session.subscribe", kind: "event", event };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0); // deterministic id + zero jitter
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("subscribeSession", () => {
  it("subscribes from the requested seq and reports the lifecycle", () => {
    const status: ConnState[] = [];
    subscribeSession(
      { sessionId: "s1", sinceSeq: 3 },
      () => {},
      () => {},
      () => {},
      (s) => status.push(s),
      "ws://test/bridge",
    );

    expect(status).toEqual(["connecting"]);
    socket(0).open();
    expect(status).toEqual(["connecting", "open"]);
    expect(socket(0).lastParams()).toEqual({
      sessionId: "s1",
      sinceSeq: 3,
    });
  });

  it("resumes from the last seq it saw after a dropped connection", () => {
    const seen: number[] = [];
    subscribeSession(
      { sessionId: "s1" },
      (e) => seen.push(e.seq),
      undefined,
      undefined,
      undefined,
      "ws://test/bridge",
    );

    socket(0).open();
    expect(socket(0).lastParams().sinceSeq).toBe(0); // default start
    socket(0).message(appendFrame(5));
    expect(seen).toEqual([5]);

    // Server drops the socket; capped backoff schedules a reconnect.
    socket(0).close();
    vi.advanceTimersByTime(500); // 500 * 2**0, zero jitter
    expect(MockWebSocket.instances).toHaveLength(2);

    socket(1).open();
    expect(socket(1).lastParams().sinceSeq).toBe(6); // resume past seq 5
  });

  it("backs off exponentially while reconnects keep failing", () => {
    subscribeSession(
      { sessionId: "s1" },
      () => {},
      undefined,
      undefined,
      undefined,
      "ws://test/bridge",
    );

    // 1st drop (attempt 0) -> 500ms.
    socket(0).close();
    vi.advanceTimersByTime(499);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    // 2nd drop with no successful open in between (attempt 1) -> 1000ms.
    socket(1).close();
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("stops reconnecting once unsubscribed", () => {
    const status: ConnState[] = [];
    const unsubscribe = subscribeSession(
      { sessionId: "s1" },
      () => {},
      undefined,
      undefined,
      (s) => status.push(s),
      "ws://test/bridge",
    );

    socket(0).open();
    unsubscribe();
    expect(status.at(-1)).toBe("closed");

    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1); // nothing rescheduled
  });
});
