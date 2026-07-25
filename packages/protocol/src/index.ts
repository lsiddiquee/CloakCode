import { z } from "zod";

/**
 * Preferred loopback port for BOTH the embedded bridge and the standalone
 * gateway. `cloakcode.port` / `CLOAKCODE_GATEWAY_PORT` of `0` (or unset) means
 * "try this port first, and fall back to an ephemeral port only if it is
 * already taken"; any non-zero value locks that exact port (no fallback). Kept
 * here so the two runtimes always agree on the default. See docs/03.
 */
export const DEFAULT_PORT = 3543;

/**
 * Preferred port for the gateway's dedicated **provider** listener — the separate
 * endpoint extensions connect to (docs/04 role split). Distinct from
 * {@link DEFAULT_PORT} (the operator/PWA listener) so the two listeners never
 * collide on their defaults. `CLOAKCODE_TLS_PORT` unset → try this first, else an
 * ephemeral port; `0` → ephemeral; `N` → lock `N`.
 */
export const DEFAULT_PROVIDER_PORT = 3544;

/**
 * Upper bound (chars) for operator-supplied free text — answers, chat prompts,
 * steer/stop text. Defense-in-depth against unbounded input at the operator
 * ingress (docs/04); generous for pasted content but not unbounded.
 */
export const MAX_RPC_TEXT_LEN = 100_000;

/**
 * Max WebSocket frame size accepted at either ingress (bytes), applied via the
 * `ws` `maxPayload` option on the bridge and gateway servers so a single frame
 * can't exhaust memory. 4 MiB is generous for transcript event frames.
 */
export const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * `ws` per-message compression config, shared by the bridge and gateway servers.
 * `ws` disables permessage-deflate by default (memory concerns); we enable it
 * because the mirrored transcript is highly compressible JSON/markdown — a large
 * win over a bandwidth-capped tunnel (wire-bandwidth / devtunnel). Tuned to bound
 * memory: `threshold` skips tiny control frames; NO context-takeover caps
 * per-connection state (phones/providers are few, so the ratio stays good on the
 * repetitive JSON). It compresses only the OUTBOUND mirror; `maxPayload` still
 * bounds inbound frames and `ws` enforces it during inflate (deflate-bomb-safe).
 */
export const WS_PERMESSAGE_DEFLATE = {
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  zlibDeflateOptions: { level: 6 },
};

// The ILogger-style logger port + traceId helper (pure; local-only output).
export * from "./logger.js";

// Token-bucket rate limiter for bounding operator ingress (docs/04, F2b).
export * from "./rate-limit.js";

/**
 * Liveness-derived session status. Per research (docs/02 §3.3) this comes from
 * file mtime + the blocker signature, never from the last event type.
 */
