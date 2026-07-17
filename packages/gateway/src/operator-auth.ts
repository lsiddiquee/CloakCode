import { issueSessionToken, verifySessionToken, verifyTotp } from "./totp.js";

/** Default session-token TTL after a code login (this device stays in 12h). */
export const OPERATOR_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** "Remember this device" TTL (30 days). */
export const OPERATOR_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Failed code attempts on one connection before it is closed (lockout). */
export const MAX_AUTH_ATTEMPTS = 5;

export interface OperatorAuthOptions {
  /** The base32 TOTP secret this ingress authenticates against. */
  secret: string;
  now?: () => number;
  defaultTtlMs?: number;
  rememberTtlMs?: number;
}

export interface CodeResult {
  ok: boolean;
  token?: string;
  expiresAt?: number;
  error?: string;
}

/**
 * Shared operator app-layer auth (docs/04, F2a): holds the TOTP secret and the
 * global replay guard (a code's 30s step is accepted at most once). ONE instance
 * per ingress (gateway or embedded bridge); per-connection state lives in
 * {@link OperatorGate}.
 */
export class OperatorAuth {
  readonly #secret: string;
  readonly #now: () => number;
  readonly #defaultTtl: number;
  readonly #rememberTtl: number;
  #lastStep = -1;

  constructor(opts: OperatorAuthOptions) {
    this.#secret = opts.secret;
    this.#now = opts.now ?? (() => Date.now());
    this.#defaultTtl = opts.defaultTtlMs ?? OPERATOR_TOKEN_TTL_MS;
    this.#rememberTtl = opts.rememberTtlMs ?? OPERATOR_REMEMBER_TTL_MS;
  }

  /** True if a stored session token still resumes a prior login. */
  verifyToken(token: string): boolean {
    return verifySessionToken(this.#secret, token, this.#now);
  }

  /**
   * Verify a TOTP `code`. On success issues a fresh bearer token (12h, or 30d
   * when `remember`) and advances the replay guard so the same code can't be
   * reused. Rejects an invalid or already-used code.
   */
  submitCode(code: string, remember = false): CodeResult {
    const res = verifyTotp(this.#secret, code, { now: this.#now });
    if (!res.ok || res.step === undefined) {
      return { ok: false, error: "invalid code" };
    }
    if (res.step <= this.#lastStep) {
      return { ok: false, error: "code already used" };
    }
    this.#lastStep = res.step;
    const ttl = remember ? this.#rememberTtl : this.#defaultTtl;
    return {
      ok: true,
      token: issueSessionToken(this.#secret, ttl, this.#now),
      expiresAt: this.#now() + ttl,
    };
  }
}

/** What the connection handler should do with one operator frame. */
export type GateDecision =
  | { kind: "proceed" }
  | { kind: "reply"; response: unknown }
  | { kind: "close"; response: unknown };

interface AuthFrame {
  id: string;
  op: string;
  params?: unknown;
}

/**
 * Per-connection auth gate. When auth is enabled the connection starts
 * UNauthenticated: an `auth` frame (a valid token or TOTP code) authenticates it;
 * any other op is refused with `needsAuth` so the client prompts. After
 * {@link MAX_AUTH_ATTEMPTS} failed codes it asks the caller to close (lockout).
 * When `auth` is undefined the gate is open (auth disabled) — backward compatible.
 */
export class OperatorGate {
  #authed: boolean;
  #attempts = 0;

  constructor(private readonly auth: OperatorAuth | undefined) {
    this.#authed = auth === undefined;
  }

  get authenticated(): boolean {
    return this.#authed;
  }

  /** Decide how to handle one parsed operator frame. */
  check(req: AuthFrame): GateDecision {
    if (this.#authed) {
      if (req.op === "auth") {
        return {
          kind: "reply",
          response: { id: req.id, ok: true, op: "auth" },
        };
      }
      return { kind: "proceed" };
    }
    if (req.op !== "auth") {
      return {
        kind: "reply",
        response: needsAuth(req.id, "authentication required"),
      };
    }
    const auth = this.auth!;
    const { code, token, remember } = (req.params ?? {}) as {
      code?: string;
      token?: string;
      remember?: boolean;
    };
    if (token && auth.verifyToken(token)) {
      this.#authed = true;
      return { kind: "reply", response: { id: req.id, ok: true, op: "auth" } };
    }
    if (code) {
      const res = auth.submitCode(code, remember);
      if (res.ok) {
        this.#authed = true;
        return {
          kind: "reply",
          response: {
            id: req.id,
            ok: true,
            op: "auth",
            token: res.token,
            expiresAt: res.expiresAt,
          },
        };
      }
      this.#attempts += 1;
      const response = needsAuth(req.id, res.error ?? "invalid code");
      return this.#attempts >= MAX_AUTH_ATTEMPTS
        ? { kind: "close", response }
        : { kind: "reply", response };
    }
    return {
      kind: "reply",
      response: needsAuth(req.id, "authentication required"),
    };
  }
}

function needsAuth(id: string, message: string): unknown {
  return { id, ok: false, needsAuth: true, error: { message } };
}
