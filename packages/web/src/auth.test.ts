import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authKind,
  clearStoredToken,
  emitNeedsAuth,
  getStoredToken,
  onNeedsAuth,
  storeToken,
  submitAuthCode,
  tokenAuthFrame,
} from "./auth";

type Listener = (ev: unknown) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Listener[]> = {};
  constructor(readonly url: string) {
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
  open(): void {
    this.emit("open");
  }
  message(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }
  triggerError(): void {
    this.emit("error");
  }
  private emit(type: string, ev?: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("token store", () => {
  it("round-trips and clears the token", () => {
    expect(getStoredToken()).toBeUndefined();
    storeToken("tok-123");
    expect(getStoredToken()).toBe("tok-123");
    clearStoredToken();
    expect(getStoredToken()).toBeUndefined();
  });
});

describe("authKind", () => {
  it("recognises an auth ack, a needsAuth refusal, and other frames", () => {
    expect(authKind({ id: "1", ok: true, op: "auth" })).toBe("ack");
    expect(authKind({ id: "1", ok: false, needsAuth: true, error: {} })).toBe(
      "needs",
    );
    expect(authKind({ id: "1", ok: true, op: "sessions.list" })).toBe("other");
    expect(authKind(null)).toBe("other");
  });
});

describe("tokenAuthFrame", () => {
  it("builds an auth op carrying the token", () => {
    const frame = JSON.parse(tokenAuthFrame("tok"));
    expect(frame.op).toBe("auth");
    expect(frame.params).toEqual({ token: "tok" });
  });
});

describe("needs-auth bus", () => {
  it("invokes the current handler and unsubscribes", () => {
    const cb = vi.fn();
    const off = onNeedsAuth(cb);
    emitNeedsAuth();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    emitNeedsAuth();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("submitAuthCode", () => {
  it("sends the code + remember, stores and returns the token", async () => {
    const p = submitAuthCode("123456", true, "ws://x/bridge");
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    expect(JSON.parse(ws.sent[0]!).params).toEqual({
      code: "123456",
      remember: true,
    });
    ws.message({ id: "auth-0", ok: true, op: "auth", token: "tok-xyz" });
    await expect(p).resolves.toBe("tok-xyz");
    expect(getStoredToken()).toBe("tok-xyz");
  });

  it("rejects on a bad-code error and stores nothing", async () => {
    const p = submitAuthCode("000000", false, "ws://x/bridge");
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.message({ id: "auth-0", ok: false, error: { message: "invalid code" } });
    await expect(p).rejects.toThrow("invalid code");
    expect(getStoredToken()).toBeUndefined();
  });
});