export const sessionStatusSchema = z.enum(["active", "blocked", "idle"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * A session id as it is used to locate on-disk logs (`transcripts/<id>.jsonl`,
 * `debug-logs/<id>/`). Constrained to a **safe single path segment** — allowlist
 * charset, no `/`, `\`, or `..`, bounded length — so an operator-supplied id can
 * never traverse out of the storage root when joined into a path (drift audit
 * S2). Real ids are UUIDs; the allowlist also covers hyphen/underscore/dot-bearing
 * derived ids. Applied to incoming session RPC params (not the outgoing summary,
 * which echoes whatever the observer found on disk).
 */
export const sessionIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, "invalid sessionId")
  .refine((s) => !s.includes(".."), { message: "invalid sessionId" });
export type SessionId = z.infer<typeof sessionIdSchema>;

/**
 * Decide whether an HTTP→WebSocket upgrade may proceed (drift audit S1 — stop a
 * malicious web page from opening a **cross-site** WebSocket to the loopback
 * bridge / gateway). Policy:
 *
 * - **No `Origin` header** ⇒ a non-browser client (a Node provider; the `ws`
 *   library sends none) — allowed (no CSRF vector; the provider token still gates it).
 * - **`Origin` present** (a browser) ⇒ allowed only when it is **same-origin**
 *   (the Origin's `host` equals the request `Host`) or its origin is in
 *   `allowedOrigins` (the server's own known public/tunnel URL, so the tunnelled
 *   PWA is allowed even if the tunnel rewrites `Host`).
 *
 * Path is intentionally NOT restricted here — providers connect on `/`, the PWA
 * on `/bridge`. Pure + environment-agnostic (no `URL`/DOM) so both ingresses
 * share one tested rule.
 */
export function isAllowedUpgrade(opts: {
  origin?: string | undefined;
  host?: string | undefined;
  allowedOrigins?: readonly string[];
}): boolean {
  if (!opts.origin) return true; // originless (Node provider) — no CSRF vector
  const originHost = authorityOf(opts.origin);
  if (!originHost) return false; // malformed Origin
  if (opts.host && originHost === opts.host) return true; // same-origin
  for (const allowed of opts.allowedOrigins ?? []) {
    if (authorityOf(allowed) === originHost) return true;
  }
  return false;
}

/** The `host[:port]` authority of a `scheme://authority/…` origin, or undefined. */
function authorityOf(origin: string): string | undefined {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(origin)?.[1];
}

/**
 * One row in the remote session picker. The `sessionId` (a globally-unique UUID)
 * is the session's **identity**: the list de-dupes on it, and the gateway
 * **routes** session-addressed RPCs by it to the owning provider. `instanceId`
 * is a human-readable **display label only** (which environment) — never used
 * for routing, grouping, or identity; the list groups by `workspaceHash`. See
 * docs/03 "Multi-instance topology".
 *
 * `owned` = a live CloakCode extension serves this session's workspace, so it is
 * actuatable (respond/decide/answer). Sessions in a workspace with no running
 * extension are still listed (observe-only) with `owned=false`, and the client
 * renders them read-only/locked. Actuation routing + a receiving-side
 * workspace/session guard belong to the future gateway/leader, not today's proxy.
 */
export const sessionSummarySchema = z.object({
  instanceId: z.string(),
  sessionId: z.string(),
  /** Human label for the workspace (folder name, or a short hash fallback). */
  workspace: z.string(),
  /** Stable `workspaceStorage/<hash>` key — the client groups + routes on this. */
  workspaceHash: z.string(),
  title: z.string(),
  turns: z.number().int().nonnegative(),
  status: sessionStatusSchema,
  idleSeconds: z.number().int().nonnegative(),
  owned: z.boolean(),
  /**
   * The session is **mid-turn**: the model is generating — an open
   * `assistant.turn_start` with no matching `assistant.turn_end`, and the
   * session is live (mtime). Precondition for offering the mid-turn actions
   * (steer / stop-and-send); when false a plain send just queues. Derived from
   * the transcript like `status`, self-healed by the next `turn_start` (docs/02
   * §3.3/§4.10). It never labels a message's action type — steer/queue/stop
   * leave no on-disk marker (docs/02 §4.28), so we track only in-flight-ness.
   */
  inTurn: z.boolean(),
  /**
   * Which on-disk source the observer will tail for this session (docs/02.4
   * §4.23/§4.25) — **display-only**, for a freshness advisory. `"transcript"`
   * means there is no debug-log, so the **newest** assistant reply can LAG (a
   * finished turn only flushes to the transcript when the next turn starts);
   * `"debug-log"` is live. Resolved **empirically** (debug-log file presence),
   * NEVER from the experiment-gated config flag (which lies both ways). Optional:
   * an older producer that omits it simply shows no advisory (parallel to
   * `InsecureBanner`'s "only warn when we know"), and the field rides the existing
   * `sessions.list` fan-out — no new frame, no new egress.
   */
  logSource: z.enum(["debug-log", "transcript"]).optional(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** Status of an observed tool call. */
export const toolStatusSchema = z.enum(["running", "done", "error"]);
export type ToolStatus = z.infer<typeof toolStatusSchema>;

/**
 * A `remote-operator` approval verdict for a pending tool call. Used both on the
 * `session.decide` RPC and in the hook's on-disk decision file (docs/04) — the
 * blocking hook only ever honors an explicit `allow`/`deny`; anything else
 * (including a timeout) falls through to VS Code's native approval.
 */
export const decisionSchema = z.enum(["allow", "deny"]);
export type Decision = z.infer<typeof decisionSchema>;

/** One selectable option of a blocker `confirmation`. */
export const choiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  recommended: z.boolean().optional(),
});
export type Choice = z.infer<typeof choiceSchema>;

/**
 * A blocker `confirmation`: one question with selectable `options` and an
 * optional freeform escape hatch. Named (not inline) so the live-pending
 * overlay can reuse it — a `vscode_askQuestions` blocker is a list of these.
 */
export const confirmationPartSchema = z.object({
  kind: z.literal("confirmation"),
  id: z.string(),
  prompt: z.string(),
  options: z.array(choiceSchema),
  allowFreeform: z.boolean().optional(),
  // `vscode_askQuestions` `multiSelect` — the client lets the operator pick more
  // than one option, and the answer is delivered as `selectedValues`.
  multiSelect: z.boolean().optional(),
});
export type ConfirmationPart = z.infer<typeof confirmationPartSchema>;

/**
 * A typed piece of a rendered session, mirroring how Copilot Chat renders. I1
 * covers the read-mirror subset; `confirmation` (the blocker) lands in I2, and
 * richer parts (diff/fileTree/…) later. See docs/03 "The core abstraction".
 */
export const sessionPartSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("userMessage"),
    id: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("markdown"),
    id: z.string(),
    text: z.string(),
    title: z.string().optional(),
  }),
  z.object({ kind: z.literal("thinking"), id: z.string(), text: z.string() }),
  z.object({
    kind: z.literal("toolCall"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    status: toolStatusSchema,
  }),
  z.object({
    // Per-`llm_request` telemetry from the debug-log (docs/02 §4.14): model +
    // token counts + timing + billing. A **metadata** part — the OBSERVER
    // aggregates these into the session total over the WHOLE log and pushes it as
    // the `usage` subscribe frame (docs/02.6 §4.32), so the tail window can't
    // undercount it; the per-turn badge stays a client-side sum of the turn's
    // parts. A recycled session's prepended transcript history carries none, so
    // the total is flagged `partial`.
    kind: z.literal("usage"),
    id: z.string(),
    model: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedTokens: z.number(),
    ttftMs: z.number().optional(),
    durationMs: z.number().optional(),
    // `copilotUsageNanoAiu` verbatim (AI Units × 1e9; AIU = nanoAiu / 1e9).
    nanoAiu: z.number().optional(),
    // `copilotCredits` when present (Windows store); absent on other platforms.
    credits: z.number().optional(),
  }),
  confirmationPartSchema,
]);
export type SessionPart = z.infer<typeof sessionPartSchema>;

