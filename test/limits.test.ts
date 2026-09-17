import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  DEFAULT_DAILY_CAP,
  DEFAULT_HOURLY_CAP,
  HOUR_MS,
  IP_PER_MINUTE,
  MINUTE_MS,
  DEPLOYMENT_DAILY_CAP,
  DEPLOYMENT_HOURLY_CAP,
  SITES_PER_OWNER,
  deploymentWindows,
  evaluateWindows,
  ipWindows,
  resolveCaps,
  siteWindows,
  type Bucket,
} from '../src/limits'

const NOW = 1_800_000_000_000

describe('resolveCaps', () => {
  it('falls back to defaults for null columns', () => {
    expect(resolveCaps(null)).toEqual({ hourly: DEFAULT_HOURLY_CAP, daily: DEFAULT_DAILY_CAP })
    expect(resolveCaps({ hourly_cap: null, daily_cap: null }))
      .toEqual({ hourly: 30, daily: 200 })
  })

  it('honours per-site overrides', () => {
    expect(resolveCaps({ hourly_cap: 5, daily_cap: 9 })).toEqual({ hourly: 5, daily: 9 })
  })

  it('treats zero and negatives as "unset", never as "no limit"', () => {
    // A 0 in the column must not silently disable protection.
    expect(resolveCaps({ hourly_cap: 0, daily_cap: -1 }))
      .toEqual({ hourly: DEFAULT_HOURLY_CAP, daily: DEFAULT_DAILY_CAP })
  })

  it('allows one override without dragging the other along', () => {
    expect(resolveCaps({ hourly_cap: 3, daily_cap: null }))
      .toEqual({ hourly: 3, daily: DEFAULT_DAILY_CAP })
  })
})

describe('window specs', () => {
  it('gives an IP one minute window at the documented limit', () => {
    expect(ipWindows()).toEqual([{ name: 'minute', ms: MINUTE_MS, limit: IP_PER_MINUTE }])
  })
  it('gives a site an hour and a day window', () => {
    expect(siteWindows({ hourly_cap: 2, daily_cap: 4 })).toEqual([
      { name: 'hour', ms: HOUR_MS, limit: 2 },
      { name: 'day', ms: DAY_MS, limit: 4 },
    ])
  })
})

