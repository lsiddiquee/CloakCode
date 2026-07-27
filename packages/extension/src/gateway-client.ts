import { WebSocket } from "ws";
import {
  gatewayInfoSchema,
  providerAuthRequiredSchema,
  rpcErrorSchema,
  sessionAuthResponseSchema,
  type GatewayInfo,
  type ProviderInfo,
} from "@cloakcode/protocol";
import { randomUUID } from "node:crypto";
import { OperatorGate } from "@cloakcode/gateway";
import {
  handleMessage,
  stopFollowers,
  type BridgeDeps,
  type Connection,
} from "./bridge.js";
import { knockFrame, isGatewayKnock } from "./ws-knock.js";
import {
  gatewayTlsOptions,
  guardFingerprintPin,
  type GatewayPinConfig,
} from "./gateway-tls.js";
import { errorCode } from "./errors.js";

export interface GatewayClient {
  /** The gateway URL this client connected to (`cloakcode.gatewayUrl`). */
  readonly url: string;
  /** The hub's phone URL if the gateway has pushed one (its tunnel), else undefined. */
  phoneUrl(): string | undefined;
  /**
   * Send a `sessions.changed` ping UP to the gateway (1B live list) when this
   * provider's watched workspace changes; the gateway fans it out to subscribed
   * operators. No-op while the socket is down (a reconnect + the next change
   * re-announces).
   */
  notifySessionsChanged(): void;
  close(): void;
}

/**
 * Rejection reason when the gateway is **reachable but refuses our provider
 * credential** (`provider.auth_required`) — distinct from an unreachable hub. The
 * caller must NOT fall back to the embedded bridge for this: the gateway is up
 * and the user just needs to sign in (`CloakCode: Sign in to Gateway`); starting
 * a competing local bridge would only add a second, confusing MFA enrolment.
 */
export class GatewayAuthRequiredError extends Error {
  /** Redaction-safe failure reason (e.g. "invalid code"), when the gateway gave one. */
  readonly reason?: string;
  constructor(url: string, reason?: string) {
    super(
      reason
        ? `gateway ${url} sign-in failed: ${reason}`
        : `gateway ${url} requires provider sign-in`,
    );
    this.name = "GatewayAuthRequiredError";
    if (reason) this.reason = reason;
  }
}

/**
 * Rejection reason when the gateway's certificate **failed the configured pin**
 * (`cloakcode.gatewayCertFingerprint`) — a security signal, not a connectivity
 * one. The caller must NOT fall back to the embedded bridge: something other than
 * the expected gateway answered (a proxy, a rotated cert, the wrong host), and
 * silently starting a local bridge would hide that behind a working-looking setup.
 * `message` names the presented and expected fingerprints — public material, and
 * the only way to tell a substituted cert from one that was never presented.
 */
export class GatewayCertPinError extends Error {
  constructor(url: string, detail: string) {
    super(`gateway ${url} rejected — ${detail}`);
    this.name = "GatewayCertPinError";
  }
}

/**
 * Client mode (docs/03 "Explicit gateway"): connect OUT to a standalone gateway
 * as a **provider** instead of hosting a local bridge. Announces `provider.hello`,
 * then serves the gateway's forwarded RPCs with the *same* per-connection handler
 * the embedded bridge uses (it echoes each `request.id`, which the gateway's relay
 * maps back to the operator). Reconnects with capped backoff on drops.
 *
 * Resolves once the first connection is established, or rejects after
 * `firstConnectTimeoutMs` — so the caller can fall back to the embedded bridge
 * when the hub is unreachable.
 */
