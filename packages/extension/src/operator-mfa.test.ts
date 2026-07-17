import { describe, it, expect } from "vitest";
import {
  OPERATOR_SECRET_KEY,
  embeddedExposed,
  loadOrCreateOperatorSecret,
  type SecretStore,
} from "./operator-mfa.js";

/** In-memory SecretStorage double. */
function fakeSecrets(seed: Record<string, string> = {}): SecretStore & {
  dump: () => Record<string, string>;
} {
  const map = new Map(Object.entries(seed));
  return {
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    dump: () => Object.fromEntries(map),
  };
}

describe("loadOrCreateOperatorSecret", () => {
  it("generates + stores a base32 secret on first use", async () => {
    const secrets = fakeSecrets();
    const res = await loadOrCreateOperatorSecret(secrets);
    expect(res.created).toBe(true);
    expect(res.secret).toMatch(/^[A-Z2-7]+$/);
    expect(secrets.dump()[OPERATOR_SECRET_KEY]).toBe(res.secret);
  });

  it("returns the stored secret unchanged on later use", async () => {
    const secrets = fakeSecrets({
      [OPERATOR_SECRET_KEY]: "STOREDSECRET234567",
    });
    const res = await loadOrCreateOperatorSecret(secrets);
    expect(res).toEqual({ secret: "STOREDSECRET234567", created: false });
  });

  it("regenerates when the stored value is blank", async () => {
    const secrets = fakeSecrets({ [OPERATOR_SECRET_KEY]: "   " });
    const res = await loadOrCreateOperatorSecret(secrets);
    expect(res.created).toBe(true);
    expect(res.secret.length).toBeGreaterThan(0);
  });
});

describe("embeddedExposed", () => {
  it("is true with a managed Dev Tunnel or a public URL", () => {
    expect(embeddedExposed({ tunnel: "devtunnel" })).toBe(true);
    expect(embeddedExposed({ publicUrl: "https://x.example" })).toBe(true);
  });
  it("is false for pure loopback (no tunnel, no public URL)", () => {
    expect(embeddedExposed({})).toBe(false);
    expect(embeddedExposed({ tunnel: "off", publicUrl: "  " })).toBe(false);
  });
});
