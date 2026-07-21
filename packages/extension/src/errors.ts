/**
 * A stable, **redaction-safe** error CODE string for structured logging — the
 * Node `errno` code (`ENOENT`, `EISDIR`, `EACCES`, `ERR_STRING_TOO_LONG`, …),
 * else the `Error` name, else `"unknown"`. Deliberately NOT the message: a
 * message can carry a path, a prompt, or file content, which must never reach a
 * log sink (docs/04 no-secrets rule). Fields built from this stay primitive.
 */
export function errorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; name?: unknown };
    if (typeof e.code === "string") return e.code;
    if (typeof e.name === "string") return e.name;
  }
  return "unknown";
}
