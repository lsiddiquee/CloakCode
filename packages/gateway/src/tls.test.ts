import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";
import {
  certFingerprint,
  resolveTlsMaterial,
  TLS_CERT_FILE,
  TLS_KEY_FILE,
} from "./tls.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cc-tls-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// One real EC self-signed pair, reused across the deterministic tests.
let fixture: { cert: string; key: string };
beforeAll(async () => {
  const p = await generate([{ name: "commonName", value: "localhost" }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
  });
  fixture = { cert: p.cert, key: p.private };
});

describe("certFingerprint", () => {
  it("is uppercase colon-hex SHA-256 (32 octets)", () => {
    expect(certFingerprint(fixture.cert)).toMatch(
      /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/,
    );
  });

  it("is stable for the same cert", () => {
    expect(certFingerprint(fixture.cert)).toBe(certFingerprint(fixture.cert));
  });
});

describe("resolveTlsMaterial — bring-your-own", () => {
  it("reads a supplied cert/key pair and pins its fingerprint", async () => {
    const dir = tmp();
    const certFile = join(dir, "my.crt");
    const keyFile = join(dir, "my.key");
    writeFileSync(certFile, fixture.cert);
    writeFileSync(keyFile, fixture.key);

    const mat = await resolveTlsMaterial({ certFile, keyFile, storeDir: dir });

    expect(mat.source).toBe("byo");
    expect(mat.cert).toBe(fixture.cert);
    expect(mat.key).toBe(fixture.key);
    expect(mat.fingerprint).toBe(certFingerprint(fixture.cert));
  });

  it("fails loud when only one of the pair is set", async () => {
    const dir = tmp();
    await expect(
      resolveTlsMaterial({ certFile: join(dir, "x.crt"), storeDir: dir }),
    ).rejects.toThrow(/BOTH/);
    await expect(
      resolveTlsMaterial({ keyFile: join(dir, "x.key"), storeDir: dir }),
    ).rejects.toThrow(/BOTH/);
  });
});

describe("resolveTlsMaterial — generate + persist", () => {
  it("generates, persists 0600 key / 0700 dir, and pins the fingerprint", async () => {
    const dir = tmp();
    const storeDir = join(dir, "store"); // not yet created
    let calls = 0;
    const generateCert = async () => {
      calls++;
      return fixture;
    };

    const mat = await resolveTlsMaterial({ storeDir, generateCert });

    expect(calls).toBe(1);
    expect(mat.source).toBe("generated");
    expect(mat.fingerprint).toBe(certFingerprint(fixture.cert));
    // Persisted with restrictive modes (umask-independent).
    expect(statSync(storeDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(storeDir, TLS_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(storeDir, TLS_CERT_FILE), "utf8")).toBe(
      fixture.cert,
    );
  });

  it("loads the persisted pair on the next call (no re-generation)", async () => {
    const storeDir = tmp();
    let calls = 0;
    const generateCert = async () => {
      calls++;
      return fixture;
    };

    const first = await resolveTlsMaterial({ storeDir, generateCert });
    const second = await resolveTlsMaterial({ storeDir, generateCert });

    expect(calls).toBe(1); // second call used the persisted pair
    expect(second.source).toBe("loaded");
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});

describe("resolveTlsMaterial — real self-signed generator", () => {
  it("produces a usable EC cert whose fingerprint round-trips", async () => {
    const storeDir = tmp();
    const mat = await resolveTlsMaterial({ storeDir, host: "192.168.1.10" });
    expect(mat.source).toBe("generated");
    expect(mat.cert).toContain("BEGIN CERTIFICATE");
    expect(mat.key).toContain("BEGIN PRIVATE KEY");
    expect(mat.fingerprint).toBe(certFingerprint(mat.cert));
  });
});
