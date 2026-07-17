import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isExposed,
  loadOrCreateSecret,
  operatorMfaEnabled,
  resolveSecretFile,
} from "./operator-secret.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cc-secret-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("isExposed", () => {
  it("is false for pure loopback with no tunnel", () => {
    expect(isExposed("127.0.0.1", {})).toBe(false);
    expect(isExposed("localhost", {})).toBe(false);
  });
  it("is true for a wide bind", () => {
    expect(isExposed("0.0.0.0", {})).toBe(true);
    expect(isExposed("192.168.1.10", {})).toBe(true);
  });
  it("is true for loopback with a live tunnel", () => {
    expect(isExposed("127.0.0.1", { CLOAKCODE_TUNNEL: "devtunnel" })).toBe(
      true,
    );
  });
});

describe("operatorMfaEnabled", () => {
  it("honours an explicit off", () => {
    for (const v of ["off", "false", "0", "disabled"]) {
      expect(operatorMfaEnabled({ CLOAKCODE_MFA: v }, true)).toBe(false);
    }
  });
  it("honours an explicit on", () => {
    for (const v of ["required", "on", "true", "1"]) {
      expect(operatorMfaEnabled({ CLOAKCODE_MFA: v }, false)).toBe(true);
    }
  });
  it("falls back to exposure when unset", () => {
    expect(operatorMfaEnabled({}, true)).toBe(true);
    expect(operatorMfaEnabled({}, false)).toBe(false);
  });
});

describe("resolveSecretFile", () => {
  it("prefers the explicit override", () => {
    expect(
      resolveSecretFile(
        { CLOAKCODE_MFA_SECRET_FILE: "/data/s.secret" },
        "/home/x",
      ),
    ).toBe("/data/s.secret");
  });
  it("defaults under ~/.cloakcode", () => {
    expect(resolveSecretFile({}, "/home/x")).toBe(
      "/home/x/.cloakcode/operator-totp.secret",
    );
  });
});

describe("loadOrCreateSecret", () => {
  it("generates + persists a 0600 secret on first run, then loads it back", () => {
    const file = join(tmp(), "nested", "operator-totp.secret");
    const first = loadOrCreateSecret(file);
    expect(first.created).toBe(true);
    expect(first.secret).toMatch(/^[A-Z2-7]+$/); // base32
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const second = loadOrCreateSecret(file);
    expect(second).toEqual({ secret: first.secret, created: false });
  });

  it("regenerates when the file is present but empty", () => {
    const file = join(tmp(), "empty.secret");
    writeFileSync(file, "   \n");
    const res = loadOrCreateSecret(file);
    expect(res.created).toBe(true);
    expect(res.secret.length).toBeGreaterThan(0);
  });
});