describe('evaluateWindows', () => {
  const specs = [{ name: 'hour' as const, ms: HOUR_MS, limit: 2 }, { name: 'day' as const, ms: DAY_MS, limit: 3 }]
  const bucketFor = (ms: number, now = NOW) => Math.floor(now / ms)

  it('allows and increments every window when under all limits', () => {
    const result = evaluateWindows(specs, {}, NOW)
    expect(result.allowed).toBe(true)
    expect(result.next).toEqual({
      hour: { bucket: bucketFor(HOUR_MS), count: 1 },
      day: { bucket: bucketFor(DAY_MS), count: 1 },
    })
  })

  it('reports usage including the request just accepted', () => {
    const result = evaluateWindows(specs, { hour: { bucket: bucketFor(HOUR_MS), count: 1 } }, NOW)
    expect(result.usage).toEqual([
      { name: 'hour', count: 2, limit: 2, resetAt: (bucketFor(HOUR_MS) + 1) * HOUR_MS },
      { name: 'day', count: 1, limit: 3, resetAt: (bucketFor(DAY_MS) + 1) * DAY_MS },
    ])
  })

  it('refuses when any single window is full, naming that window', () => {
    const stored: Record<string, Bucket> = { hour: { bucket: bucketFor(HOUR_MS), count: 2 } }
    const result = evaluateWindows(specs, stored, NOW)
    expect(result.allowed).toBe(false)
    expect(result.blockedWindow).toBe('hour')
  })

  it('increments nothing when refused, so a blocked caller cannot push its own reset away', () => {
    const stored: Record<string, Bucket> = {
      hour: { bucket: bucketFor(HOUR_MS), count: 2 },
      day: { bucket: bucketFor(DAY_MS), count: 2 },
    }
    const result = evaluateWindows(specs, stored, NOW)
    expect(result.next).toEqual({})
    // The day counter is reported untouched, not bumped by the refused request.
    expect(result.usage.find(u => u.name === 'day')!.count).toBe(2)
  })

  it('blocks on the day cap even when the hour is quiet', () => {
    const stored: Record<string, Bucket> = { day: { bucket: bucketFor(DAY_MS), count: 3 } }
    expect(evaluateWindows(specs, stored, NOW)).toMatchObject({ allowed: false, blockedWindow: 'day' })
  })

  it('computes retry-after from the blocked window and never returns 0', () => {
    const hourBucket = bucketFor(HOUR_MS)
    const nearReset = (hourBucket + 1) * HOUR_MS - 500
    const result = evaluateWindows(specs, { hour: { bucket: bucketFor(HOUR_MS, nearReset), count: 2 } }, nearReset)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBe(1)
  })

  it('resets when the bucket rolls over', () => {
    const stored: Record<string, Bucket> = { hour: { bucket: bucketFor(HOUR_MS) - 1, count: 99 } }
    expect(evaluateWindows(specs, stored, NOW)).toMatchObject({ allowed: true })
  })

  it('ignores counters from a stale bucket rather than trusting the number', () => {
    const stored: Record<string, Bucket> = { hour: { bucket: 1, count: 500 }, day: { bucket: 1, count: 500 } }
    const result = evaluateWindows(specs, stored, NOW)
    expect(result.allowed).toBe(true)
    expect(result.usage.map(u => u.count)).toEqual([1, 1])
  })

  it('peek reports the state as it stands, without the request that is not happening', () => {
    const stored: Record<string, Bucket> = { hour: { bucket: bucketFor(HOUR_MS), count: 1 } }
    const peeked = evaluateWindows(specs, stored, NOW, 'peek')
    expect(peeked.usage.find(u => u.name === 'hour')!.count).toBe(1)
    expect(peeked.next).toEqual({})
    // The same input consumed would report 2 — that difference is the bug this
    // guards: a dashboard peek must not inflate a site's usage.
    expect(evaluateWindows(specs, stored, NOW).usage.find(u => u.name === 'hour')!.count).toBe(2)
  })

  it('lets exactly `limit` requests through and refuses the next', () => {
    let stored: Record<string, Bucket> = {}
    const accepted: boolean[] = []
    for (let i = 0; i < 4; i++) {
      const r = evaluateWindows([{ name: 'hour', ms: HOUR_MS, limit: 2 }], stored, NOW)
      accepted.push(r.allowed)
      if (r.allowed) stored = r.next
    }
    expect(accepted).toEqual([true, true, false, false])
  })
})

describe('deployment ceiling', () => {
  it('is far above any single site cap but still finite', () => {
    const windows = deploymentWindows()
    expect(windows.map(w => w.name)).toEqual(['hour', 'day'])
    const day = windows.find(w => w.name === 'day')!
    const hour = windows.find(w => w.name === 'hour')!
    expect(day.limit).toBe(DEPLOYMENT_DAILY_CAP)
    expect(hour.limit).toBe(DEPLOYMENT_HOURLY_CAP)
    // It must exceed one site's default allowance, or a single honest site
    // would trip the global ceiling on its own.
    expect(day.limit).toBeGreaterThan(DEFAULT_DAILY_CAP)
    expect(hour.limit).toBeGreaterThan(DEFAULT_HOURLY_CAP)
  })

  it('cannot be reached by the per-owner site allowance alone', () => {
    // 5 sites x 200/day is the most one owner can legitimately generate.
    expect(SITES_PER_OWNER * DEFAULT_DAILY_CAP).toBeLessThan(DEPLOYMENT_DAILY_CAP)
  })
})
