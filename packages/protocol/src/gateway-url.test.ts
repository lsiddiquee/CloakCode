import { describe, expect, it } from "vitest";
import {
  formatPinnedGatewayUrl,
  normalizeFingerprint,
  redactPinnedGatewayUrl,
  shortFingerprint,
  splitPinnedGatewayUrl,
} from "./gateway-url.js";

const PIN =
  "82:F2:00:36:F2:E8:52:DA:73:B0:69:79:0D:BA:6F:20:29:99:78:FB:E3:95:1B:DD:F3:EA:03:19:F0:69:72:93";
const FLAT = "82F20036F2E852DA73B069790DBA6F20299978FBE3951BDDF3EA0319F0697293";

describe("normalizeFingerprint", () => {
  it("canonicalizes colon-hex, spaces and case", () => {
    expect(normalizeFingerprint(PIN)).toBe(FLAT);
    expect(normalizeFingerprint(" 82 f2 00 36 ")).toBe("82F20036");
  });
});

describe("shortFingerprint", () => {
  it("shows a comparable prefix and never the full value", () => {
    const short = shortFingerprint(PIN);
    expect(short).toBe("82F20036F2E8\u2026");
    expect(FLAT).not.toBe(short);
    expect(FLAT.startsWith(short.slice(0, -1))).toBe(true);
  });
});

describe("formatPinnedGatewayUrl", () => {
  it("carries the pin in the FRAGMENT so it never reaches the server", () => {
    // A query string would land in the gateway's own access log; a fragment is
    // never transmitted. The pin is public, but the URL should stay a URL.
    expect(formatPinnedGatewayUrl("wss://hub:7901", PIN)).toBe(
      `wss://hub:7901#fp=${FLAT}`,
    );
  });

  it("round-trips through the splitter", () => {
    const joined = formatPinnedGatewayUrl("wss://hub:7901", PIN);
    expect(splitPinnedGatewayUrl(joined)).toEqual({
      url: "wss://hub:7901",
      fingerprint: FLAT,
    });
  });

  it("replaces an existing pin rather than appending a second one", () => {
    const once = formatPinnedGatewayUrl("wss://hub:7901#fp=" + FLAT, PIN);
    expect(once).toBe(`wss://hub:7901#fp=${FLAT}`);
  });
});

describe("splitPinnedGatewayUrl", () => {
  it("returns a plain URL unchanged, with no pin", () => {
    expect(splitPinnedGatewayUrl("  wss://hub:7901 ")).toEqual({
      url: "wss://hub:7901",
    });
  });

  it("accepts a pasted colon-hex pin and normalizes it", () => {
    expect(splitPinnedGatewayUrl(`wss://hub:7901#fp=${PIN}`)).toEqual({
      url: "wss://hub:7901",
      fingerprint: FLAT,
    });
  });

  it("keeps path and query, dropping only the fragment", () => {
    expect(
      splitPinnedGatewayUrl(`wss://hub:7901/bridge?x=1#fp=${FLAT}`),
    ).toEqual({ url: "wss://hub:7901/bridge?x=1", fingerprint: FLAT });
  });

  it("REJECTS a malformed pin instead of silently connecting unpinned", () => {
    // Silently dropping an unparsable pin would downgrade a pinned link to an
    // unpinned one — the failure mode pinning exists to prevent.
    expect(() => splitPinnedGatewayUrl("wss://hub:7901#fp=nothex")).toThrow(
      /64 hex/i,
    );
    expect(() =>
      splitPinnedGatewayUrl(`wss://hub:7901#fp=${FLAT.slice(0, 60)}`),
    ).toThrow(/64 hex/i);
  });

  it("REJECTS an unrecognized fragment rather than ignoring it", () => {
    expect(() => splitPinnedGatewayUrl("wss://hub:7901#pin=abc")).toThrow(
      /#fp=/,
    );
  });

  it("treats an empty fragment as no pin", () => {
    expect(splitPinnedGatewayUrl("wss://hub:7901#")).toEqual({
      url: "wss://hub:7901",
    });
  });
});

describe("redactPinnedGatewayUrl", () => {
  it("truncates the pin so logging a URL cannot reprint it in full", () => {
    const redacted = redactPinnedGatewayUrl(`wss://hub:7901#fp=${FLAT}`);
    expect(redacted).toBe("wss://hub:7901#fp=82F20036F2E8\u2026");
    expect(redacted).not.toContain(FLAT);
  });

  it("passes a plain URL through untouched", () => {
    expect(redactPinnedGatewayUrl("wss://hub:7901")).toBe("wss://hub:7901");
  });

  it("never throws on a malformed URL (it is on the logging path)", () => {
    expect(redactPinnedGatewayUrl("wss://hub:7901#garbage")).toBe(
      "wss://hub:7901#garbage",
    );
    expect(redactPinnedGatewayUrl("")).toBe("");
  });
});
