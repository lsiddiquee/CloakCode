import { PENDING, TRANSCRIPTS } from "./fixtures";
import { resolveScenario, type Scenario } from "./scenarios";

// A minimal in-browser stand-in for the browser `WebSocket`, wired ONLY to the
// bridge protocol the App speaks (@cloakcode/protocol). Every bridge call in
// @cloakcode/web funnels through `new WebSocket(url)` — list, subscribe, auth,
// enrolment, connect-info and the actuator RPCs — so swapping this single global
// lets the REAL app run against fixtures with zero changes to production code.
// It connects to nothing (no network, no egress); it just replays canned frames
// back to the caller.

type Listener = (ev: { data?: string }) => void;

interface RequestFrame {
  id?: string;
  op?: string;
  params?: { sessionId?: string; code?: string; token?: string };
}

/** Fixture material — no gateway, no secret, nothing to authenticate against. */
const ENROL_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const FAKE_TOKEN = "playground.operator.token";

/** The active scenario + the auth gate, shared across sockets as a server is. */
let scenario: Scenario = resolveScenario("");
let gate: Scenario["gate"] = "open";

export class FakeBridgeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeBridgeSocket.CONNECTING;
  private readonly listeners: Record<string, Listener[]> = {};
  /** Auth is per-connection: each fresh socket re-presents its token. */
  private authed = false;

  constructor(readonly url: string) {
    // Open on the next tick, mirroring a real socket's async handshake.
    setTimeout(() => {
      if (scenario.unreachable) {
        this.readyState = FakeBridgeSocket.CLOSED;
        this.emit("error");
        this.emit("close");
        return;
      }
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
    // Ignore anything we don't model.
    if (frame.op === "auth") {
      this.handleAuth(frame);
      return;
    }
    // First-run pairing is the ONE op served while unconfirmed — that is what
    // makes the enrolment screen reachable at all (docs/04, F2a).
    if (frame.op === "enrol.begin" && gate === "enrolment") {
      this.reply({
        id: frame.id,
        ok: true,
        op: "enrol.begin",
        otpauthUri: `otpauth://totp/CloakCode:${scenario.instanceId}?secret=${ENROL_SECRET}&issuer=CloakCode`,
        secret: ENROL_SECRET,
        instanceId: scenario.instanceId,
      });
      return;
    }
    if (!this.authed && gate !== "open") {
      this.refuse(frame);
      return;
    }
    if (frame.op === "sessions.list") {
      this.reply({
        id: frame.id,
        ok: true,
        op: "sessions.list",
        result: scenario.sessions,
        // A plausible hub name — the fixtures span three instances, as a real
        // shared gateway does.
        gateway: scenario.instanceId,
      });
    } else if (frame.op === "gateway.connectInfo") {
      this.reply({
        id: frame.id,
        ok: true,
        op: "gateway.connectInfo",
        result: scenario.connectInfo,
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

  /**
   * Accept any 6-digit code (there is no real secret to check against) or any
   * previously-issued token. Verifying a code also *confirms* enrolment, exactly
   * as the real gate does, so the QR screen doesn't reappear after pairing.
   */
  private handleAuth(frame: RequestFrame): void {
    const code = frame.params?.code;
    const token = frame.params?.token;
    if (code !== undefined && !/^\d{6}$/.test(code)) {
      this.reply({
        id: frame.id,
        ok: false,
        error: { message: "that code was refused — try the current one" },
      });
      return;
    }
    this.authed = true;
    if (code !== undefined) {
      if (gate === "enrolment") gate = "needsAuth";
      this.reply({
        id: frame.id,
        ok: true,
        op: "auth",
        token: FAKE_TOKEN,
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      });
      return;
    }
    // A token resume gets a bare ack — no new token, as the real gate does.
    if (token) this.reply({ id: frame.id, ok: true, op: "auth" });
  }

  private refuse(frame: RequestFrame): void {
    this.reply({
      id: frame.id,
      ok: false,
      error: {
        message:
          gate === "enrolment"
            ? "enrolment required"
            : "operator authentication required",
      },
      ...(gate === "enrolment"
        ? { enrolmentRequired: true }
        : { needsAuth: true }),
      instanceId: scenario.instanceId,
    });
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
      scenario.sessions.find((s) => s.sessionId === sessionId)?.inTurn ?? false;
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
export function installFakeBridge(active: Scenario): void {
  scenario = active;
  gate = active.gate;
  // Start every gated scenario at its prompt: a token left over from a previous
  // run would silently skip the very screen the scenario exists to show.
  if (gate !== "open") localStorage.removeItem("cloakcode.operatorToken");
  (globalThis as unknown as { WebSocket: unknown }).WebSocket =
    FakeBridgeSocket;
}
