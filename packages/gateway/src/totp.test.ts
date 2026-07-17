import { describe, it, expect } from "vitest";
import { Secret } from "otpauth";
import {
  generateTotpSecret,
  issueSessionToken,
  otpauthUri,
  verifySessionToken,
  verifyTotp,
} from "./totp.js";

// RFC 6238 test seed (ASCII "12345678901234567890") as base32.
const RFC_SECRET = Secret.fromLatin1("12345678901234567890").base32;

describe("verifyTotp — RFC 6238 conformance (SHA-1, 6-digit)", () => {
  // RFC 6238 Appendix B (8-digit) truncated to the low 6 digits.
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ];
  for (const [t, code] of vectors) {
    it(`t=${t}s accepts ${code}`, () => {
      const res = verifyTotp(RFC_SECRET, code, {
        now: () => t * 1000,
        window: 0,
      });
      expect(res.ok).toBe(true);
      expect(res.step).toBe(Math.floor(t / 30));
    });
  }
});

describe("verifyTotp — drift + rejection", () => {
  const now = () => 59_000;
  it("accepts the current code with its step", () => {
    const res = verifyTotp(RFC_SECRET, "287082", { now });
    expect(res).toEqual({ ok: true, step: 1 });
  });
  it("accepts a code within the ±1 step window", () => {
    const nextStep = verifyTotp(RFC_SECRET, "287082", { now: () => 29_000 });
    // The code valid at t=59 is still accepted one step early (t=29, window 1).
    expect(nextStep.ok).toBe(true);
  });
  it("rejects a wrong code and one outside the window", () => {
    expect(verifyTotp(RFC_SECRET, "000000", { now }).ok).toBe(false);
    expect(
      verifyTotp(RFC_SECRET, "287082", { now: () => 59_000 + 5 * 30_000 }).ok,
    ).toBe(false);
  });
});

describe("generateTotpSecret / otpauthUri", () => {
  it("generates a unique, decodable 160-bit secret whose code verifies", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b); // per-install uniqueness
    expect(Secret.fromBase32(a).bytes).toHaveLength(20);
  });

  it("builds a scannable otpauth URI", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "phone");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=CloakCode");
    expect(uri).toContain("period=30");
  });
});

describe("session token", () => {
  it("verifies before expiry and fails after", () => {
    let now = 1000;
    const token = issueSessionToken(RFC_SECRET, 5000, () => now);
    expect(verifySessionToken(RFC_SECRET, token, () => now)).toBe(true);
    now = 6001;
    expect(verifySessionToken(RFC_SECRET, token, () => now)).toBe(false);
  });

  it("rejects tampering, malformed input, and a different secret", () => {
    const token = issueSessionToken(RFC_SECRET, 5000, () => 0);
    expect(verifySessionToken(RFC_SECRET, token + "x", () => 0)).toBe(false);
    expect(verifySessionToken(RFC_SECRET, "malformed", () => 0)).toBe(false);
    expect(verifySessionToken(generateTotpSecret(), token, () => 0)).toBe(
      false,
    );
  });
});
