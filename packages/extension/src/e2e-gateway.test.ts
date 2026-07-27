import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
// Default (CJS) import on purpose: the test below patches `https.request` to
// simulate the extension host's agent injection, and an ESM namespace is frozen.
import https from "node:https";
import type { IncomingMessage } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { TLSSocket } from "node:tls";
import WebSocket from "ws";
import {
  OperatorAuth,
  resolveTlsMaterial,
  startGateway,
  silentLogger,
  type Gateway,
} from "@cloakcode/gateway";
import type { SessionSummary } from "@cloakcode/protocol";
import {
  connectGateway,
  GatewayAuthRequiredError,
  GatewayCertPinError,
  type GatewayClient,
} from "./gateway-client.js";
import { normalizeFingerprint } from "./gateway-tls.js";
import { parseSessionEvents } from "./session-observer.js";
import type { BridgeDeps } from "./bridge.js";

// End-to-end (F14): a REAL transcript file on disk → the extension connected as a
// PROVIDER (connectGateway) → a REAL gateway → an operator subscribing THROUGH the
// gateway. Exercises transcript parsing + the provider's serve path + the gateway
// relay + the operator round-trip in one wired flow — the seam no unit test spans.

let gateway: Gateway | undefined;
let client: GatewayClient | undefined;
let dir: string | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  await gateway?.close();
  gateway = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const summary: SessionSummary = {
  instanceId: "i1",
  sessionId: "sessE2E",
  workspace: "repo",
  workspaceHash: "H",
  title: "e2e",
  turns: 1,
  status: "active",
  idleSeconds: 0,
  owned: true,
  inTurn: false,
};

/** Open an operator socket, send `req`, resolve once `count` frames arrive. */
function operator(
  port: number,
  req: unknown,
  count: number,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const frames: Record<string, unknown>[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => ws.send(JSON.stringify(req)));
    ws.on("message", (data) => {
      frames.push(JSON.parse(data.toString()));
      if (frames.length >= count) {
        ws.close();
        resolve(frames);
      }
    });
    ws.on("error", reject);
  });
}

/**
 * Authenticate an operator socket with a TOTP `code`, then run `list` +
 * `subscribe` on the SAME connection (one code — the replay guard rejects reuse
 * across sockets) and resolve with both replies.
 */
function authedListAndSubscribe(
  port: number,
  code: string,
  sessionId: string,
): Promise<{ list: Record<string, unknown>; event: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let list: Record<string, unknown> | undefined;
    ws.on("open", () =>
      ws.send(JSON.stringify({ id: "auth", op: "auth", params: { code } })),
    );
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "auth") {
        if (!msg.ok) return reject(new Error(`auth failed: ${data}`));
        ws.send(JSON.stringify({ id: "1", op: "sessions.list" }));
        return;
      }
      if (msg.id === "1") {
        list = msg;
        ws.send(
          JSON.stringify({
            id: "2",
            op: "session.subscribe",
            params: { sessionId },
          }),
        );
        return;
      }
      if (msg.id === "2") {
        ws.close();
        resolve({ list: list!, event: msg });
      }
    });
    ws.on("error", reject);
  });
}

