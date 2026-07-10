import { z } from "zod";

/**
 * Liveness-derived session status. Per research (docs/02 §3.3) this comes from
 * file mtime + the blocker signature, never from the last event type.
 */
export const sessionStatusSchema = z.enum(["active", "blocked", "idle"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * One row in the remote session picker. Addressed by `(instanceId, sessionId)`
 * so multiple environments (dev containers / WSL / host) never collide — see
 * docs/03 "Multi-instance topology".
 */
export const sessionSummarySchema = z.object({
  instanceId: z.string(),
  sessionId: z.string(),
  workspace: z.string(),
  title: z.string(),
  turns: z.number().int().nonnegative(),
  status: sessionStatusSchema,
  idleSeconds: z.number().int().nonnegative(),
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
  freeText: z.string().nullable().optional(),
});
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

/**
 * Client → bridge request envelope. A discriminated union on `op` so each
 * operation can carry its own typed params; new ops extend this array.
 */
export const rpcRequestSchema = z.discriminatedUnion("op", [
  z.object({
    id: z.string(),
    op: z.literal("sessions.list"),
    params: z.object({}).default({}),
  }),
  z.object({
    id: z.string(),
    op: z.literal("session.subscribe"),
    params: z.object({
      instanceId: z.string(),
      sessionId: z.string(),
      sinceSeq: z.number().int().nonnegative().default(0),
    }),
  }),
  z.object({
    id: z.string(),
    op: z.literal("session.respond"),
    params: z.object({
      instanceId: z.string(),
      sessionId: z.string(),
      // Present when answering a specific pending blocker; omitted for a
      // free-form chat message. Either way it's injected into the active chat.
      toolCallId: z.string().optional(),
      text: z.string().min(1),
    }),
  }),
  z.object({
    id: z.string(),
    op: z.literal("session.control"),
    params: z.object({
      instanceId: z.string(),
      sessionId: z.string(),
      // Toggle whether the remote operator has "taken control" of this session.
      // While in control the blocking hook holds confirmable tool calls for a
      // remote decision; off restores the pure-notifier (native-approval) path.
      control: z.boolean(),
    }),
  }),
  z.object({
    id: z.string(),
    op: z.literal("session.decide"),
    params: z.object({
      instanceId: z.string(),
      sessionId: z.string(),
      // The pending tool call being approved/denied (the base toolCallId).
      toolCallId: z.string(),
      decision: decisionSchema,
    }),
  }),
  z.object({
    id: z.string(),
    op: z.literal("session.answer"),
    params: z.object({
      instanceId: z.string(),
      sessionId: z.string(),
      // The carousel `resolveId` (the pending blocker's `resolveId` — the RAW
      // suffixed tool_use_id), NOT the base toolCallId.
      toolCallId: z.string(),
      // One entry per question, by index; delivered structurally to the core
      // `vscode_askQuestions` carousel (docs/02 §4.16) — never as chat text.
      answers: z.array(questionAnswerSchema),
    }),
  }),
]);
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

/** Bridge → client error envelope, correlated to the request `id`. */
export const rpcErrorSchema = z.object({
  id: z.string(),
  ok: z.literal(false),
  error: z.object({ message: z.string() }),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;

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
 * Ack for `session.control` — the operator has toggled take-control on the
 * target session. A `remote-operator`-provenance action (docs/04): it only
 * flips CloakCode's own per-session policy marker and never itself approves a
 * tool call.
 */
export const sessionControlResponseSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  op: z.literal("session.control"),
});
export type SessionControlResponse = z.infer<
  typeof sessionControlResponseSchema
>;

/**
 * Ack for `session.decide` — the operator's `allow`/`deny` verdict for a
 * pending tool call has been recorded (as the hook's on-disk decision file).
 * A `remote-operator`-provenance action (docs/04); the blocking hook consumes
 * it, and a missing/late verdict falls through to VS Code's native approval.
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
 * A streamed frame delivered for an active `session.subscribe`. Two separate
 * kinds share the one subscription: `event` is the seq'd, append-only history
 * log (resumable via `sinceSeq`); `pending` is a replace-snapshot of the live
 * blocker overlay from the hook. Keeping them distinct means the history
 * channel stays prefix-stable while the overlay updates idempotently.
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
]);
export type SessionSubscribeEvent = z.infer<typeof sessionSubscribeEventSchema>;
