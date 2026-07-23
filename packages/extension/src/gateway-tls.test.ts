import { describe, it, expect } from "vitest";
import {
  gatewayTlsOptions,
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

  it("installs a checkServerIdentity hook when a fingerprint pin is set", () => {
    const opts = gatewayTlsOptions("wss://192.168.1.10:7443", {
      fingerprint: PIN,
    });
    expect(typeof opts.checkServerIdentity).toBe("function");
  });

  it("has no checkServerIdentity override when only a CA is set (default hostname check)", () => {
    const opts = gatewayTlsOptions("wss://hub:7443", { caPem: "PEM" });
    expect(opts.checkServerIdentity).toBeUndefined();
  });
});
