import { describe, it, expect } from "vitest";
import { qrTerminal } from "./qr-terminal.js";

describe("qrTerminal", () => {
  it("renders a non-empty block of half-block rows", () => {
    const out = qrTerminal("otpauth://totp/CloakCode:gateway?secret=ABC");
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(10);
    // Rows are padded to the same width (the QR is square).
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    // Uses the half-block alphabet only.
    expect(out).toMatch(/^[█▀▄ \n]+$/u);
    expect(out).toContain("█");
  });

  it("is deterministic and input-sensitive", () => {
    expect(qrTerminal("same")).toBe(qrTerminal("same"));
    expect(qrTerminal("a")).not.toBe(qrTerminal("b"));
  });
});
