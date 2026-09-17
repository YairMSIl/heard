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
  clampSpecs,
  deploymentWindows,
  evaluateWindows,
  hashSource,
  sourceBucket,
  sourceShareWindows,
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

describe('per-source share of a site (R1.1)', () => {
  it('gives one source a fifth of each qualifying window', () => {
    expect(sourceShareWindows({ hourly_cap: 30, daily_cap: 200 }).map(w => w.limit)).toEqual([6, 40])
  })

  it('no longer floors a tiny cap at 1 (S14 reversed this)', () => {
    // The old behaviour raised floor(1 * 0.2) = 0 up to 1, which meant a single
    // report per hour for an entire shared connection. Now no share applies.
    expect(sourceShareWindows({ hourly_cap: 1, daily_cap: 2 })).toEqual([])
  })

  it('keeps the site-wide number as the real ceiling', () => {
    const site = siteWindows({ hourly_cap: 30, daily_cap: 200 })
    const source = sourceShareWindows({ hourly_cap: 30, daily_cap: 200 })
    source.forEach((w, i) => expect(w.limit).toBeLessThan(site[i].limit))
  })
})

describe('hashSource', () => {
  it('is stable and differs between addresses', () => {
    expect(hashSource('1.2.3.4')).toBe(hashSource('1.2.3.4'))
    expect(hashSource('1.2.3.4')).not.toBe(hashSource('1.2.3.5'))
  })
  it('does not leak the address it came from', () => {
    expect(hashSource('203.0.113.9')).not.toContain('203')
    expect(hashSource('203.0.113.9')).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('clampSpecs (R5)', () => {
  it('caps a caller asking for an absurd limit', () => {
    const clamped = clampSpecs([{ name: 'day', ms: DAY_MS, limit: 10_000_000 }])
    expect(clamped[0].limit).toBe(DEPLOYMENT_DAILY_CAP)
  })
  it('leaves legitimate limits alone', () => {
    expect(clampSpecs([{ name: 'hour', ms: HOUR_MS, limit: 30 }])[0].limit).toBe(30)
    expect(clampSpecs([{ name: 'minute', ms: MINUTE_MS, limit: 10 }])[0].limit).toBe(10)
  })
  it('never clamps below 1', () => {
    expect(clampSpecs([{ name: 'hour', ms: HOUR_MS, limit: 0 }])[0].limit).toBe(1)
  })
})

describe('sourceBucket (S14)', () => {
  it('collapses an IPv4 address to its /24, so a NAT is one bucket', () => {
    expect(sourceBucket('203.0.113.7')).toBe('203.0.113.0/24')
    expect(sourceBucket('203.0.113.250')).toBe('203.0.113.0/24')
    expect(sourceBucket('203.0.113.7')).toBe(sourceBucket('203.0.113.99'))
  })

  it('keeps different /24s apart', () => {
    expect(sourceBucket('203.0.113.7')).not.toBe(sourceBucket('203.0.114.7'))
  })

  it('collapses an IPv6 address to its /64', () => {
    expect(sourceBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(sourceBucket('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64')
  })

  it('expands a compressed IPv6 run correctly', () => {
    expect(sourceBucket('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(sourceBucket('fd00::abcd')).toBe('fd00:0:0:0::/64')
  })

  it('separates different /64s that share a prefix', () => {
    expect(sourceBucket('2001:db8:1:2::1')).not.toBe(sourceBucket('2001:db8:1:3::1'))
  })

  it('passes through anything it does not recognise', () => {
    expect(sourceBucket('unknown')).toBe('unknown')
  })
})

describe('the share is not applied to small caps (S14)', () => {
  it('produces no windows below the minimum cap', () => {
    // floor(3 * 0.2) = 0, and a floor of 1 would stop two colleagues behind one
    // NAT both filing. No share at all is the honest answer.
    expect(sourceShareWindows({ hourly_cap: 3, daily_cap: 5 })).toEqual([])
    expect(sourceShareWindows({ hourly_cap: 9, daily_cap: 9 })).toEqual([])
  })

  it('applies per window independently at the boundary', () => {
    // hour 10 qualifies, day 9 does not.
    const w = sourceShareWindows({ hourly_cap: 10, daily_cap: 9 })
    expect(w.map(x => x.name)).toEqual(['hour'])
    expect(w[0].limit).toBe(2)
  })

  it('still applies at the defaults', () => {
    expect(sourceShareWindows({ hourly_cap: null, daily_cap: null }).map(w => w.limit)).toEqual([6, 40])
  })
})
