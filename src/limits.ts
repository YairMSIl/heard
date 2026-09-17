/**
 * Rate-limit policy, kept separate from the machinery that enforces it.
 *
 * Everything here is pure: given windows, stored counters and a clock, decide.
 * The Durable Object is a thin shell around `evaluateWindows`, which is what
 * makes this testable without a Workers runtime — and rate limiting is exactly
 * the kind of arithmetic that is easy to get subtly wrong and hard to notice.
 */

export const IP_PER_MINUTE = 10
export const DEFAULT_HOURLY_CAP = 30
export const DEFAULT_DAILY_CAP = 200

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

export type WindowName = 'minute' | 'hour' | 'day'

export interface WindowSpec {
  name: WindowName
  ms: number
  limit: number
}

export interface Bucket {
  bucket: number
  count: number
}

export interface WindowUsage {
  name: WindowName
  count: number
  limit: number
  resetAt: number
}

export interface Evaluation {
  allowed: boolean
  blockedWindow: WindowName | null
  retryAfterSeconds: number
  next: Record<string, Bucket>
  usage: WindowUsage[]
}

export interface SiteCaps {
  daily_cap?: number | null
  hourly_cap?: number | null
}

/** A null column means "use the default", so an operator can clear an override. */
export function resolveCaps(site: SiteCaps | null | undefined): { hourly: number; daily: number } {
  const hourly = site?.hourly_cap
  const daily = site?.daily_cap
  return {
    hourly: typeof hourly === 'number' && hourly > 0 ? hourly : DEFAULT_HOURLY_CAP,
    daily: typeof daily === 'number' && daily > 0 ? daily : DEFAULT_DAILY_CAP,
  }
}

export function siteWindows(site: SiteCaps | null | undefined): WindowSpec[] {
  const caps = resolveCaps(site)
  return [
    { name: 'hour', ms: HOUR_MS, limit: caps.hourly },
    { name: 'day', ms: DAY_MS, limit: caps.daily },
  ]
}

export function ipWindows(): WindowSpec[] {
  return [{ name: 'minute', ms: MINUTE_MS, limit: IP_PER_MINUTE }]
}

/**
 * Fixed windows, evaluated all-or-nothing: if any window is already at its
 * limit, nothing is incremented. Counting a request that was refused would let
 * a blocked caller keep pushing its own reset further away, which is a
 * surprising way to turn a rate limit into a lockout.
 */
export function evaluateWindows(
  specs: WindowSpec[],
  stored: Record<string, Bucket | undefined>,
  now: number,
  mode: 'consume' | 'peek' = 'consume',
): Evaluation {
  const current = specs.map(spec => {
    const bucket = Math.floor(now / spec.ms)
    const saved = stored[spec.name]
    const count = saved && saved.bucket === bucket ? saved.count : 0
    return { spec, bucket, count, resetAt: (bucket + 1) * spec.ms }
  })

  const blocked = current.find(w => w.count >= w.spec.limit)
  const usage = current.map(w => ({
    name: w.spec.name,
    count: w.count,
    limit: w.spec.limit,
    resetAt: w.resetAt,
  }))

  if (blocked) {
    return {
      allowed: false,
      blockedWindow: blocked.spec.name,
      retryAfterSeconds: Math.max(1, Math.ceil((blocked.resetAt - now) / 1000)),
      next: {},
      usage,
    }
  }

  // A peek answers "where does this site stand", so it must not add a request
  // that is not happening — the dashboard would otherwise read one high, and a
  // site sitting at its cap would look over it.
  if (mode === 'peek') {
    return { allowed: true, blockedWindow: null, retryAfterSeconds: 0, usage, next: {} }
  }

  const next: Record<string, Bucket> = {}
  for (const w of current) next[w.spec.name] = { bucket: w.bucket, count: w.count + 1 }

  return {
    allowed: true,
    blockedWindow: null,
    retryAfterSeconds: 0,
    // Usage reported to the caller reflects the request just accepted.
    usage: usage.map(u => ({ ...u, count: u.count + 1 })),
    next,
  }
}