/**
 * One frame of the sequence-numbered session event log. `append` adds a part;
 * `updateStatus` mutates a prior tool-call part; `resolve` marks a
 * `confirmation` (blocker) answered/closed. A reconnecting client resumes from
 * `sinceSeq`; the derived sequence is prefix-stable (append-only source).
 */
export const sessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("append"),
    seq: z.number().int().nonnegative(),
    part: sessionPartSchema,
  }),
  z.object({
    type: z.literal("updateStatus"),
    seq: z.number().int().nonnegative(),
    id: z.string(),
    status: toolStatusSchema,
  }),
  z.object({
    type: z.literal("resolve"),
    seq: z.number().int().nonnegative(),
    id: z.string(),
  }),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

/** One `usage` metadata part — per-`llm_request` telemetry (docs/02 §4.14). */
export type UsagePart = Extract<SessionPart, { kind: "usage" }>;

/** Aggregated `usage` telemetry across a set of requests (a session/turn total). */
export const usageTotalsSchema = z.object({
  /** Number of `llm_request` spans aggregated. */
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedTokens: z.number(),
  /** Total AI Units (`copilotUsageNanoAiu` summed ÷ 1e9); absent if none reported. */
  aiu: z.number().optional(),
  /** Total credits (Windows store); absent if none reported. */
  credits: z.number().optional(),
  /** Distinct models used, in first-seen order. */
  models: z.array(z.string()),
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;

/** A session usage total plus whether telemetry is incomplete. */
export const usageSummarySchema = usageTotalsSchema.extend({
  /**
   * True when the session carries prepended transcript history (a recycled
   * debug-log, docs/02.6 §4.32) whose older turns have NO telemetry — so the
   * totals cover the recent (debug-log) turns only, and the view shows a
   * "partial" disclaimer. Computed **server-side** (the observer owns the
   * prepend), so the client no longer inspects part ids to derive it.
   */
  partial: z.boolean(),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;

/** Sum a set of `usage` parts (shared by the session total + the per-turn badge). */
export function sumUsage(usage: UsagePart[]): UsageTotals {
  const models: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let nanoAiu = 0;
  let credits = 0;
  for (const u of usage) {
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    cachedTokens += u.cachedTokens;
    if (u.nanoAiu !== undefined) nanoAiu += u.nanoAiu;
    if (u.credits !== undefined) credits += u.credits;
    if (!models.includes(u.model)) models.push(u.model);
  }
  // Only surface a cost when genuinely reported (> 0). Custom / BYO models leave
  // `copilotUsageNanoAiu` absent/null/0 — never show a misleading "0 AIU".
  return {
    requests: usage.length,
    inputTokens,
    outputTokens,
    cachedTokens,
    ...(nanoAiu > 0 ? { aiu: nanoAiu / 1e9 } : {}),
    ...(credits > 0 ? { credits } : {}),
    models,
  };
}

/**
 * Aggregate `usage` parts into a session total with the `partial` flag. Returns
 * `null` when there's no telemetry (a pure-transcript session), so the view can
 * say "unavailable" rather than show a misleading zero.
 */
export function summarizeUsage(
  usage: UsagePart[],
  partial: boolean,
): UsageSummary | null {
  if (usage.length === 0) return null;
  return { ...sumUsage(usage), partial };
}

/**
 * A live, still-pending blocker sourced from the Copilot hook (not the
 * transcript). Keyed by the base `toolCallId` (the hook's `tool_use_id` with
 * its `__vscode-<n>` suffix stripped) so it dedupes against the transcript's
 * `toolCallId` — see docs/02 §4.6 and docs/03 "Live-pending overlay". For a
 * question it carries `confirmations`; for a tool approval it carries the raw
 * `input` (e.g. the command). `awaitingDecision` is set when CloakCode holds
 * the tool call (the operator has taken control of the session) and is blocking
 * on a remote `allow`/`deny` — the client renders approve/deny affordances only
 * then. Delivered as a replace-snapshot, never on the seq'd log, so the
 * observer's `sinceSeq` resumption stays pure.
 */
export const pendingBlockerSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  createdAt: z.string(),
  confirmations: z.array(confirmationPartSchema).optional(),
  input: z.unknown().optional(),
  awaitingDecision: z.boolean().optional(),
  // For a question, the RAW `tool_use_id` (with the `__vscode-<n>` suffix
  // intact) — the carousel's `resolveId`, needed to answer it structurally via
  // `_chat.notifyQuestionCarouselAnswer` (docs/02 §4.16). `toolCallId` stays the
  // base id for transcript dedup.
  resolveId: z.string().optional(),
});
export type PendingBlocker = z.infer<typeof pendingBlockerSchema>;

/**
 * One question's answer in a structured `session.answer`, by question index.
 * `selected` are the chosen option labels (empty = skipped/freeform-only);
 * `freeText` is the freeform value when allowed. The extension maps these onto
 * the core carousel's `{selectedValues, freeformValue}` answer shape.
 */
export const questionAnswerSchema = z.object({
  selected: z.array(z.string()),
  freeText: z.string().max(MAX_RPC_TEXT_LEN).nullable().optional(),
  // When true the question is multi-select — the extension delivers `selected`
  // as `selectedValues` (not a single `selectedValue`) so VS Code renders it.
  multiSelect: z.boolean().optional(),
});
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

/**
 * Client → bridge request envelope. A discriminated union on `op` so each
 * operation can carry its own typed params; new ops extend this array. Every
 * request may carry an optional **`traceId`** — a client-minted, LOCAL-only
 * correlation id (see `newTraceId`) so one remote action's logs line up across
 * web → bridge → gateway → actuator (docs/03 Observability). Never sent to a cloud.
 */
export const rpcRequestSchema = z.discriminatedUnion("op", [
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("sessions.list"),
    params: z.object({}).default({}),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("sessions.subscribe"),
    // Register this connection for `sessions.changed` pings (1B live list): the
    // client keeps the socket open on the list view and the server pings it on a
    // debounced change in a watched workspace's transcripts dir. Payload-free —
    // the client re-fetches `sessions.list` (reusing the normal auth/grouping).
    params: z.object({}).default({}),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("session.subscribe"),
    params: z.object({
      sessionId: sessionIdSchema,
      sinceSeq: z.number().int().nonnegative().default(0),
      // Optional TAIL bound for the INITIAL replay: emit only the last `limit`
      // events (the window) instead of the whole history from `sinceSeq`, so the
      // phone opens a huge session fast and pages older on demand via
      // `session.history` (docs/02.6 windowing). OMITTED on a reconnect-resume
      // (`sinceSeq` set) so every missed event still replays.
      limit: z.number().int().positive().optional(),
    }),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("session.history"),
    // One-shot BACKWARD page for scroll-up lazy-loading: the seq'd events with
    // index in [max(0, beforeSeq - limit), beforeSeq). Empty ⇒ at the top. It
    // complements the forward, `sinceSeq`-resumable `session.subscribe` stream.
    params: z.object({
      sessionId: sessionIdSchema,
      beforeSeq: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
    }),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("session.respond"),
    params: z.object({
      sessionId: sessionIdSchema,
      // Present when answering a specific pending blocker; omitted for a
      // free-form chat message. Either way it's injected into the active chat.
      toolCallId: z.string().optional(),
      text: z.string().min(1).max(MAX_RPC_TEXT_LEN),
    }),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("session.decide"),
    params: z.object({
      sessionId: sessionIdSchema,
      // The pending tool call being approved/denied (the base toolCallId).
      toolCallId: z.string(),
      decision: decisionSchema,
    }),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("session.answer"),
    params: z.object({
      sessionId: sessionIdSchema,
      // The carousel `resolveId` (the pending blocker's `resolveId` — the RAW
      // suffixed tool_use_id), NOT the base toolCallId.
      toolCallId: z.string(),
      // One entry per question, by index; delivered structurally to the core
      // `vscode_askQuestions` carousel (docs/02 §4.16) — never as chat text.
      answers: z.array(questionAnswerSchema),
    }),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("session.steer"),
    params: z.object({
      sessionId: sessionIdSchema,
      // Injected INTO the in-flight turn to redirect it, NOT queued after it.
      // The extension prefills the composer (`chat.open {isPartialQuery}`) then
      // fires `steerWithMessage` (docs/02 §4.28 / research §7). Only meaningful
      // while the session is mid-turn (`SessionSummary.inTurn`).
      text: z.string().min(1).max(MAX_RPC_TEXT_LEN),
    }),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("session.stop"),
    params: z.object({
      sessionId: sessionIdSchema,
      // Optional follow-up: present = STOP-AND-SEND (cancel the in-flight turn
      // via `chat.cancel`, THEN send this as a fresh prompt); absent = a pure
      // stop (cancel only). A remote-operator action (docs/04).
      text: z.string().min(1).max(MAX_RPC_TEXT_LEN).optional(),
    }),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("auth"),
    params: z.object({
      // Operator app-layer auth (docs/04, F2a): a 6-digit TOTP `code` to log in,
      // OR a previously-issued session `token` to resume — at least one. On a
      // code login `remember` extends the returned token's TTL (this device).
      code: z.string().max(16).optional(),
      token: z.string().max(512).optional(),
      remember: z.boolean().optional(),
      // Trust boundary the issued token is scoped to (drift audit S3): "provider"
      // for an extension's Sign in to Gateway, else "operator" (default). A token
      // minted for one audience is rejected at the other.
      audience: z.enum(["operator", "provider"]).optional(),
    }),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("enrol.begin"),
    // First-run TOTP enrolment (docs/04, F2a): while MFA is enabled but
    // UNCONFIRMED the ingress serves only enrolment — this returns the
    // provisioning (otpauth URI + secret) so the client renders the pairing QR.
    // Refused once enrolment is confirmed (the secret is never re-revealed).
    params: z.object({}).optional(),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("gateway.connectInfo"),
    // The authenticated operator (PWA) asks how to pair an EXTENSION with this
    // gateway's native-TLS (wss) provider listener (docs/04 "Closing the gap",
    // C4): the reachable wss:// URLs, the SHA-256 fingerprint pin, and the cert
    // PEM (for `cloakcode.gatewayCaFile`). All public — no secret is returned.
    params: z.object({}).optional(),
  }),
]);
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

