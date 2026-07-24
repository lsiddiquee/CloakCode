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

  it("passes the gateway's advertised instance-id to onAuthRequired (OTP hint)", async () => {
    const operatorAuth = new OperatorAuth({
      secret,
      now: () => 59_000,
      confirmed: true,
    });
    // The gateway advertises its own instance-id on provider.auth_required so the
    // extension's sign-in prompt can name which instance the code is for.
    gw = await startGateway({ port: 0, operatorAuth, instanceId: "office" });
    let seenInstanceId: string | undefined;
    client = await connectGateway(
      `ws://127.0.0.1:${gw.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      undefined,
      async (instanceId) => {
        seenInstanceId = instanceId;
        return "287082";
      },
      () => {},
    );
    expect(seenInstanceId).toBe("office");
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

  // --- The handshake permutation matrix (simulating the real user flow). The
  // only thing ever shared with the "user" side (onAuthRequired) is the TOTP
  // CODE; the provider token is obtained solely from the exchange (onToken) and
  // reused — never injected out-of-band. ---

  it("no MFA, no token: registers on the open loopback-dev gateway", async () => {
    gw = await startGateway({ port: 0 });
    client = await connectGateway(
      `ws://127.0.0.1:${gw.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      undefined, // no credential — an open gateway accepts it
    );
    expect(gw.registry.all().length).toBe(1);
  });

  it("no MFA, correct static secret: registers", async () => {
    gw = await startGateway({ port: 0, token: "s3cret-shared" });
    client = await connectGateway(
      `ws://127.0.0.1:${gw.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      "s3cret-shared",
    );
    expect(gw.registry.all().length).toBe(1);
  });

  it("no MFA, wrong static secret: rejected, never registers", async () => {
    gw = await startGateway({ port: 0, token: "s3cret-shared" });
    await expect(
      connectGateway(
        `ws://127.0.0.1:${gw.providerPort}`,
        { instanceId: "i1" },
        deps,
        () => {},
        1500,
        "wrong-secret", // a bad static token can never register
      ),
    ).rejects.toThrow();
    expect(gw.registry.all().length).toBe(0);
  });

  it("MFA: reuses the exchange-issued token on reconnect, no second code", async () => {
    const operatorAuth = new OperatorAuth({
      secret,
      now: () => 59_000,
      confirmed: true,
    });
    gw = await startGateway({ port: 0, operatorAuth });
    // First connect: the user enters a CODE (the only shared secret); capture the
    // provider token the gateway mints.
    let issued: string | undefined;
    const first = await connectGateway(
      `ws://127.0.0.1:${gw.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      undefined,
      async () => "287082",
      (t) => {
        issued = t;
      },
    );
    expect(issued).toBeDefined();
    first.close();

    // Second connect: present the CAPTURED token (not a code). It registers with
    // no sign-in prompt — onAuthRequired must NOT be called (a resolve means the
    // gateway pushed gateway.info, which only happens after registration).
    let askedAgain = false;
    client = await connectGateway(
      `ws://127.0.0.1:${gw.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      issued, // the token the FIRST exchange minted — reused, never shared as a code
      async () => {
        askedAgain = true;
        return "287082";
      },
    );
    expect(askedAgain).toBe(false);
  });

  it("MFA: a wrong-audience (operator) token falls through to code sign-in", async () => {
    const operatorAuth = new OperatorAuth({
      secret,
      now: () => 59_000,
      confirmed: true,
    });
    gw = await startGateway({ port: 0, operatorAuth });
    // An OPERATOR-scoped token (minted via a throwaway so the gateway's own replay
    // guard is untouched) must be rejected at the provider boundary (S3); the user
    // then signs in with a code — the token they end up with is PROVIDER-scoped.
    const minter = new OperatorAuth({
      secret,
      now: () => 59_000,
      confirmed: true,
    });
    const { token: operatorToken } = minter.submitCode("287082", true);
    let stored: string | undefined;
    client = await connectGateway(
      `ws://127.0.0.1:${gw.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      operatorToken, // wrong audience → rejected → sign-in required
      async () => "287082", // the user enters a code (the only thing shared)
      (t) => {
        stored = t;
      },
    );
    expect(stored).toBeDefined();
    expect(operatorAuth.verifyToken(stored!, "provider")).toBe(true);
    expect(operatorAuth.verifyToken(stored!, "operator")).toBe(false);
    expect(gw.registry.all().length).toBe(1);
  });
});
