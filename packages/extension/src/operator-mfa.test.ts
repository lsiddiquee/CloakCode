import { describe, it, expect } from "vitest";
import {
  OPERATOR_CONFIRMED_KEY,
  OPERATOR_SECRET_KEY,
  embeddedExposed,
  isOperatorConfirmed,
  loadOrCreateOperatorSecret,
  markOperatorConfirmed,
  resetOperatorSecret,
  type MementoLike,
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

/** In-memory Memento (globalState) double. */
function fakeState(seed: Record<string, unknown> = {}): MementoLike {
  const map = new Map(Object.entries(seed));
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    update: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
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

describe("confirmed flag + reset", () => {
  it("reads unconfirmed by default and confirmed once marked", async () => {
    const state = fakeState();
    expect(isOperatorConfirmed(state)).toBe(false);
    await markOperatorConfirmed(state);
    expect(isOperatorConfirmed(state)).toBe(true);
    expect(state.get(OPERATOR_CONFIRMED_KEY)).toBe(true);
  });

  it("reset clears the secret and the confirmed flag (forces re-enrolment)", async () => {
    const secrets = fakeSecrets({ [OPERATOR_SECRET_KEY]: "OLDSECRET234567" });
    const state = fakeState({ [OPERATOR_CONFIRMED_KEY]: true });
    await resetOperatorSecret(secrets, state);
    expect(isOperatorConfirmed(state)).toBe(false);
    // Next load regenerates a fresh secret (the cleared value is blank).
    const res = await loadOrCreateOperatorSecret(secrets);
    expect(res.created).toBe(true);
    expect(res.secret).not.toBe("OLDSECRET234567");
  });
});