/** Bridge → client error envelope, correlated to the request `id`. */
export const rpcErrorSchema = z.object({
  id: z.string(),
  ok: z.literal(false),
  error: z.object({ message: z.string() }),
  // Set when the ingress requires operator auth and this connection isn't
  // authenticated yet — the client should prompt for a TOTP code / resume with a
  // stored token via the `auth` op (docs/04, F2a).
  needsAuth: z.boolean().optional(),
  // Set when MFA is enabled but NOT yet confirmed — the ingress serves only
  // enrolment. The client should run the pairing flow (`enrol.begin` → scan →
  // verify a code via `auth`) before any session op (docs/04, F2a).
  enrolmentRequired: z.boolean().optional(),
  // Display-only hint on an auth refusal: the ingress's instance id — the SAME
  // string the authenticator shows as the `CloakCode:<instanceId>` account label
  // — so the operator knows WHICH paired instance this code is for (mfa-otp-hint).
  // Pre-auth-safe (already public in the otpauth label + tunnel name); NEVER a
  // secret, NEVER used for trust/routing. Optional (older ingress omits it).
  instanceId: z.string().optional(),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;

/**
 * Ack for `auth` — the operator authenticated (a TOTP code or a valid session
 * token). A **code** login returns a fresh short-lived bearer `token` (+
 * `expiresAt`, ms epoch) the client stores to resume without re-entering a code;
 * a token-only resume returns no new token. docs/04, F2a.
 */
export const sessionAuthResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("auth"),
  token: z.string().optional(),
  expiresAt: z.number().optional(),
});
export type SessionAuthResponse = z.infer<typeof sessionAuthResponseSchema>;

