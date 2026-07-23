import { describe, it, expect } from "vitest";
import { Secret } from "otpauth";
import { strictEnrolmentLines } from "./enrol-console.js";

const SECRET = Secret.fromLatin1("12345678901234567890").base32;

describe("strictEnrolmentLines (S7 — never leak the TOTP seed to a log sink)", () => {
  it("on a TTY shows a QR but never the plaintext secret or otpauth URI", () => {
    const out = strictEnrolmentLines({
      isTTY: true,
      secret: SECRET,
      account: "office",
      file: "/data/operator-totp.secret",
    }).join("\n");
    expect(out).toContain("scan this QR");
    // The QR encodes the seed as unicode blocks — the base32 secret and the
    // otpauth URI text must NOT appear in plaintext.
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("otpauth://");
  });

  it("headless (no TTY) prints no seed and points at the 0600 file", () => {
    const out = strictEnrolmentLines({
      isTTY: false,
      secret: SECRET,
      account: "office",
      file: "/data/operator-totp.secret",
    }).join("\n");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("otpauth://");
    expect(out).toContain("/data/operator-totp.secret");
    expect(out).toContain("browser enrolment");
  });
});
