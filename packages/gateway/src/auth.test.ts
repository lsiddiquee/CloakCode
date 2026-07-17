import { describe, it, expect } from "vitest";
import { verifyGatewayToken, verifyProviderCredential } from "./auth.js";

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

describe("verifyProviderCredential", () => {
  it("is OPEN when neither a static token nor a token verifier is configured", () => {
    expect(verifyProviderCredential(undefined, {})).toBe(true);
    expect(verifyProviderCredential("anything", {})).toBe(true);
  });

  it("accepts the matching static token (escape hatch)", () => {
    expect(verifyProviderCredential("s3cret", { staticToken: "s3cret" })).toBe(
      true,
    );
    expect(verifyProviderCredential("wrong", { staticToken: "s3cret" })).toBe(
      false,
    );
    expect(verifyProviderCredential(undefined, { staticToken: "s3cret" })).toBe(
      false,
    );
  });

  it("accepts a valid TOTP-issued session token (interactive path)", () => {
    const verifyToken = (t: string) => t === "good-token";
    expect(verifyProviderCredential("good-token", { verifyToken })).toBe(true);
    expect(verifyProviderCredential("bad", { verifyToken })).toBe(false);
    expect(verifyProviderCredential(undefined, { verifyToken })).toBe(false);
  });

  it("accepts EITHER form when both are configured", () => {
    const opts = {
      staticToken: "s3cret",
      verifyToken: (t: string) => t === "good-token",
    };
    expect(verifyProviderCredential("s3cret", opts)).toBe(true);
    expect(verifyProviderCredential("good-token", opts)).toBe(true);
    expect(verifyProviderCredential("neither", opts)).toBe(false);
  });
});
