import { describe, expect, it } from "vitest";
import {
  classifyTunnelError,
  devTunnelInstallHint,
  devTunnelName,
  parseTunnelUrl,
} from "./tunnel.js";

describe("parseTunnelUrl", () => {
  it("extracts the first devtunnels.ms URL from host output", () => {
    const out = [
      "Hosting port: 7801",
      "Connect via browser: https://cloakcode-ab12cd34-7801.euw.devtunnels.ms",
      "Inspect network activity: https://cloakcode-ab12cd34-7801-inspect.euw.devtunnels.ms",
    ].join("\n");
    expect(parseTunnelUrl(out)).toBe(
      "https://cloakcode-ab12cd34-7801.euw.devtunnels.ms",
    );
  });

  it("returns undefined when no URL is present", () => {
    expect(parseTunnelUrl("Hosting port: 7801\nReady")).toBeUndefined();
  });
});

describe("devTunnelName", () => {
  it("is deterministic and namespaced", () => {
    expect(devTunnelName("ext-dev")).toBe(devTunnelName("ext-dev"));
    expect(devTunnelName("ext-dev")).toMatch(/^cloakcode-[0-9a-f]{8}$/);
  });

  it("differs per environment seed", () => {
    expect(devTunnelName("host")).not.toBe(devTunnelName("wsl-ubuntu"));
  });
});

describe("devTunnelInstallHint", () => {
  it("gives a platform-specific install command", () => {
    expect(devTunnelInstallHint("darwin")).toContain("brew");
    expect(devTunnelInstallHint("linux")).toContain("aka.ms");
    expect(devTunnelInstallHint("win32")).toContain("winget");
  });
});

describe("classifyTunnelError", () => {
  it("flags a missing CLI (ENOENT)", () => {
    expect(classifyTunnelError({ code: "ENOENT" })).toBe("missing");
  });

  it("flags an auth failure from the message or stderr", () => {
    expect(classifyTunnelError(new Error("User is not authorized"))).toBe(
      "auth",
    );
    expect(
      classifyTunnelError({}, "Please sign in: devtunnel user login"),
    ).toBe("auth");
  });

  it("falls back to 'other' for anything else", () => {
    expect(classifyTunnelError(new Error("network blip"))).toBe("other");
  });
});
