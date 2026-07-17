import { describe, expect, it } from "vitest";
import { resolveInstanceId } from "./instance-id.js";

describe("resolveInstanceId", () => {
  it("uses an explicit CLOAKCODE_INSTANCE_ID verbatim", () => {
    expect(resolveInstanceId("office", "MYLAPTOP")).toBe("office");
  });

  it("trims surrounding whitespace on the explicit id", () => {
    expect(resolveInstanceId("  home  ", "MYLAPTOP")).toBe("home");
  });

  it("falls back to the machine hostname when no id is set", () => {
    expect(resolveInstanceId(undefined, "MYLAPTOP")).toBe("MYLAPTOP");
    expect(resolveInstanceId("", "MYLAPTOP")).toBe("MYLAPTOP");
    expect(resolveInstanceId("   ", "MYLAPTOP")).toBe("MYLAPTOP");
  });

  it("falls back to 'gateway' only when neither id nor hostname is available", () => {
    expect(resolveInstanceId(undefined, "")).toBe("gateway");
    expect(resolveInstanceId("", "   ")).toBe("gateway");
  });
});
