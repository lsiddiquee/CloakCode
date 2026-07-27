import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import {
  gatewayTlsOptions,
  guardFingerprintPin,
  isFingerprintOnly,
  normalizeFingerprint,
  verifyPinnedCert,
} from "./gateway-tls.js";

const PIN =
  "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

describe("normalizeFingerprint", () => {
  it("strips colons/spaces and uppercases", () => {
    expect(normalizeFingerprint("ab:cd ef")).toBe("ABCDEF");
    expect(normalizeFingerprint("AB-CD-EF")).toBe("ABCDEF");
  });
});

describe("verifyPinnedCert", () => {
  it("accepts a matching fingerprint (case/separator-insensitive)", () => {
    expect(verifyPinnedCert(PIN, { fingerprint256: PIN })).toBeUndefined();
    expect(
      verifyPinnedCert(PIN, { fingerprint256: PIN.toLowerCase() }),
    ).toBeUndefined();
  });

  it("fails closed on a mismatch", () => {
    const err = verifyPinnedCert(PIN, { fingerprint256: "00:" + PIN.slice(3) });
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/fingerprint/i);
  });

  it("names both fingerprints, but neither in full", () => {
    // Diagnosability without handing over trust material. Enough to see that a
    // DIFFERENT cert answered (vs none at all — identical messages bit us
    // 2026-07-27) and which pin was in effect; not enough to paste into the
    // setting. The presented value is derived from bytes the REMOTE chose, so a
    // full echo would let whatever answered offer its own fingerprint as the
    // "fix" — trust-on-first-use by copy-paste. The configured one stays out of
    // shared logs.
    const presented = "00:" + PIN.slice(3);
    const err = verifyPinnedCert(PIN, { fingerprint256: presented });
    const full = normalizeFingerprint(presented);
    expect(err?.message).not.toContain(full);
    expect(err?.message).not.toContain(normalizeFingerprint(PIN));
    expect(err?.message).toContain(full.slice(0, 12));
    expect(err?.message).toContain(normalizeFingerprint(PIN).slice(0, 12));
  });

  it("distinguishes 'no certificate presented' from a real mismatch", () => {
    expect(verifyPinnedCert(PIN, {})?.message).toMatch(/no certificate/i);
    expect(verifyPinnedCert(PIN, { fingerprint256: "" })?.message).toMatch(
      /no certificate/i,
    );
    // Says which pin was in effect, still without printing it in full.
    expect(verifyPinnedCert(PIN, {})?.message).toContain(
      normalizeFingerprint(PIN).slice(0, 12),
    );
    expect(verifyPinnedCert(PIN, {})?.message).not.toContain(
      normalizeFingerprint(PIN),
    );
  });

  it("fails closed when the peer presents no fingerprint", () => {
    expect(verifyPinnedCert(PIN, { fingerprint256: "" })).toBeInstanceOf(Error);
    expect(verifyPinnedCert(PIN, {})).toBeInstanceOf(Error);
  });
});

describe("gatewayTlsOptions", () => {
  it("returns no TLS options for a ws:// url", () => {
    expect(gatewayTlsOptions("ws://hub:7900", { fingerprint: PIN })).toEqual(
      {},
    );
    expect(gatewayTlsOptions("  ws://hub:7900 ")).toEqual({});
  });

  it("keeps rejectUnauthorized on for wss:// (no downgrade)", () => {
    const opts = gatewayTlsOptions("wss://hub:7443");
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.ca).toBeUndefined();
    expect(opts.checkServerIdentity).toBeUndefined();
  });

  it("passes the CA PEM when provided (self-signed trust anchor)", () => {
    const caPem =
      "-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----";
    const opts = gatewayTlsOptions("wss://hub:7443", { caPem });
    expect(opts.ca).toBe(caPem);
    expect(opts.rejectUnauthorized).toBe(true);
  });

  it("(fingerprint-only) turns chain auth off for a lone fingerprint pin", () => {
    // No CA: the pin is the sole anchor, so chain auth must be off (a self-signed
    // chain would fail before the pin) and the exact cert is verified by hand in
    // guardFingerprintPin — not via checkServerIdentity (ignored when auth is off).
    const opts = gatewayTlsOptions("wss://192.168.1.10:7443", {
      fingerprint: PIN,
    });
    expect(opts.rejectUnauthorized).toBe(false);
    expect(opts.checkServerIdentity).toBeUndefined();
  });

  it("(CA-pin) keeps auth on and installs checkServerIdentity when fingerprint AND CA are set", () => {
    const opts = gatewayTlsOptions("wss://192.168.1.10:7443", {
      fingerprint: PIN,
      caPem: "PEM",
    });
    expect(opts.rejectUnauthorized).toBe(true);
    expect(typeof opts.checkServerIdentity).toBe("function");
  });

  it("has no checkServerIdentity override when only a CA is set (default hostname check)", () => {
    const opts = gatewayTlsOptions("wss://hub:7443", { caPem: "PEM" });
    expect(opts.checkServerIdentity).toBeUndefined();
  });

  it("disables TLS session resumption whenever a fingerprint is pinned", () => {
    // A RESUMED session presents no certificate: `getPeerCertificate()` returns
    // `{}` and `checkServerIdentity` is never called, so the pin silently can't
    // be verified — the guard then rejects a legitimate gateway (observed: the
    // first connect works, every reconnect "fails the pin"). Proven against the
    // live gateway 2026-07-27: attempt #1 certKeys=19, #2+ reused=true keys=0.
    // Own the agent so no shared session cache (the extension host installs one
    // via `http.proxySupport`) can skip verification.
    for (const pin of [
      { fingerprint: PIN },
      { fingerprint: PIN, caPem: "P" },
    ]) {
      const agent = gatewayTlsOptions("wss://hub:7443", pin).agent;
      expect(agent).toBeDefined();
      expect(
        (agent as unknown as { options: { maxCachedSessions?: number } })
          .options.maxCachedSessions,
      ).toBe(0);
    }
  });

  it("leaves the agent alone when there is nothing to pin", () => {
    // No pin → nothing to verify per-connection, so don't override the host's
    // agent (it may carry the user's proxy configuration).
    expect(gatewayTlsOptions("wss://hub:7443").agent).toBeUndefined();
    expect(gatewayTlsOptions("wss://hub:7443", { caPem: "P" }).agent).toBe(
      undefined,
    );
    expect(gatewayTlsOptions("ws://hub:7900", { fingerprint: PIN }).agent).toBe(
      undefined,
    );
  });
});