/**
 * Ack for `enrol.begin` — the TOTP provisioning for first-run pairing: the
 * `otpauthUri` an authenticator app scans (rendered as a QR by the client) and
 * the base32 `secret` for manual entry. Both are **omitted in strict mode**
 * (Option B), where the QR is shown out-of-band (gateway console / VS Code) and
 * the browser only submits the verify code. Served only while unconfirmed; the
 * operator then verifies a code (via `auth`) to finish enabling MFA. docs/04, F2a.
 */
export const enrolBeginResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("enrol.begin"),
  otpauthUri: z.string().optional(),
  secret: z.string().optional(),
  // Display-only instance-id label (see `rpcErrorSchema.instanceId`) so the enrol
  // screen can name the instance even in strict mode, where `otpauthUri` (which
  // encodes the label) is withheld. Optional; never a secret.
  instanceId: z.string().optional(),
});
export type EnrolBeginResponse = z.infer<typeof enrolBeginResponseSchema>;

/**
 * Result of `gateway.connectInfo` (C4): everything an operator needs to pair an
 * **extension** with the gateway's dedicated provider listener. All fields are
 * **public** (the fingerprint is an integrity pin, the cert is public; the
 * private key is never included). `available` is true whenever the provider
 * listener exists (now always). `insecure` is true when that listener is an
 * **unencrypted** plain `ws://` (the `CLOAKCODE_PROVIDER_INSECURE` opt-in) — then
 * there is no `fingerprint`/`certPem` and the `urls` are `ws://`; the UI warns
 * (a confidentiality loss, not an access one — docs/04 insecure mode).
 */
