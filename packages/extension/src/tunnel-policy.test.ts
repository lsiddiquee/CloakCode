import { describe, expect, it } from "vitest";
import { tunnelFixAction } from "./tunnel-policy";

describe("tunnelFixAction", () => {
  it("guides sign-in on an auth error even on a silent activation", () => {
    // The user opted into the tunnel; a silent reload must still trigger login.
    expect(tunnelFixAction("auth", true)).toBe("guide-auth");
    expect(tunnelFixAction("auth", false)).toBe("guide-auth");
  });

  it("guides install on a missing-CLI error even on a silent activation", () => {
    expect(tunnelFixAction("missing", true)).toBe("guide-missing");
    expect(tunnelFixAction("missing", false)).toBe("guide-missing");
  });

  it("stays quiet on a generic/unknown failure during a silent activation", () => {
    expect(tunnelFixAction("other", true)).toBe("ignore");
    expect(tunnelFixAction("unknown", true)).toBe("ignore");
  });

  it("surfaces a generic/unknown failure on an explicit request", () => {
    expect(tunnelFixAction("other", false)).toBe("show-error");
    expect(tunnelFixAction("unknown", false)).toBe("show-error");
  });
});
