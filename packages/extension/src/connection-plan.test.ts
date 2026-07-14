import { describe, it, expect } from "vitest";
import { resolveConnectionPlan } from "./connection-plan.js";

const base = {
  gatewayUrl: undefined as string | undefined,
  gatewayDiscovery: false,
  gatewayPort: 7900,
  gatewayHosts: [] as string[],
  envHosts: undefined as string | undefined,
};

describe("resolveConnectionPlan", () => {
  it("uses an explicit gatewayUrl (trimmed) — highest priority, even with discovery on", () => {
    expect(
      resolveConnectionPlan({
        ...base,
        gatewayUrl: "  ws://hub:7900 ",
        gatewayDiscovery: true,
        envHosts: "10.0.0.5",
      }),
    ).toEqual({ kind: "gateway", url: "ws://hub:7900" });
  });

  it("is embedded when no url, discovery off, and no env hosts", () => {
    expect(resolveConnectionPlan(base)).toEqual({ kind: "embedded" });
  });

  it("treats a whitespace-only url as unset", () => {
    expect(resolveConnectionPlan({ ...base, gatewayUrl: "   " })).toEqual({
      kind: "embedded",
    });
  });

  it("discovers when gatewayDiscovery is on (setting)", () => {
    expect(
      resolveConnectionPlan({
        ...base,
        gatewayDiscovery: true,
        gatewayPort: 7901,
        gatewayHosts: ["10.0.0.5"],
      }),
    ).toEqual({ kind: "discover", port: 7901, hosts: ["10.0.0.5"] });
  });

  it("env hosts ENABLE discovery even when the setting is off, appended after configured hosts", () => {
    expect(
      resolveConnectionPlan({
        ...base,
        gatewayHosts: ["10.0.0.5"],
        envHosts: "172.20.0.1, 192.168.1.9 ,",
      }),
    ).toEqual({
      kind: "discover",
      port: 7900,
      hosts: ["10.0.0.5", "172.20.0.1", "192.168.1.9"],
    });
  });

  it("ignores a blank env value (an unset HOST_IP must not enable discovery)", () => {
    expect(resolveConnectionPlan({ ...base, envHosts: "  , ," })).toEqual({
      kind: "embedded",
    });
  });
});
