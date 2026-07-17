/**
 * A tiny token-bucket rate limiter (pure, injectable clock) for bounding the
 * message rate of a single operator connection at the ingress — defense-in-depth
 * against a flood on the bridge/gateway (docs/04). `capacity` is the max burst;
 * `refillPerSec` the sustained rate. A shared runtime utility (not a schema).
 */
export class RateLimiter {
  #tokens: number;
  #last: number;
  readonly #now: () => number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now: () => number = () => Date.now(),
  ) {
    this.#tokens = capacity;
    this.#now = now;
    this.#last = now();
  }

  /** Consume one token; returns false when over the limit (drop the message). */
  take(): boolean {
    const t = this.#now();
    this.#tokens = Math.min(
      this.capacity,
      this.#tokens + ((t - this.#last) / 1000) * this.refillPerSec,
    );
    this.#last = t;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/** Default operator-ingress limits: burst of 40, sustained 20 msg/sec — ample
 *  for a human driving a session while bounding a flood (F2b). */
export const OPERATOR_MSG_BURST = 40;
export const OPERATOR_MSG_RATE_PER_SEC = 20;