export function connectGateway(
  url: string,
  provider: ProviderInfo,
  deps: BridgeDeps,
  log: (line: string) => void,
  firstConnectTimeoutMs = 4000,
  token?: string,
  onAuthRequired?: (instanceId?: string) => Promise<string | undefined>,
  onToken?: (token: string) => void | PromiseLike<void>,
  pin: GatewayPinConfig = {},
): Promise<GatewayClient> {
  return new Promise((resolve, reject) => {
    let closed = false;
    let settled = false;
    let attempt = 0;
    let phoneUrl: string | undefined;
    let socket: WebSocket | undefined;
    let conn: Connection | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Redaction-safe reason of the most recent socket error (e.g. ECONNREFUSED,
    // DEPTH_ZERO_SELF_SIGNED_CERT) so a failure reports WHY, not just "unreachable".
    let lastError: string | undefined;

    const client: GatewayClient = {
      url,
      phoneUrl: () => phoneUrl,
      notifySessionsChanged: () => {
        // readyState 1 === OPEN (ws); a down socket just drops the ping (the
        // next change after reconnect re-announces).
        if (socket && socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "sessions.changed" }));
        }
      },
      close: () => {
        closed = true;
        if (retry) clearTimeout(retry);
        if (conn) stopFollowers(conn);
        socket?.close();
      },
    };

    const firstTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.close();
      reject(
        new Error(`gateway ${url} unreachable${connectHint(lastError, url)}`),
      );
    }, firstConnectTimeoutMs);

    const connect = (): void => {
      const s = new WebSocket(url, gatewayTlsOptions(url, pin));
      const c: Connection = {
        alive: true,
        followers: new Map(),
        spoolFollowers: new Map(),
        // The gateway authenticates the operator before relaying; the provider
        // link is machine-authed by the provider token, so its gate is open.
        gate: new OperatorGate(undefined),
        // The provider link never subscribes to the operator-facing list ping.
        isListSubscriber: false,
      };
      socket = s;
      conn = c;

      let knocked = false;
      guardFingerprintPin(
        s,
        url,
        pin,
        () => {
          // Server verified (or not fingerprint-only) — safe to send.
          attempt = 0;
          // Phase 1: knock with no provider info — the gateway answers only if it
          // is a real CloakCode gateway; only then do we send the full hello.
          s.send(knockFrame("provider"));
        },
        (err) => {
          // Fingerprint-only pin mismatch: fail closed. Do not knock/hello an
          // unverified server, surface the reason, and do not reconnect-loop.
          // The reason carries BOTH fingerprints (or "no certificate"), so a
          // report says WHICH failure this was.
          lastError = "GATEWAY_CERT_FINGERPRINT_MISMATCH";
          log(`gateway ${url} rejected: ${err.message}`);
          closed = true;
          if (!settled) {
            settled = true;
            clearTimeout(firstTimer);
            reject(new GatewayCertPinError(url, err.message));
          }
        },
      );
      s.on("message", (raw) => {
        const text = raw.toString();
        if (!knocked) {
          if (!isGatewayKnock(text)) {
            log(`gateway: ${url} did not answer the knock`);
            s.close();
            return;
          }
          knocked = true;
          // Send the full provider hello (with the shared secret). We do NOT
          // resolve yet: the gateway confirms a successful registration by
          // pushing its first `gateway.info` frame, and DROPS the socket on a
          // bad token — so waiting for that frame is what distinguishes accepted
          // from rejected (a premature resolve reported a rejected token as
          // "connected" and reconnect-looped). A close before it is handled below.
          s.send(
            JSON.stringify({
              type: "hello",
              role: "provider",
              provider,
              ...(token ? { token } : {}),
            }),
          );
          log(
            `gateway: sent provider hello (${provider.instanceId}); awaiting ack`,
          );
          return;
        }
        // The gateway pushes its phone URL as a `gateway.info` control frame;
        // capture it (so “Show Phone Link” reflects the hub) and don't route it
        // through the RPC handler. The FIRST such frame also confirms the gateway
        // accepted our hello and registered us — only now is the connection
        // truly established.
        const authRequired = tryProviderAuthRequired(text);
        if (authRequired) {
          // The gateway has MFA and our credential was missing/invalid. Ask the
          // operator for a TOTP code (onAuthRequired) and send it over THIS SAME
          // socket — the gateway mints a provider token and registers us (one
          // connection, no separate sign-in socket). With no code we reject so the
          // caller shows "sign-in required" instead of reconnect-looping. The
          // gateway's instance-id (if advertised) lets the prompt name the hub.
          log(`gateway: ${url} requires provider sign-in`);
          void (async () => {
            const code = await onAuthRequired?.(authRequired.instanceId);
            if (!code) {
              log(
                `gateway: sign-in cancelled (no code); staying unauthenticated`,
              );
              if (!settled) {
                settled = true;
                clearTimeout(firstTimer);
                reject(new GatewayAuthRequiredError(url));
              }
              closed = true; // no credential — don't reconnect-loop
              s.close();
              return;
            }
            s.send(
              JSON.stringify({
                id: `signin-${randomUUID()}`,
                op: "auth",
                params: { code, remember: true, audience: "provider" },
              }),
            );
            log(`gateway: sent provider sign-in code; awaiting token`);
          })();
          return;
        }
        // Sign-in reply on the same socket: the gateway minted (ok+token) or
        // refused (bad code) a provider token. On success, persist it (onToken) —
        // the gateway registers us and pushes gateway.info next. On failure, fail
        // closed with the reason so the sign-in command can show it.
        const auth = tryAuthReply(text);
        if (auth) {
          if (auth.ok && auth.token) {
            void onToken?.(auth.token);
            log(`gateway: provider sign-in accepted; token stored`);
          } else if (!settled) {
            // A bad/used code is still "sign-in required", NOT unreachable — reject
            // with GatewayAuthRequiredError so the caller stays in gateway mode
            // (never falls back to a competing embedded bridge).
            log(
              `gateway: provider sign-in rejected (${auth.error ?? "unknown"})`,
            );
            settled = true;
            clearTimeout(firstTimer);
            closed = true;
            reject(new GatewayAuthRequiredError(url, auth.error));
            s.close();
          }
          return;
        }
        const info = tryGatewayInfo(text);
        if (info) {
          phoneUrl = info.phoneUrl;
          if (!settled) {
            settled = true;
            clearTimeout(firstTimer);
            log(`gateway: connected as provider (${provider.instanceId})`);
            resolve(client);
          } else {
            log(`gateway: phone URL ${phoneUrl ?? "(none yet)"}`);
          }
          return;
        }
        void handleMessage(s, text, deps, c);
      });
      s.on("error", (e: unknown) => {
        // Capture the redaction-safe reason (never swallow it — that turned a
        // cert-trust failure into a misleading "unreachable"). A 'close' always
        // follows, where reconnect is handled.
        lastError = errorCode(e);
      });
      s.on("close", () => {
        stopFollowers(c);
        if (closed) return;
        if (!settled && knocked) {
          // The gateway answered our knock and we sent the hello, but it closed
          // before confirming registration — the shared secret was rejected
          // (docs/04 `provider.auth_reject`). Report auth failure and fall back
          // to the embedded bridge; a persistent bad token must not loop.
          settled = true;
          closed = true;
          clearTimeout(firstTimer);
          log(
            `gateway: ${url} rejected the provider (bad token?) — using embedded bridge`,
          );
          reject(new Error(`gateway ${url} rejected the provider (auth)`));
          return;
        }
        const delay = Math.min(1000 * 2 ** attempt++, 15_000);
        retry = setTimeout(connect, delay);
      });
    };

    connect();
  });
}

