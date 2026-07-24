import { afterEach, describe, expect, it } from "vitest";
import { startGateway, OperatorAuth, type Gateway } from "@cloakcode/gateway";
import {
  providerTokenKey,
  resolveProviderCredential,
  storeProviderToken,
  type SecretStore,
} from "./provider-auth.js";
import {
  connectGateway,
  GatewayAuthRequiredError,
  type GatewayClient,
} from "./gateway-client.js";
import type { BridgeDeps } from "./bridge.js";

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

describe("connectGateway provider sign-in (integration, one socket)", () => {
  const secret = SECRET;
  const deps: BridgeDeps = {
    listSessions: async () => [],
    findTranscript: async () => undefined,
    findSessionLog: async () => undefined,
  };
  let gw: Gateway | undefined;
  let client: GatewayClient | undefined;
  afterEach(async () => {
    client?.close();
    client = undefined;
    await gw?.close();
    gw = undefined;
  });

  it("signs in over the provider connection with a code, stores the token, and registers", async () => {
    const operatorAuth = new OperatorAuth({
      secret,
      now: () => 59_000,
      confirmed: true,
    });
    gw = await startGateway({ port: 0, operatorAuth });
    let stored: string | undefined;
    client = await connectGateway(
      `ws://127.0.0.1:${gw.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      undefined, // no stored credential → the gateway asks for sign-in
      async () => "287082", // onAuthRequired → the TOTP code, over the SAME socket
      (t) => {
        stored = t;
      },
    );
    // Registered as a provider; the issued token is PROVIDER-scoped (S3) + stored.
    expect(stored).toBeDefined();
    expect(operatorAuth.verifyToken(stored!, "provider")).toBe(true);
    expect(operatorAuth.verifyToken(stored!, "operator")).toBe(false);
    expect(gw.registry.all().length).toBe(1);
  });

  it("rejects a bad code with GatewayAuthRequiredError, without registering", async () => {
    const operatorAuth = new OperatorAuth({
      secret,
      now: () => 59_000,
      confirmed: true,
    });
    gw = await startGateway({ port: 0, operatorAuth });
    await expect(
      connectGateway(
        `ws://127.0.0.1:${gw.providerPort}`,
        { instanceId: "i1" },
        deps,
        () => {},
        4000,
        undefined,
        async () => "000000",
      ),
    ).rejects.toBeInstanceOf(GatewayAuthRequiredError);
    expect(gw.registry.all().length).toBe(0);
  });

  it("rejects with GatewayAuthRequiredError when no code is supplied", async () => {
    const operatorAuth = new OperatorAuth({
      secret,
      now: () => 59_000,
      confirmed: true,
    });
    gw = await startGateway({ port: 0, operatorAuth });
    await expect(
      connectGateway(
        `ws://127.0.0.1:${gw.providerPort}`,
        { instanceId: "i1" },
        deps,
        () => {},
        4000,
        undefined,
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(GatewayAuthRequiredError);
    expect(gw.registry.all().length).toBe(0);
  });
});