export const gatewayConnectInfoSchema = z.object({
  /** True when the gateway exposes a provider listener (now always). */
  available: z.boolean(),
  /** Reachable provider URLs for `cloakcode.gatewayUrl`, best-first (wss or ws). */
  urls: z.array(z.string()).default([]),
  /** True when the provider listener is an unencrypted plain `ws://` (warned). */
  insecure: z.boolean().default(false),
  /** SHA-256 cert fingerprint (the pin) for `cloakcode.gatewayCertFingerprint`. */
  fingerprint: z.string().optional(),
  /** The gateway's TLS certificate PEM for `cloakcode.gatewayCaFile` (public). */
  certPem: z.string().optional(),
});
export type GatewayConnectInfo = z.infer<typeof gatewayConnectInfoSchema>;

/** Successful `gateway.connectInfo` response. */
export const gatewayConnectInfoResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("gateway.connectInfo"),
  result: gatewayConnectInfoSchema,
});
export type GatewayConnectInfoResponse = z.infer<
  typeof gatewayConnectInfoResponseSchema
>;

/** Successful `sessions.list` response. */
export const sessionsListResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("sessions.list"),
  result: z.array(sessionSummarySchema),
  /**
   * Display name of the gateway that served this list — the standalone hub's
   * instance id (its `CLOAKCODE_INSTANCE_ID`, else the machine hostname), so the
   * phone can show *which* gateway it's connected to (e.g. office vs home).
   * Absent for the embedded bridge (the session rows already carry the
   * per-workspace instance label).
   */
  gateway: z.string().optional(),
});
export type SessionsListResponse = z.infer<typeof sessionsListResponseSchema>;

/**
 * Result of `session.history` — a one-shot BACKWARD page of the seq'd log for
 * scroll-up lazy-loading. `events` are older than the requested `beforeSeq`
 * (index ascending, prefix-stable); an empty array means the client has reached
 * the top. The live tail keeps arriving on the separate `session.subscribe`
 * stream (docs/02.6 windowing).
 */
export const sessionHistoryResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("session.history"),
  result: z.object({ events: z.array(sessionEventSchema) }),
});
export type SessionHistoryResponse = z.infer<
  typeof sessionHistoryResponseSchema
>;

/**
 * Ack for `session.respond`. The text is a `remote-operator`-provenance action
 * (docs/04) — an answer to a blocker (`toolCallId` set) or a free-form chat
 * message (`toolCallId` omitted). It drives `workbench.action.chat.open` in the
 * target window and is never treated as genuine-local user intent.
 */
