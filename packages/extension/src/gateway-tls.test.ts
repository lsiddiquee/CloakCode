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
function emitUpgrade(sock: EventEmitter, fingerprint256: string): void {
  sock.emit("upgrade", {
    socket: { getPeerCertificate: () => ({ fingerprint256 }) },
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
