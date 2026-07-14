import { describe, it, expect } from "vitest";
import { discoveryProbeUrls } from "./discovery.js";

describe("discoveryProbeUrls", () => {
  it("builds loopback + host.docker.internal ws candidates on the given port", () => {
    expect(discoveryProbeUrls(7900)).toEqual([
      "ws://127.0.0.1:7900",
      "ws://host.docker.internal:7900",
    ]);
  });

  it("appends configured extra hosts, de-duped and order-stable", () => {
    expect(discoveryProbeUrls(7900, ["172.20.0.1", "127.0.0.1", " "])).toEqual([
      "ws://127.0.0.1:7900",
      "ws://host.docker.internal:7900",
      "ws://172.20.0.1:7900",
    ]);
  });
});