export const sessionRespondResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("session.respond"),
});
export type SessionRespondResponse = z.infer<
  typeof sessionRespondResponseSchema
>;

/**
 * Ack for `session.decide` - the operator's `allow`/`deny` verdict for a
 * pending tool call has been dispatched to VS Code's native confirmation via
 * the `acceptTool`/`skipTool` command, targeted by the session URI (docs/02
 * 4.16). A `remote-operator`-provenance action (docs/04).
 */
export const sessionDecideResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("session.decide"),
});
export type SessionDecideResponse = z.infer<typeof sessionDecideResponseSchema>;

/**
 * Ack for `session.answer` — the operator's structured answer to a pending
 * `vscode_askQuestions` carousel has been delivered (via the extension host's
 * `_chat.notifyQuestionCarouselAnswer`). A `remote-operator`-provenance action
 * (docs/04); unlike a chat message it resolves the tool with the proper
 * `{answers}` result instead of cancelling it.
 */
export const sessionAnswerResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("session.answer"),
});
export type SessionAnswerResponse = z.infer<typeof sessionAnswerResponseSchema>;

/**
 * Ack for `session.steer` — the operator's redirect has been injected into the
 * in-flight turn (the extension prefilled the composer then fired
 * `steerWithMessage`). A `remote-operator`-provenance action (docs/04); it leaves
 * no distinct on-disk marker — the steered text reads as a normal `user.message`
 * (docs/02 §4.28).
 */
export const sessionSteerResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("session.steer"),
});
export type SessionSteerResponse = z.infer<typeof sessionSteerResponseSchema>;

/**
 * Ack for `session.stop` — the in-flight turn was cancelled (`chat.cancel`), and
 * when a follow-up `text` was supplied it was then sent as a fresh prompt
 * (stop-and-send). A `remote-operator`-provenance action (docs/04); a cancelled
 * turn leaves no distinct on-disk marker either (docs/02 §4.28).
 */
export const sessionStopResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("session.stop"),
});
export type SessionStopResponse = z.infer<typeof sessionStopResponseSchema>;

/**
 * A streamed frame delivered for an active `session.subscribe`. Three kinds
 * share the one subscription: `event` is the seq'd, append-only history log
 * (resumable via `sinceSeq`); `pending` is a replace-snapshot of the live
 * blocker overlay from the hook; `turn` is the live mid-turn flag (mirrors
 * `SessionSummary.inTurn`) so the composer flips steer/queue↔send the moment the
 * turn opens or closes, without waiting for a `sessions.list` refresh. Keeping
 * them distinct means the history channel stays prefix-stable while the overlay
 * and turn flag update idempotently. A terminal `error` frame (a redaction-safe
 * `code`, e.g. `ERR_STRING_TOO_LONG`, plus the offending `bytes`) tells the
 * client the session could not be read, so it shows a reason instead of a silent
 * blank (docs/02.6 §4.31).
 */
export const sessionSubscribeEventSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    op: z.literal("session.subscribe"),
    kind: z.literal("event"),
    event: sessionEventSchema,
  }),
  z.object({
    id: z.string(),
    op: z.literal("session.subscribe"),
    kind: z.literal("pending"),
    blockers: z.array(pendingBlockerSchema),
  }),
  z.object({
    id: z.string(),
    op: z.literal("session.subscribe"),
    kind: z.literal("turn"),
    inTurn: z.boolean(),
  }),
  z.object({
    id: z.string(),
    op: z.literal("session.subscribe"),
    kind: z.literal("usage"),
    // Session usage TOTAL, aggregated server-side over the WHOLE log (not the
    // tail window), so partial loading can't undercount it (docs/02.6 §4.32).
    usage: usageSummarySchema,
  }),
  z.object({
    id: z.string(),
    op: z.literal("session.subscribe"),
    kind: z.literal("error"),
    // A redaction-safe error CODE (e.g. ERR_STRING_TOO_LONG) — never a message.
    code: z.string(),
    // The offending file's size, when the failure is a size cap (docs/02.6 §4.31).
    bytes: z.number().optional(),
  }),
]);
export type SessionSubscribeEvent = z.infer<typeof sessionSubscribeEventSchema>;

/**
 * Info a **provider** (an extension in client mode) announces to a standalone
 * gateway (docs/03 “Explicit gateway”). `instanceId` is how the gateway routes
 * session-addressed RPCs back to this provider; the fanned-out session list is
 * de-duped by `sessionId` (preferring the owned copy) so one session reported by
 * several providers shows once. `version` / `workspaceHashes` are diagnostics.
 */
