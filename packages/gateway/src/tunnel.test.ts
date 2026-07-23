import { describe, expect, it } from "vitest";
import {
  classifyTunnelError,
  devTunnelInstallHint,
  devTunnelName,
  isExistsConflict,
  parsePortList,
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

  it("prefers the URL matching the given port", () => {
    const out = [
      "Connect via browser: https://cloakcode-ab12cd34-7801.euw.devtunnels.ms",
      "Connect via browser: https://cloakcode-ab12cd34-7803.euw.devtunnels.ms",
    ].join("\n");
    expect(parseTunnelUrl(out, 7803)).toBe(
      "https://cloakcode-ab12cd34-7803.euw.devtunnels.ms",
    );
  });

  it("ignores the inspect URL when scoping by port", () => {
    const out = [
      "Connect via browser: https://cloakcode-ab12cd34-7801.euw.devtunnels.ms",
      "Inspect: https://cloakcode-ab12cd34-7801-inspect.euw.devtunnels.ms",
    ].join("\n");
    expect(parseTunnelUrl(out, 7801)).toBe(
      "https://cloakcode-ab12cd34-7801.euw.devtunnels.ms",
    );
  });

  it("falls back to the first URL when the scoped port is absent", () => {
    const out = "Connect: https://cloakcode-ab12cd34-7801.euw.devtunnels.ms";
    expect(parseTunnelUrl(out, 9999)).toBe(
      "https://cloakcode-ab12cd34-7801.euw.devtunnels.ms",
    );
  });
});

describe("parsePortList", () => {
  it("extracts standalone port integers from a port-list table", () => {
    const out = [
      "Ports for tunnel cloakcode-2856ebf5:",
      "Port  Protocol  URI",
      "7905  https     https://cloakcode-2856ebf5-7905.usw2.devtunnels.ms/",
      "7990  https     https://cloakcode-2856ebf5-7990.usw2.devtunnels.ms/",
    ].join("\n");
    expect(parsePortList(out).sort((a, b) => a - b)).toEqual([7905, 7990]);
  });

  it("never matches a name/hash/region or a URL's embedded -<port>", () => {
    // The only bare integer token is the real port; the name, the region label,
    // and the URL (with an embedded -7443) must NOT be parsed as ports.
    const out =
      "cloakcode-2856ebf5 usw2 https://cloakcode-2856ebf5-7443.usw2.devtunnels.ms/ 7443";
    expect(parsePortList(out)).toEqual([7443]);
  });

  it("returns [] when no ports are forwarded", () => {
    expect(parsePortList("No ports are currently forwarded.")).toEqual([]);
    expect(parsePortList("")).toEqual([]);
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

describe("isExistsConflict", () => {
  it("treats 'already exists' as idempotent", () => {
    expect(isExistsConflict("Tunnel 'cloakcode-x' already exists")).toBe(true);
  });

  it("treats the service 'Conflict with existing entity' as idempotent", () => {
    expect(
      isExistsConflict(
        "Tunnel service error: Conflict with existing entity. Retry tunnel operation.",
      ),
    ).toBe(true);
  });

  it("does not swallow unrelated failures", () => {
    expect(isExistsConflict("Tunnel service error: Unauthorized")).toBe(false);
    expect(isExistsConflict("command not found")).toBe(false);
  });
});
