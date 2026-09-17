/**
 * Rate-limit policy, kept separate from the machinery that enforces it.
 *
 * Everything here is pure: given windows, stored counters and a clock, decide.
 * The Durable Object is a thin shell around `evaluateWindows`, which is what
 * makes this testable without a Workers runtime — and rate limiting is exactly
 * the kind of arithmetic that is easy to get subtly wrong and hard to notice.
 */

export const IP_PER_MINUTE = 10
/** Ceiling for the whole deployment, so no combination of sites can reach the D1 quota. */
export const DEPLOYMENT_DAILY_CAP = 5000
export const DEPLOYMENT_HOURLY_CAP = 1000
/** Sign-in is open to any GitHub account, so site creation needs its own ceiling. */
export const SITES_PER_OWNER = 5
/**
 * One source may take at most this share of a site's window. The site-wide
 * number stays the ceiling; this stops a single address consuming all of it and
 * starving the site's real visitors.
 */
export const SOURCE_SHARE = 0.2
/**
 * Below this cap the share is not applied at all. At the 60/hour default a fifth
 * is 12, which is a usable allowance; at 3/hour `floor(3 * 0.2)` is 0 and the
 * floor of 1 would mean two people behind one office NAT cannot both file a
 * report. A small cap is already the owner saying "I expect very little
 * traffic", so the site-wide number is protection enough.
 */
export const SOURCE_SHARE_MIN_CAP = 10
/** Distinct sources tracked per window, so the DO's storage cannot grow without bound. */
export const MAX_TRACKED_SOURCES = 500
export const DEFAULT_HOURLY_CAP = 60
export const DEFAULT_DAILY_CAP = 500

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

/**
 * A site's windows scaled to one source's share, or an empty list when the site's
 * cap is too small for a share to be meaningful — see SOURCE_SHARE_MIN_CAP.
 */
export function sourceShareWindows(site: SiteCaps | null | undefined): WindowSpec[] {
  return siteWindows(site)
    .filter(w => w.limit >= SOURCE_SHARE_MIN_CAP)
    .map(w => ({ ...w, limit: Math.max(1, Math.floor(w.limit * SOURCE_SHARE)) }))
}

/**
 * Coarsens an address to the unit a shared connection actually occupies: an IPv4
 * /24 or an IPv6 /64. A whole office, campus or carrier NAT is then one bucket
 * rather than one visitor, so the share throttles a network instead of punishing
 * the seventh colleague to report the same outage.
 *
 * The cost is that an abuser with a /24 is also one bucket — which is the right
 * trade: the site-wide cap is the real ceiling, and this only decides how the
 * ceiling is shared out.
 */
export function sourceBucket(ip: string): string {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/)
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`
  if (ip.includes(':')) {
    // First four hextets are the /64; expand a :: run only as far as needed.
    const [head] = ip.split('%')
    const parts = head.split('::')
    const left = parts[0].split(':').filter(Boolean)
    if (parts.length === 1) return left.slice(0, 4).join(':') + '::/64'
    const right = (parts[1] ?? '').split(':').filter(Boolean)
    const missing = Math.max(0, 8 - left.length - right.length)
    const full = [...left, ...Array(missing).fill('0'), ...right]
    return full.slice(0, 4).join(':') + '::/64'
  }
  return ip
}

/**
 * Partition key for a source within a site. Hashed (FNV-1a) rather than raw so
 * visitor addresses are not written into Durable Object instance names; it is a
 * bucketing key, not a security boundary.
 */
export function hashSource(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Ceiling a caller may ask for in any window. The Durable Object clamps every
 * incoming spec against these, so a bug or a compromised caller cannot request a
 * limit of a million and quietly disable the protection.
 */
export const MAX_ALLOWED_LIMIT: Record<WindowName, number> = {
  minute: IP_PER_MINUTE,
  hour: DEPLOYMENT_HOURLY_CAP,
  day: DEPLOYMENT_DAILY_CAP,
}

export function clampSpecs(specs: WindowSpec[]): WindowSpec[] {
  return specs.map(spec => ({
    ...spec,
    limit: Math.max(1, Math.min(spec.limit, MAX_ALLOWED_LIMIT[spec.name] ?? spec.limit)),
  }))
}

export function ipWindows(): WindowSpec[] {
  return [{ name: 'minute', ms: MINUTE_MS, limit: IP_PER_MINUTE }]
}

/**
 * The last line: a single counter for every report the deployment accepts. Per-site
 * caps bound one abuser; without this, minting sites multiplies the allowance and
 * the free tier is still reachable.
 */
export function deploymentWindows(): WindowSpec[] {
  return [
    { name: 'hour', ms: HOUR_MS, limit: DEPLOYMENT_HOURLY_CAP },
    { name: 'day', ms: DAY_MS, limit: DEPLOYMENT_DAILY_CAP },
  ]
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