describe("e2e: transcript → provider → gateway → operator", () => {
  it("lists and streams a session's events through the gateway", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-e2e-"));
    const file = path.join(dir, "sessE2E.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "user.message", data: { content: "go" } }),
        JSON.stringify({
          type: "tool.execution_start",
          data: {
            toolCallId: "tc1",
            toolName: "run_in_terminal",
            arguments: {},
          },
        }),
      ].join("\n"),
    );

    const deps: BridgeDeps = {
      listSessions: async () => [summary],
      findTranscript: async () => file,
      findSessionLog: async () => ({ file, parse: parseSessionEvents }),
    };

    gateway = await startGateway({
      host: "127.0.0.1",
      port: 0,
      fallbackToEphemeral: true,
      logger: silentLogger(),
    });
    client = await connectGateway(
      `ws://127.0.0.1:${gateway.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
    );

    // sessions.list flows provider → gateway → operator.
    const [list] = await operator(
      gateway.port,
      { id: "1", op: "sessions.list" },
      1,
    );
    expect(list).toMatchObject({ id: "1", ok: true, op: "sessions.list" });
    expect((list.result as SessionSummary[])[0]?.sessionId).toBe("sessE2E");

    // subscribe streams the parsed transcript events back through the relay.
    const frames = await operator(
      gateway.port,
      {
        id: "2",
        op: "session.subscribe",
        params: { sessionId: "sessE2E" },
      },
      2,
    );
    expect(frames[0]).toMatchObject({
      id: "2",
      event: { type: "append", part: { kind: "userMessage" } },
    });
    expect(frames[1]).toMatchObject({
      event: { type: "append", part: { kind: "toolCall" } },
    });
  });

  it("gates the whole chain: provider TOTP token + operator TOTP", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-e2e-"));
    const file = path.join(dir, "sessE2E.jsonl");
    await fs.writeFile(
      file,
      JSON.stringify({ type: "user.message", data: { content: "go" } }),
    );
    const deps: BridgeDeps = {
      listSessions: async () => [summary],
      findTranscript: async () => file,
      findSessionLog: async () => ({ file, parse: parseSessionEvents }),
    };

    // RFC 6238 seed as base32; code "287082" is valid at t=59s. Public vector.
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow
    const now = () => 59_000;
    // The provider's stored token (issued by a code exchange), verified by the
    // gateway's operator secret — the extension never holds the secret itself.
    // Scoped to "provider" (drift audit S3) so it registers at the provider boundary.
    const providerToken = new OperatorAuth({
      secret,
      now,
      confirmed: true,
    }).submitCode("287082", true, "provider").token;

    gateway = await startGateway({
      host: "127.0.0.1",
      port: 0,
      fallbackToEphemeral: true,
      logger: silentLogger(),
      operatorAuth: new OperatorAuth({ secret, now, confirmed: true }),
    });
    client = await connectGateway(
      `ws://127.0.0.1:${gateway.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      providerToken,
    );

    // An UNauthenticated operator is refused — the relay is genuinely gated.
    const [refused] = await operator(
      gateway.port,
      { id: "0", op: "sessions.list" },
      1,
    );
    expect(refused).toMatchObject({ id: "0", ok: false, needsAuth: true });

    // A TOTP-authenticated operator lists + streams through the relay, proving
    // the provider registered with its token AND the operator gate lets it flow.
    const { list, event } = await authedListAndSubscribe(
      gateway.port,
      "287082",
      "sessE2E",
    );
    expect(list).toMatchObject({ id: "1", ok: true, op: "sessions.list" });
    expect((list.result as SessionSummary[])[0]?.sessionId).toBe("sessE2E");
    expect(event).toMatchObject({
      id: "2",
      event: { type: "append", part: { kind: "userMessage" } },
    });
  });

  it("streams every part kind (message, reasoning, question, tool call) through the relay", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-e2e-"));
    const file = path.join(dir, "sessE2E.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "user.message", data: { content: "go" } }),
        JSON.stringify({
          type: "assistant.message",
          data: { reasoningText: "planning", content: "On it." },
        }),
        JSON.stringify({
          type: "tool.execution_start",
          data: {
            toolCallId: "q1",
            toolName: "vscode_askQuestions",
            arguments: {
              questions: [
                {
                  question: "Proceed?",
                  options: [{ label: "Yes" }, { label: "No" }],
                },
              ],
            },
          },
        }),
        JSON.stringify({
          type: "tool.execution_complete",
          data: { toolCallId: "q1", success: true },
        }),
        JSON.stringify({
          type: "tool.execution_start",
          data: {
            toolCallId: "t2",
            toolName: "run_in_terminal",
            arguments: { command: "ls" },
          },
        }),
        JSON.stringify({
          type: "tool.execution_complete",
          data: { toolCallId: "t2", success: true },
        }),
      ].join("\n"),
    );

    const deps: BridgeDeps = {
      listSessions: async () => [summary],
      findTranscript: async () => file,
      findSessionLog: async () => ({ file, parse: parseSessionEvents }),
    };

    gateway = await startGateway({
      host: "127.0.0.1",
      port: 0,
      fallbackToEphemeral: true,
      logger: silentLogger(),
    });
    client = await connectGateway(
      `ws://127.0.0.1:${gateway.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
    );

    // The initial stream carries 7 conversation events + 1 `turn` frame (initial
    // inTurn=false), which can interleave with the events — collect all 8 and
    // filter to the `event` frames so the assertion is order-independent.
    const frames = await operator(
      gateway.port,
      {
        id: "2",
        op: "session.subscribe",
        params: { sessionId: "sessE2E" },
      },
      8,
    );
    const kinds = frames
      .filter((f) => f.kind === "event")
      .map((f) => {
        const ev = f.event as { type: string; part?: { kind: string } };
        return ev.type === "append" ? ev.part!.kind : ev.type;
      });
    expect(kinds).toEqual([
      "userMessage",
      "thinking",
      "markdown",
      "confirmation",
      "resolve",
      "toolCall",
      "updateStatus",
    ]);
  });
});

describe("e2e: wss provider link with fingerprint pinning (C3 / S4b)", () => {
  const deps: BridgeDeps = {
    listSessions: async () => [summary],
    findTranscript: async () => undefined,
    findSessionLog: async () => undefined,
  };

  // A different, valid-shaped fingerprint that will never match a fresh cert.
  const WRONG_PIN =
    "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

  // RFC 6238 seed as base32; code "287082" is valid at t=59s (the shared vector
  // used across the auth suites). The user only ever shares this CODE.
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow

  async function startTlsGateway(operatorAuth?: OperatorAuth): Promise<{
    fingerprint: string;
    caPem: string;
  }> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-e2e-tls-"));
    const mat = await resolveTlsMaterial({ storeDir: dir });
    gateway = await startGateway({
      host: "127.0.0.1",
      port: 0,
      fallbackToEphemeral: true,
      logger: silentLogger(),
      ...(operatorAuth ? { operatorAuth } : {}),
      provider: {
        host: "127.0.0.1",
        tls: {
          cert: mat.cert,
          key: mat.key,
          fingerprint: mat.fingerprint,
        },
      },
    });
    return { fingerprint: mat.fingerprint, caPem: mat.cert };
  }

  it("connects over wss when the CA + fingerprint pin match; an operator lists through it", async () => {
    const { fingerprint, caPem } = await startTlsGateway();
    client = await connectGateway(
      `wss://127.0.0.1:${gateway!.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      undefined,
      undefined,
      undefined,
      { caPem, fingerprint },
    );
    // The operator uses the untouched loopback listener; the provider is on wss.
    const [list] = await operator(
      gateway!.port,
      { id: "1", op: "sessions.list" },
      1,
    );
    expect(list).toMatchObject({ id: "1", ok: true, op: "sessions.list" });
    expect((list.result as SessionSummary[])[0]?.sessionId).toBe("sessE2E");
  });

  it("fails closed on a fingerprint mismatch (no unverified fallback)", async () => {
    const { caPem } = await startTlsGateway();
    await expect(
      connectGateway(
        `wss://127.0.0.1:${gateway!.providerPort}`,
        { instanceId: "i1" },
        deps,
        () => {},
        1200,
        undefined,
        undefined,
        undefined,
        { caPem, fingerprint: WRONG_PIN },
      ),
    ).rejects.toThrow();
  });

  it("connects over wss with fingerprint-only pinning (no CA) — the easy path", async () => {
    const { fingerprint } = await startTlsGateway();
    client = await connectGateway(
      `wss://127.0.0.1:${gateway!.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      undefined,
      undefined,
      undefined,
      { fingerprint }, // no caPem: the pin is the sole anchor, verified by hand
    );
    const [list] = await operator(
      gateway!.port,
      { id: "1", op: "sessions.list" },
      1,
    );
    expect(list).toMatchObject({ id: "1", ok: true, op: "sessions.list" });
    expect((list.result as SessionSummary[])[0]?.sessionId).toBe("sessE2E");
  });

  it("fails closed on a fingerprint-only mismatch (no CA)", async () => {
    await startTlsGateway();
    // A DISTINCT error type, not a generic one: the caller must be able to tell a
    // pin mismatch (a security signal — never fall back to a local bridge) apart
    // from an unreachable hub (fall back is fine). The message names both
    // fingerprints so a field report says WHICH cert answered.
    await expect(
      connectGateway(
        `wss://127.0.0.1:${gateway!.providerPort}`,
        { instanceId: "i1" },
        deps,
        () => {},
        1200,
        undefined,
        undefined,
        undefined,
        { fingerprint: WRONG_PIN }, // no caPem: the manual verify rejects it
      ),
    ).rejects.toBeInstanceOf(GatewayCertPinError);
    expect(gateway!.registry.all().length).toBe(0);
  });

  // The real-world path the operator actually runs: wss (fingerprint-pinned) +
  // operator MFA. The provider has no token, so it signs in with a TOTP code over
  // the SAME wss socket. Only the CODE is shared; the provider token is minted by
  // the exchange and captured via onToken.
  it("signs in over wss with a TOTP code (MFA) on one socket and registers", async () => {
    const operatorAuth = new OperatorAuth({
      secret: SECRET,
      now: () => 59_000,
      confirmed: true,
    });
    const { fingerprint } = await startTlsGateway(operatorAuth);
    let stored: string | undefined;
    client = await connectGateway(
      `wss://127.0.0.1:${gateway!.providerPort}`,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      undefined, // no stored token → sign in with a code, over wss, one socket
      async () => "287082",
      (t) => {
        stored = t;
      },
      { fingerprint },
    );
    // Registered, and the issued token is PROVIDER-scoped (S3) — an operator token
    // it is not, so it can't be replayed at the operator boundary.
    expect(stored).toBeDefined();
    expect(operatorAuth.verifyToken(stored!, "provider")).toBe(true);
    expect(operatorAuth.verifyToken(stored!, "operator")).toBe(false);
    expect(gateway!.registry.all().length).toBe(1);
  });

  it("fails closed over wss when the TOTP code is wrong (MFA), never registering", async () => {
    const operatorAuth = new OperatorAuth({
      secret: SECRET,
      now: () => 59_000,
      confirmed: true,
    });
    const { fingerprint } = await startTlsGateway(operatorAuth);
    await expect(
      connectGateway(
        `wss://127.0.0.1:${gateway!.providerPort}`,
        { instanceId: "i1" },
        deps,
        () => {},
        1500,
        undefined,
        async () => "000000", // a wrong code → sign-in required, no registration
        undefined,
        { fingerprint },
      ),
    ).rejects.toBeInstanceOf(GatewayAuthRequiredError);
    expect(gateway!.registry.all().length).toBe(0);
  });

  // ── The RECONNECT leg. Every other e2e here exercises the FIRST connect only,
  //    which is exactly how a reconnect-only defect shipped: a resumed TLS
  //    session presents no certificate, so the pin silently could not be
  //    verified and the guard rejected a legitimate gateway on connect #2.

  it("a RESUMED TLS session presents no certificate (the hazard the pin must avoid)", async () => {
    // Executable proof of the premise, straight against the real gateway. If this
    // ever stops holding, the no-resumption agent below can be reconsidered —
    // until then, verifying a pin on a resumable connection is not possible.
    const { fingerprint } = await startTlsGateway();
    const url = `wss://127.0.0.1:${gateway!.providerPort}`;
    // One shared agent == a warm TLS session cache on the 2nd connect. This is
    // the shape VS Code's `http.proxySupport` injection creates in the host.
    const agent = new https.Agent({ keepAlive: true, maxCachedSessions: 100 });

    /** Connect once, reporting what the pin check would have had to work with. */
    const probe = () =>
      new Promise<{ reused: boolean; fingerprint256: string }>(
        (resolve, reject) => {
          const s = new WebSocket(url, { rejectUnauthorized: false, agent });
          s.on("error", reject);
          s.on("upgrade", (res) => {
            // By `upgrade` the handshake (and its session ticket) is complete, so
            // the next connection through this agent can already resume.
            const tls = res.socket as TLSSocket;
            // Read BOTH before closing: `isSessionReused()` returns null once
            // the handle is gone.
            const cert = tls.getPeerCertificate();
            const reused = tls.isSessionReused();
            s.close();
            resolve({ reused, fingerprint256: cert.fingerprint256 ?? "" });
          });
        },
      );

    const first = await probe();
    expect(first.reused).toBe(false);
    expect(normalizeFingerprint(first.fingerprint256)).toBe(
      normalizeFingerprint(fingerprint),
    );

    const second = await probe();
    expect(second.reused).toBe(true);
    // Nothing to pin against: an empty fingerprint is indistinguishable from a
    // hostile server, so the guard must fail closed — hence: never resume.
    expect(second.fingerprint256).toBe("");
  });

  it("re-verifies the pin on a RECONNECT even when the host injects a pooling agent", async () => {
    const { fingerprint } = await startTlsGateway();
    const url = `wss://127.0.0.1:${gateway!.providerPort}`;
    // Simulate VS Code's `http.proxySupport: "override"`: the extension host
    // injects a shared, session-caching agent into every HTTP(S) call that does
    // not bring its own. That injection is what made this fail ONLY in the
    // packaged extension — never under vitest or tsx.
    const injected = new https.Agent({
      keepAlive: true,
      maxCachedSessions: 100,
    });
    const realRequest = https.request;
    const broughtOwnAgent: boolean[] = [];
    const patched = https as { request: typeof https.request };
    patched.request = ((
      options: https.RequestOptions,
      cb?: (res: IncomingMessage) => void,
    ) => {
      broughtOwnAgent.push(options.agent !== undefined);
      if (!options.agent) options.agent = injected;
      return realRequest(options, cb);
    }) as typeof https.request;

    try {
      client = await connectGateway(
        url,
        { instanceId: "i1" },
        deps,
        () => {},
        4000,
        undefined,
        undefined,
        undefined,
        { fingerprint },
      );
      client.close();
      client = undefined;
      // The reconnect (what "Sign in to Gateway" triggers). It must verify the
      // pin again — which it can only do on a full handshake.
      client = await connectGateway(
        url,
        { instanceId: "i1" },
        deps,
        () => {},
        4000,
        undefined,
        undefined,
        undefined,
        { fingerprint },
      );
      expect(gateway!.registry.all().length).toBe(1);
    } finally {
      patched.request = realRequest;
    }

    // Both connections declined the injected agent — the client owns its own, so
    // no cache it does not control can skip the per-connection pin check. This
    // assertion is timing-independent: it fails without the fix regardless of
    // whether resumption happened to kick in.
    expect(broughtOwnAgent).toEqual([true, true]);
  });

  it("reconnects with the token minted by an MFA sign-in (the real sign-in leg)", async () => {
    // The exact production sequence: connect → auth_required → sign in with a
    // code → the extension reconnects presenting the issued token. The reconnect
    // is where pinning broke, so it belongs in the suite, not just in a probe.
    const operatorAuth = new OperatorAuth({
      secret: SECRET,
      now: () => 59_000,
      confirmed: true,
    });
    const { fingerprint } = await startTlsGateway(operatorAuth);
    const url = `wss://127.0.0.1:${gateway!.providerPort}`;
    let stored: string | undefined;
    client = await connectGateway(
      url,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      undefined,
      async () => "287082",
      (t) => {
        stored = t;
      },
      { fingerprint },
    );
    client.close();
    client = undefined;

    client = await connectGateway(
      url,
      { instanceId: "i1" },
      deps,
      () => {},
      4000,
      stored, // the stored token — no second code, and no sign-in prompt
      async () => {
        throw new Error("must not be asked to sign in again");
      },
      undefined,
      { fingerprint },
    );
    expect(gateway!.registry.all().length).toBe(1);
  });
});