describe("isFingerprintOnly", () => {
  it("is true for a wss url with a fingerprint and no CA", () => {
    expect(isFingerprintOnly("wss://hub:7443", { fingerprint: PIN })).toBe(
      true,
    );
    expect(isFingerprintOnly("  WSS://hub:7443 ", { fingerprint: PIN })).toBe(
      true,
    );
  });

  it("is false once a CA is also supplied (that is the stricter CA-pin path)", () => {
    expect(
      isFingerprintOnly("wss://hub:7443", { fingerprint: PIN, caPem: "PEM" }),
    ).toBe(false);
  });

  it("is false without a fingerprint, and for a plain ws url", () => {
    expect(isFingerprintOnly("wss://hub:7443", {})).toBe(false);
    expect(isFingerprintOnly("ws://hub:7900", { fingerprint: PIN })).toBe(
      false,
    );
  });
});

/** A minimal stand-in for the `ws` socket: an EventEmitter that records terminate(). */
function fakeSocket(): EventEmitter & { terminated: boolean } {
  const ee = new EventEmitter() as EventEmitter & {
    terminated: boolean;
    terminate: () => void;
  };
  ee.terminated = false;
  ee.terminate = () => {
    ee.terminated = true;
  };
  return ee;
}

/** Emit an `upgrade` whose TLS socket presents `fingerprint256`. */
function emitUpgrade(
  sock: EventEmitter,
  fingerprint256: string,
  reused = false,
): void {
  sock.emit("upgrade", {
    socket: {
      getPeerCertificate: () => ({ fingerprint256 }),
      isSessionReused: () => reused,
    },
  });
}

describe("guardFingerprintPin", () => {
  it("(fingerprint-only) signals verified on a fingerprint match — no terminate", () => {
    const sock = fakeSocket();
    let verified = false;
    let rejected: Error | undefined;
    guardFingerprintPin(
      sock as unknown as WebSocket,
      "wss://hub:7443",
      { fingerprint: PIN },
      () => (verified = true),
      (e) => (rejected = e),
    );
    emitUpgrade(sock, PIN);
    sock.emit("open");
    expect(verified).toBe(true);
    expect(rejected).toBeUndefined();
    expect(sock.terminated).toBe(false);
  });

  it("(fingerprint-only) terminates and rejects on a mismatch, before onVerified (fail closed)", () => {
    const sock = fakeSocket();
    let verified = false;
    let rejected: Error | undefined;
    guardFingerprintPin(
      sock as unknown as WebSocket,
      "wss://hub:7443",
      { fingerprint: PIN },
      () => (verified = true),
      (e) => (rejected = e),
    );
    emitUpgrade(sock, "00:" + PIN.slice(3));
    sock.emit("open");
    expect(verified).toBe(false);
    expect(rejected).toBeInstanceOf(Error);
    expect(sock.terminated).toBe(true);
  });

  it("(fingerprint-only) fails closed when no certificate was captured", () => {
    const sock = fakeSocket();
    let verified = false;
    let rejected: Error | undefined;
    guardFingerprintPin(
      sock as unknown as WebSocket,
      "wss://hub:7443",
      { fingerprint: PIN },
      () => (verified = true),
      (e) => (rejected = e),
    );
    sock.emit("open"); // no 'upgrade' — peer cert never seen
    expect(verified).toBe(false);
    expect(rejected).toBeInstanceOf(Error);
    expect(sock.terminated).toBe(true);
  });

  it("(fingerprint-only) blames a RESUMED session, not the pin, when no cert was sent", () => {
    const sock = fakeSocket();
    let verified = false;
    let rejected: Error | undefined;
    guardFingerprintPin(
      sock as unknown as WebSocket,
      "wss://hub:7443",
      { fingerprint: PIN },
      () => (verified = true),
      (e) => (rejected = e),
    );
    emitUpgrade(sock, "", true); // resumed handshake: no certificate on the wire
    sock.emit("open");
    expect(verified).toBe(false);
    expect(sock.terminated).toBe(true);
    // The remedy must be in the message: this is not a wrong pin, and the user
    // cannot act on "presented no certificate" alone.
    expect(rejected?.message).toMatch(/resumed/i);
    expect(rejected?.message).toContain("cloakcode.gatewayCaFile");
    expect(rejected?.message).toContain("http.proxySupport");
  });

  it("(CA-pin / real-CA / plain ws) signals verified on open without a manual check", () => {
    for (const [url, pin] of [
      ["wss://hub:7443", { fingerprint: PIN, caPem: "PEM" }],
      ["wss://hub:7443", {}],
      ["ws://hub:7900", { fingerprint: PIN }],
    ] as const) {
      const sock = fakeSocket();
      let verified = false;
      guardFingerprintPin(
        sock as unknown as WebSocket,
        url,
        pin,
        () => (verified = true),
        () => {},
      );
      sock.emit("open");
      expect(verified).toBe(true);
      expect(sock.terminated).toBe(false);
    }
  });
});
