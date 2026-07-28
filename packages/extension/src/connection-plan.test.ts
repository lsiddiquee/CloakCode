import { describe, it, expect } from "vitest";
import {
  resolveConnectionPlan,
  resolveGatewayPin,
  resolveGatewayToken,
} from "./connection-plan.js";

const PIN = "82F20036F2E852DA73B069790DBA6F20299978FBE3951BDDF3EA0319F0697293";

describe("resolveConnectionPlan", () => {
  it("uses an explicit gatewayUrl, trimmed", () => {
    expect(resolveConnectionPlan({ gatewayUrl: "  ws://hub:7900 " })).toEqual({
      kind: "gateway",
      url: "ws://hub:7900",
    });
  });

  it("is embedded when no gatewayUrl is set", () => {
    expect(resolveConnectionPlan({ gatewayUrl: undefined })).toEqual({
      kind: "embedded",
    });
  });

  it("treats a whitespace-only url as unset (embedded)", () => {
    expect(resolveConnectionPlan({ gatewayUrl: "   " })).toEqual({
      kind: "embedded",
    });
  });

  it("CLOAKCODE_GATEWAY_URL (env) overrides the setting", () => {
    expect(
      resolveConnectionPlan({
        gatewayUrl: "ws://setting:7900",
        envGatewayUrl: "  ws://env-host:7900 ",
      }),
    ).toEqual({ kind: "gateway", url: "ws://env-host:7900" });
  });

  it("ignores a hostless env url (unfilled HOST_IP) and falls back", () => {
    expect(
      resolveConnectionPlan({
        gatewayUrl: "ws://setting:7900",
        envGatewayUrl: "ws://:7900",
      }),
    ).toEqual({ kind: "gateway", url: "ws://setting:7900" });
    expect(
      resolveConnectionPlan({
        gatewayUrl: undefined,
        envGatewayUrl: "ws://:7900",
      }),
    ).toEqual({ kind: "embedded" });
  });

  it("splits the pin out of a pairing URL so the dialled address stays bare", () => {
    // One copy-paste string carries host + pin, so they cannot drift apart.
    expect(
      resolveConnectionPlan({ gatewayUrl: `wss://hub:7901#fp=${PIN}` }),
    ).toEqual({ kind: "gateway", url: "wss://hub:7901", fingerprint: PIN });
  });

  it("REFUSES a pairing URL whose pin is unusable (never dials unpinned)", () => {
    expect(() =>
      resolveConnectionPlan({ gatewayUrl: "wss://hub:7901#fp=oops" }),
    ).toThrow(/64 hex/i);
  });

  it("is disabled (no bridge at all) when the embedded bridge is turned off", () => {
    // Opt-in isolation: this window then only ever talks to a gateway the
    // operator named, and never quietly starts serving its own PWA.
    expect(
      resolveConnectionPlan({ gatewayUrl: undefined, embeddedBridge: false }),
    ).toEqual({ kind: "disabled" });
  });

  it("still connects OUT when the embedded bridge is off (it gates only the fallback)", () => {
    expect(
      resolveConnectionPlan({
        gatewayUrl: "ws://hub:7900",
        embeddedBridge: false,
      }),
    ).toEqual({ kind: "gateway", url: "ws://hub:7900" });
  });

  it("defaults to hosting the embedded bridge", () => {
    expect(resolveConnectionPlan({ gatewayUrl: undefined })).toEqual({
      kind: "embedded",
    });
    expect(
      resolveConnectionPlan({ gatewayUrl: undefined, embeddedBridge: true }),
    ).toEqual({ kind: "embedded" });
  });
});

describe("resolveGatewayPin", () => {
  it("takes the pin from the pairing URL or from the setting", () => {
    expect(resolveGatewayPin({ urlFingerprint: PIN })).toEqual({
      fingerprint: PIN,
    });
    expect(resolveGatewayPin({ settingFingerprint: `  ${PIN} ` })).toEqual({
      fingerprint: PIN,
    });
  });

  it("is unpinned when neither is set (a real authority vouches for the cert)", () => {
    expect(resolveGatewayPin({})).toEqual({});
    expect(
      resolveGatewayPin({ urlFingerprint: "  ", settingFingerprint: "" }),
    ).toEqual({});
  });

  it("accepts the same pin written two ways (colon-hex vs flat)", () => {
    const colons = PIN.match(/.{2}/g)!.join(":").toLowerCase();
    expect(
      resolveGatewayPin({ urlFingerprint: PIN, settingFingerprint: colons }),
    ).toEqual({ fingerprint: PIN });
  });

  it("FAILS CLOSED when the two disagree instead of picking by precedence", () => {
    // One of them is stale or mistyped; silently preferring either would be a
    // trust decision the operator never saw.
    expect(() =>
      resolveGatewayPin({
        urlFingerprint: PIN,
        settingFingerprint: "92" + PIN.slice(2),
      }),
    ).toThrow(/disagree/i);
  });

  it("never puts a full pin in the disagreement message", () => {
    try {
      resolveGatewayPin({
        urlFingerprint: PIN,
        settingFingerprint: "92" + PIN.slice(2),
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(PIN);
    }
  });
});

describe("resolveGatewayToken (S4 — env overrides the setting)", () => {
  it("uses the setting, trimmed, when no env is set", () => {
    expect(resolveGatewayToken({ gatewayToken: "  s3cr3t " })).toBe("s3cr3t");
  });

  it("CLOAKCODE_GATEWAY_TOKEN (env) overrides the setting", () => {
    expect(
      resolveGatewayToken({
        gatewayToken: "from-setting",
        envGatewayToken: "  from-env ",
      }),
    ).toBe("from-env");
  });

  it("falls back to the setting when env is empty/whitespace", () => {
    expect(
      resolveGatewayToken({
        gatewayToken: "from-setting",
        envGatewayToken: "   ",
      }),
    ).toBe("from-setting");
  });

  it("is undefined when neither is set (loopback dev / sign-in path)", () => {
    expect(resolveGatewayToken({ gatewayToken: undefined })).toBeUndefined();
    expect(
      resolveGatewayToken({ gatewayToken: "  ", envGatewayToken: "" }),
    ).toBeUndefined();
  });
});
