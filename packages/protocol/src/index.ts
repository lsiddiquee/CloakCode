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
]);
export type SessionPart = z.infer<typeof sessionPartSchema>;

/**
 * One frame of the sequence-numbered session event log. `append` adds a part;
 * `updateStatus` mutates a prior tool-call part. A reconnecting client resumes
 * from `sinceSeq`; the derived sequence is prefix-stable (append-only source).
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
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

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

/** A streamed frame delivered for an active `session.subscribe`. */
export const sessionSubscribeEventSchema = z.object({
  id: z.string(),
  op: z.literal("session.subscribe"),
  event: sessionEventSchema,
});
export type SessionSubscribeEvent = z.infer<typeof sessionSubscribeEventSchema>;
