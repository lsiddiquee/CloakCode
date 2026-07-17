import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@cloakcode/protocol";
import {
  answerSession,
  bridgeUrl,
  type ConnState,
  decideSession,
  fetchSessions,
  respondSession,
  steerSession,
  stopSession,
  subscribeSession,
} from "./bridge";
import { clearStoredToken, onNeedsAuth, storeToken } from "./auth";

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

  /** Drive a transport error (its `close` follows in real sockets, drive it too). */
  triggerError(): void {
    this.emit("error");
  }

  /** Deliver a raw, unparsed frame (to exercise the JSON-parse guard). */
  raw(data: string): void {
    this.emit("message", { data });
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

  it("reports live inTurn transitions via onTurn", () => {
    const turns: boolean[] = [];
    subscribeSession(
      { sessionId: "s1" },
      () => {},
      undefined,
      undefined,
      undefined,
      "ws://test/bridge",
      (t) => turns.push(t),
    );
    socket(0).open();
    socket(0).message({
      id: "srv",
      op: "session.subscribe",
      kind: "turn",
      inTurn: true,
    });
    socket(0).message({
      id: "srv",
      op: "session.subscribe",
      kind: "turn",
      inTurn: false,
    });
    expect(turns).toEqual([true, false]);
  });
});

describe("bridgeUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to a same-origin /bridge ws URL", () => {
    // jsdom serves http://<host>; the derived URL uses ws: on the same host.
    expect(bridgeUrl()).toBe(`ws://${window.location.host}/bridge`);
  });

  it("honours the VITE_BRIDGE_URL override", () => {
    vi.stubEnv("VITE_BRIDGE_URL", "wss://phone.example/bridge");
    expect(bridgeUrl()).toBe("wss://phone.example/bridge");
  });
});

describe("fetchSessions", () => {
  it("resolves with the validated session list", async () => {
    const p = fetchSessions("ws://test/bridge");
    socket(0).open();
    expect(JSON.parse(socket(0).sent[0]!).op).toBe("sessions.list");
    socket(0).message({ id: "x", ok: true, op: "sessions.list", result: [] });
    await expect(p).resolves.toEqual({ sessions: [] });
  });

  it("surfaces the gateway display name when the hub reports one", async () => {
    const p = fetchSessions("ws://test/bridge");
    socket(0).open();
    socket(0).message({
      id: "x",
      ok: true,
      op: "sessions.list",
      result: [],
      gateway: "office",
    });
    await expect(p).resolves.toEqual({ sessions: [], gateway: "office" });
  });

  it("rejects with the server error message", async () => {
    const p = fetchSessions("ws://test/bridge");
    socket(0).open();
    socket(0).message({ id: "x", ok: false, error: { message: "nope" } });
    await expect(p).rejects.toThrow("nope");
  });

  it("rejects on an unrecognized response shape", async () => {
    const p = fetchSessions("ws://test/bridge");
    socket(0).open();
    socket(0).message({ id: "x", ok: true, op: "something.else" });
    await expect(p).rejects.toThrow("unexpected response");
  });

  it("rejects on a non-JSON frame", async () => {
    const p = fetchSessions("ws://test/bridge");
    socket(0).open();
    socket(0).raw("not json {");
    await expect(p).rejects.toBeInstanceOf(Error);
  });

  it("rejects when the socket errors", async () => {
    const p = fetchSessions("ws://test/bridge");
    socket(0).triggerError();
    await expect(p).rejects.toThrow("cannot reach the bridge");
  });

  it("rejects after the timeout", async () => {
    const p = fetchSessions("ws://test/bridge");
    vi.advanceTimersByTime(5000);
    await expect(p).rejects.toThrow("timed out");
  });
});

describe("actuator one-shot RPCs", () => {
  const ack = (op: string) => ({ id: "x", ok: true, op });

  it("respondSession resolves on ack and sends the right op", async () => {
    const p = respondSession(
      { sessionId: "s", toolCallId: "t", text: "go" },
      "ws://test/bridge",
    );
    socket(0).open();
    const sent = JSON.parse(socket(0).sent[0]!);
    expect(sent.op).toBe("session.respond");
    expect(sent.params).toMatchObject({ sessionId: "s", text: "go" });
    socket(0).message(ack("session.respond"));
    await expect(p).resolves.toBeUndefined();
  });

  it("decideSession / answerSession / steerSession / stopSession resolve on ack", async () => {
    const cases: Array<[Promise<void>, string]> = [
      [
        decideSession(
          { sessionId: "s", toolCallId: "t", decision: "allow" },
          "ws://test/bridge",
        ),
        "session.decide",
      ],
      [
        answerSession(
          { sessionId: "s", toolCallId: "t", answers: [] },
          "ws://test/bridge",
        ),
        "session.answer",
      ],
      [
        steerSession({ sessionId: "s", text: "x" }, "ws://test/bridge"),
        "session.steer",
      ],
      [stopSession({ sessionId: "s" }, "ws://test/bridge"), "session.stop"],
    ];
    cases.forEach(([, op], i) => {
      socket(i).open();
      expect(JSON.parse(socket(i).sent[0]!).op).toBe(op);
      socket(i).message(ack(op));
    });
    await Promise.all(cases.map(([p]) => p));
  });

  it("rejects with the server error message", async () => {
    const p = stopSession({ sessionId: "s" }, "ws://test/bridge");
    socket(0).open();
    socket(0).message({ id: "x", ok: false, error: { message: "denied" } });
    await expect(p).rejects.toThrow("denied");
  });

  it("rejects when the socket errors", async () => {
    const p = steerSession({ sessionId: "s", text: "x" }, "ws://test/bridge");
    socket(0).triggerError();
    await expect(p).rejects.toThrow("cannot reach the bridge");
  });

  it("rejects after the timeout", async () => {
    const p = respondSession({ sessionId: "s", text: "x" }, "ws://test/bridge");
    vi.advanceTimersByTime(5000);
    await expect(p).rejects.toThrow("timed out");
  });
});

describe("operator auth (F2a)", () => {
  afterEach(() => clearStoredToken());

  it("sends the token resume prelude before the op, ignoring the auth ack", async () => {
    storeToken("tok-1");
    const p = fetchSessions("ws://test/bridge");
    socket(0).open();
    // Frame 0 is the auth resume, frame 1 the actual op.
    expect(JSON.parse(socket(0).sent[0]!).op).toBe("auth");
    expect(JSON.parse(socket(0).sent[0]!).params).toEqual({ token: "tok-1" });
    expect(JSON.parse(socket(0).sent[1]!).op).toBe("sessions.list");
    // The auth ack must NOT resolve/close the call.
    socket(0).message({ id: "auth-0", ok: true, op: "auth" });
    socket(0).message({ id: "x", ok: true, op: "sessions.list", result: [] });
    await expect(p).resolves.toEqual({ sessions: [] });
  });

  it("raises the needs-auth prompt and rejects on a needsAuth refusal", async () => {
    const seen = vi.fn();
    const off = onNeedsAuth(seen);
    const p = fetchSessions("ws://test/bridge");
    socket(0).open();
    socket(0).message({
      id: "x",
      ok: false,
      needsAuth: true,
      error: { message: "authentication required" },
    });
    await expect(p).rejects.toThrow("authentication required");
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});
