import { describe, it, expect } from "vitest";
import {
  resolveConnectionPlan,
  resolveGatewayToken,
} from "./connection-plan.js";

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
