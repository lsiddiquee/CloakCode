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
