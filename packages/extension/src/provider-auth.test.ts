import { afterEach, describe, expect, it } from "vitest";
import { startGateway, OperatorAuth, type Gateway } from "@cloakcode/gateway";
import {
  exchangeCodeForToken,
  providerTokenKey,
  resolveProviderCredential,
  storeProviderToken,
  type SecretStore,
} from "./provider-auth.js";

// RFC 6238 seed "12345678901234567890" as base32; code "287082" valid at t=59s.
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow

/** In-memory SecretStorage double. */
function fakeSecrets(seed: Record<string, string> = {}): SecretStore {
  const map = new Map(Object.entries(seed));
  return {
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
  };
}

describe("providerTokenKey", () => {
  it("is namespaced per gateway URL", () => {
    expect(providerTokenKey("ws://a:1")).not.toBe(providerTokenKey("ws://b:2"));
    expect(providerTokenKey("ws://a:1")).toContain("ws://a:1");
  });
});

describe("resolveProviderCredential", () => {
  it("prefers a stored token, then the static token, else none", async () => {
    const url = "ws://gw:7900";
    const withToken = fakeSecrets({ [providerTokenKey(url)]: "tok-1" });
    expect(await resolveProviderCredential(withToken, url, "static")).toBe(
      "tok-1",
    );
    const empty = fakeSecrets();
    expect(await resolveProviderCredential(empty, url, "static")).toBe(
      "static",
    );
    expect(
      await resolveProviderCredential(empty, url, undefined),
    ).toBeUndefined();
  });

  it("round-trips a stored token", async () => {
    const url = "ws://gw:7900";
    const secrets = fakeSecrets();
    await storeProviderToken(secrets, url, "tok-2");
    expect(await resolveProviderCredential(secrets, url)).toBe("tok-2");
  });
});

describe("exchangeCodeForToken (integration)", () => {
  const secret = SECRET;
  let gw: Gateway | undefined;
  afterEach(async () => {
    await gw?.close();
    gw = undefined;
  });

  it("exchanges a valid code for a token, and the gateway accepts it as a provider credential", async () => {
    const operatorAuth = new OperatorAuth({
      secret,
      now: () => 59_000,
      confirmed: true,
    });
    gw = await startGateway({ port: 0, operatorAuth });
    const url = `ws://127.0.0.1:${gw.port}`;
    const token = await exchangeCodeForToken(url, "287082", true);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    // The token verifies against the same secret the gateway holds.
    expect(operatorAuth.verifyToken(token)).toBe(true);
  });

  it("rejects a bad code", async () => {
    const operatorAuth = new OperatorAuth({
      secret,
      now: () => 59_000,
      confirmed: true,
    });
    gw = await startGateway({ port: 0, operatorAuth });
    const url = `ws://127.0.0.1:${gw.port}`;
    await expect(exchangeCodeForToken(url, "000000")).rejects.toThrow();
  });
});