/**
 * A redaction-safe, actionable suffix for a failed connection, built from the
 * captured error CODE (never the message). For a wss cert-trust failure it names
 * the two ways to trust a self-signed gateway; otherwise it just names the code.
 * Empty when no error was captured (a genuine timeout with no socket error).
 */
export function connectHint(code: string | undefined, url: string): string {
  if (!code) return "";
  const isTlsTrust = /CERT|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code);
  if (isTlsTrust && url.startsWith("wss:")) {
    return (
      ` (${code} \u2014 the gateway's certificate is not trusted; set ` +
      `cloakcode.gatewayCertFingerprint to its pin, or cloakcode.gatewayCaFile to its cert)`
    );
  }
  return ` (${code})`;
}

/** Parse a frame as a gateway.info control message, or undefined if it isn't one. */
function tryGatewayInfo(text: string): GatewayInfo | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = gatewayInfoSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The gateway's `provider.auth_required` control frame, parsed — `{ instanceId? }`
 * (the hub's display label, for the sign-in prompt) — or undefined if it isn't one.
 */
function tryProviderAuthRequired(
  text: string,
): { instanceId?: string } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = providerAuthRequiredSchema.safeParse(json);
  if (!parsed.success) return undefined;
  return parsed.data.instanceId ? { instanceId: parsed.data.instanceId } : {};
}

/**
 * Parse a frame as the provider sign-in reply sent over the same socket: a
 * successful `auth` response carrying the issued provider token, or an RPC error
 * (a bad/used code). Undefined for any other frame.
 */
function tryAuthReply(
  text: string,
): { ok: boolean; token?: string; error?: string } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const ok = sessionAuthResponseSchema.safeParse(json);
  if (ok.success) {
    return { ok: true, ...(ok.data.token ? { token: ok.data.token } : {}) };
  }
  const err = rpcErrorSchema.safeParse(json);
  if (err.success) return { ok: false, error: err.data.error.message };
  return undefined;
}
