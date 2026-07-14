import { describe, it, expect } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import { connectionUrls } from "./connect-urls.js";

function v4(address: string, internal: boolean): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

function v6(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

describe("connectionUrls", () => {
  it("wide bind lists loopback, each non-internal IPv4, and a docker hint", () => {
    const urls = connectionUrls("0.0.0.0", 7900, {
      lo: [v4("127.0.0.1", true)],
      eth0: [v4("172.20.0.5", false)],
    });
    const flat = urls.map((u) => u.url);
    expect(flat).toContain("ws://127.0.0.1:7900");
    expect(flat).toContain("ws://172.20.0.5:7900");
    expect(flat).toContain("ws://host.docker.internal:7900");
    // The internal loopback iface is not repeated as a LAN entry.
    expect(flat.filter((u) => u.includes("127.0.0.1"))).toHaveLength(1);
    // Loopback leads.
    expect(urls[0]?.url).toBe("ws://127.0.0.1:7900");
  });

  it("skips IPv6 and internal addresses", () => {
    const urls = connectionUrls("0.0.0.0", 7900, {
      eth0: [v4("10.0.0.2", false), v6("fe80::1")],
      docker0: [v4("172.17.0.1", true)],
    });
    const flat = urls.map((u) => u.url);
    expect(flat).toContain("ws://10.0.0.2:7900");
    expect(flat).not.toContain("ws://fe80::1:7900");
    expect(flat).not.toContain("ws://172.17.0.1:7900");
  });

  it("loopback bind offers only the same-machine URL", () => {
    const urls = connectionUrls("127.0.0.1", 7900, {
      eth0: [v4("172.20.0.5", false)],
    });
    expect(urls).toEqual([
      { url: "ws://127.0.0.1:7900", label: "same machine" },
    ]);
  });

  it("a specific bind address leads, then loopback", () => {
    const urls = connectionUrls("192.168.1.50", 7900, {});
    expect(urls[0]?.url).toBe("ws://192.168.1.50:7900");
    expect(urls.map((u) => u.url)).toContain("ws://127.0.0.1:7900");
  });
});
