import {
  issueSessionToken,
  otpauthUri,
  verifySessionToken,
  verifyTotp,
} from "./totp.js";

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
  /**
   * Has first-run enrolment been verified? A freshly generated secret starts
   * `false` (enrolment mode — the ingress serves only pairing until a code is
   * verified). A persisted, already-paired secret loads `true`.
   */
  confirmed?: boolean;
  /** Persist the flip to confirmed (write the flag to the file / SecretStore). */
  onConfirmed?: () => void;
  /**
   * Strict enrolment (Option B): never reveal the secret over the wire — the QR
   * is shown out-of-band (gateway console / VS Code) and the client only submits
   * the verify code. Default `false` (browser-driven Option A).
   */
  strictEnrol?: boolean;
}

export interface CodeResult {
  ok: boolean;
  token?: string;
  expiresAt?: number;
  error?: string;
}

/**
 * Shared operator app-layer auth (docs/04, F2a): holds the TOTP secret, the
 * global replay guard (a code's 30s step is accepted at most once), and the
 * enrolment (`confirmed`) state. ONE instance per ingress (gateway or embedded
 * bridge); per-connection state lives in {@link OperatorGate}.
 */
export class OperatorAuth {
  readonly #secret: string;
  readonly #now: () => number;
  readonly #defaultTtl: number;
  readonly #rememberTtl: number;
  readonly #onConfirmed?: () => void;
  readonly #strictEnrol: boolean;
  #confirmed: boolean;
  #lastStep = -1;

  constructor(opts: OperatorAuthOptions) {
    this.#secret = opts.secret;
    this.#now = opts.now ?? (() => Date.now());
    this.#defaultTtl = opts.defaultTtlMs ?? OPERATOR_TOKEN_TTL_MS;
    this.#rememberTtl = opts.rememberTtlMs ?? OPERATOR_REMEMBER_TTL_MS;
    this.#confirmed = opts.confirmed ?? false;
    this.#strictEnrol = opts.strictEnrol ?? false;
    if (opts.onConfirmed) this.#onConfirmed = opts.onConfirmed;
  }

  /** Whether first-run enrolment is verified (else the ingress is in enrolment mode). */
  get confirmed(): boolean {
    return this.#confirmed;
  }

  /** Whether the secret must NOT be revealed over the wire (Option B). */
  get strictEnrol(): boolean {
    return this.#strictEnrol;
  }

  /** Pairing provisioning: the otpauth URI (for the QR) + the base32 secret. */
  provisioning(): { otpauthUri: string; secret: string } {
    return { otpauthUri: otpauthUri(this.#secret), secret: this.#secret };
  }

  /** Mark enrolment verified and persist it (idempotent). */
  markConfirmed(): void {
    if (!this.#confirmed) {
      this.#confirmed = true;
      this.#onConfirmed?.();
    }
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
 * Per-connection auth gate. Three states, driven by {@link OperatorAuth}:
 *
 * - **auth disabled** (`auth` undefined) → open; every frame proceeds.
 * - **enrolment mode** (secret exists, NOT confirmed) → serve only pairing:
 *   `enrol.begin` returns the provisioning (withheld in strict mode), a verified
 *   `auth` code confirms enrolment + logs in, and every other op is refused with
 *   `enrolmentRequired`.
 * - **confirmed** → normal MFA: an `auth` token/code authenticates; any other op
 *   is refused with `needsAuth`. After {@link MAX_AUTH_ATTEMPTS} failed codes the
 *   caller is asked to close (lockout).
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
      if (req.op === "enrol.begin") {
        return {
          kind: "reply",
          response: alreadyEnrolled(req.id),
        };
      }
      return { kind: "proceed" };
    }
    const auth = this.auth!;
    const { code, token, remember } = (req.params ?? {}) as {
      code?: string;
      token?: string;
      remember?: boolean;
    };

    // Enrolment mode: serve ONLY pairing until a code is verified.
    if (!auth.confirmed) {
      if (req.op === "enrol.begin") {
        const provisioning = auth.strictEnrol ? {} : auth.provisioning();
        return {
          kind: "reply",
          response: {
            id: req.id,
            ok: true,
            op: "enrol.begin",
            ...provisioning,
          },
        };
      }
      if (req.op === "auth" && code) {
        const res = auth.submitCode(code, remember);
        if (res.ok) {
          auth.markConfirmed();
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
        const response = enrolmentRequired(req.id, res.error ?? "invalid code");
        return this.#attempts >= MAX_AUTH_ATTEMPTS
          ? { kind: "close", response }
          : { kind: "reply", response };
      }
      return {
        kind: "reply",
        response: enrolmentRequired(req.id, "enrolment required"),
      };
    }

    // Confirmed: normal MFA login.
    if (req.op === "enrol.begin") {
      return { kind: "reply", response: alreadyEnrolled(req.id) };
    }
    if (req.op !== "auth") {
      return {
        kind: "reply",
        response: needsAuth(req.id, "authentication required"),
      };
    }
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

function enrolmentRequired(id: string, message: string): unknown {
  return { id, ok: false, enrolmentRequired: true, error: { message } };
}

function alreadyEnrolled(id: string): unknown {
  return { id, ok: false, error: { message: "already enrolled" } };
}
