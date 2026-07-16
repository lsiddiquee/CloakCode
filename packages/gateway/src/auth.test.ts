import { describe, it, expect } from "vitest";
import { verifyGatewayToken } from "./auth.js";

describe("verifyGatewayToken", () => {
  it("is OPEN when no token is configured (auth disabled)", () => {
    expect(verifyGatewayToken(undefined, undefined)).toBe(true);
    expect(verifyGatewayToken(undefined, "anything")).toBe(true);
    expect(verifyGatewayToken("", "anything")).toBe(true); // empty = unset
  });

  it("requires a matching token when one is configured", () => {
    expect(verifyGatewayToken("s3cret", "s3cret")).toBe(true);
    expect(verifyGatewayToken("s3cret", "wrong")).toBe(false);
    expect(verifyGatewayToken("s3cret", undefined)).toBe(false);
    expect(verifyGatewayToken("s3cret", "")).toBe(false);
  });

  it("rejects a length-mismatched token without throwing (timing-safe path)", () => {
    expect(verifyGatewayToken("short", "a-much-longer-token")).toBe(false);
  });
});