export const providerInfoSchema = z.object({
  instanceId: z.string().min(1),
  version: z.string().optional(),
  workspaceHashes: z.array(z.string()).optional(),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

/**
 * The minimal "knock" — the FIRST frame on a gateway connection, before any
 * payload. A client announces only that it speaks CloakCode and its role
 * (`provider` = an extension, `operator` = a phone/PWA); the gateway, once it has
 * heard a valid knock, answers with its own `gateway` knock. Nothing sensitive
 * (instanceId, workspace, phone URL) is exchanged until BOTH sides have
 * identified this way — so a stray port scanner that opens the socket and stays
 * silent, or sends garbage, learns nothing and is dropped. A `provider` then
 * follows with its full {@link connectionHelloSchema} hello.
 */
export const cloakcodeHelloSchema = z.object({
  type: z.literal("cloakcode.hello"),
  role: z.enum(["provider", "operator", "gateway"]),
});
export type CloakcodeHello = z.infer<typeof cloakcodeHelloSchema>;

/**
 * First frame on a gateway `/bridge` connection, declaring the peer's role so
 * the standalone gateway can multiplex phones and extension providers on one
 * endpoint. An `operator` (phone / PWA) then speaks the usual client RPC; a
 * `provider` serves the gateway's forwarded RPCs for its own `instanceId` and
 * presents the **provider↔gateway shared secret** (`token`) so only your own
 * extensions can register — a machine-to-machine credential, never exchanged
 * with or shown to the operator (operator auth is a separate concern, docs/05
 * Q9). A connection that sends no hello is treated as an `operator`, so the
 * embedded bridge (where every client is a phone) is unaffected.
 */
export const connectionHelloSchema = z.discriminatedUnion("role", [
  z.object({ type: z.literal("hello"), role: z.literal("operator") }),
  z.object({
    type: z.literal("hello"),
    role: z.literal("provider"),
    provider: providerInfoSchema,
    token: z.string().optional(),
  }),
]);
export type ConnectionHello = z.infer<typeof connectionHelloSchema>;

/**
 * Gateway → provider control frame. The standalone gateway pushes its
 * phone-reachable URL (the tunnel it owns) down to each connected provider, so an
 * extension in client mode can render the QR / “Show Phone Link” for the HUB
 * rather than a local bridge it doesn't run. `phoneUrl` is absent until the
 * gateway has a public URL (e.g. no tunnel yet). Its distinct `type` keeps it
 * from colliding with the operator-facing RPC responses on the same socket.
 */
export const gatewayInfoSchema = z.object({
  type: z.literal("gateway.info"),
  phoneUrl: z.string().url().optional(),
});
export type GatewayInfo = z.infer<typeof gatewayInfoSchema>;

/**
 * Gateway → provider control frame sent (just before the socket is closed) when
 * a provider's hello credential is missing or invalid and the gateway requires
 * provider auth (docs/04, F2a slice 2). It lets the extension distinguish "wrong
 * / no credential" from "unreachable", so it can prompt for a TOTP code once,
 * exchange it for a provider token, and reconnect — instead of silently
 * reconnect-looping. Carries no secret.
 */
export const providerAuthRequiredSchema = z.object({
  type: z.literal("provider.auth_required"),
  // The gateway's own instance-id (display label) so the extension's sign-in
  // prompt can name WHICH gateway/instance the TOTP code is for (mfa-otp-hint,
  // matching the PWA). Display-only + pre-auth-safe (already public in the
  // `CloakCode:<id>` authenticator label + the tunnel name); never a secret,
  // never used for trust/routing. Optional — an older gateway omits it.
  instanceId: z.string().optional(),
});
export type ProviderAuthRequired = z.infer<typeof providerAuthRequiredSchema>;

/**
 * Server → operator control frame: the session LIST changed (a new/updated
 * session in a watched workspace), so a client showing the list should re-fetch
 * `sessions.list` (1B live list). A payload-free "dirty ping" — the re-fetch
 * reuses the normal auth/grouping path, and the ping carries nothing sensitive.
 * Reused on the provider→gateway hop too: a provider sends it up on its own
 * dir-change and the gateway fans it out to subscribed operators. Its distinct
 * `type` keeps it off the RPC-response path (like {@link gatewayInfoSchema}).
 */
export const sessionsChangedSchema = z.object({
  type: z.literal("sessions.changed"),
});
export type SessionsChanged = z.infer<typeof sessionsChangedSchema>;
