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
    op: z.literal("session.subscribe"),
    params: z.object({
      sessionId: z.string(),
      sinceSeq: z.number().int().nonnegative().default(0),
    }),
  }),
  z.object({
    id: z.string(),
    traceId: z.string().optional(),
    op: z.literal("session.respond"),
    params: z.object({
      sessionId: z.string(),
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
      sessionId: z.string(),
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
      sessionId: z.string(),
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
      sessionId: z.string(),
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
      sessionId: z.string(),
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
});
export type EnrolBeginResponse = z.infer<typeof enrolBeginResponseSchema>;

/** Successful `sessions.list` response. */
export const sessionsListResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("sessions.list"),
  result: z.array(sessionSummarySchema),
});
export type SessionsListResponse = z.infer<typeof sessionsListResponseSchema>;

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
 * and turn flag update idempotently.
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
});
export type ProviderAuthRequired = z.infer<typeof providerAuthRequiredSchema>;
