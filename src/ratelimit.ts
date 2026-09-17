/**
 * Fixed-window, in-memory rate limiter.
 *
 * Keys come from `cf-connecting-ip` only. `x-forwarded-for` is caller-supplied,
 * so trusting it would let anyone claim a new identity per request and bypass
 * this entirely; requests without a trusted address share one bucket instead.
 *
 * Workers isolates are per-colo and short-lived, so this is a best-effort
 * throttle rather than a global guarantee: a determined attacker spread across
 * colos gets more than `limit`. That is an accepted MVP trade-off — it costs
 * zero storage reads and stops the realistic case (one script hammering one
 * endpoint). Swap in a Durable Object or D1 counter if abuse becomes real.
 */
export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

interface Bucket {
  count: number
  resetAt: number
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, now: number = Date.now()): RateLimitResult {
    this.sweep(now)
    const bucket = this.buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return { allowed: true, remaining: this.limit - 1, retryAfterSeconds: 0 }
    }

    if (bucket.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      }
    }

    bucket.count += 1
    return { allowed: true, remaining: this.limit - bucket.count, retryAfterSeconds: 0 }
  }

  /** Drop expired buckets so a long-lived isolate cannot grow unbounded. */
  private sweep(now: number): void {
    if (this.buckets.size < 1000) return
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }

  get size(): number {
    return this.buckets.size
  }
}

/** 10 reports per IP per minute: generous for a human, useless for a script. */
export const reportRateLimiter = new RateLimiter(10, 60_000)
