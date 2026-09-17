import { describe, expect, it, vi } from 'vitest'
import { RateLimiterDO } from '../src/rate-limiter-do'
import { DAY_MS, HOUR_MS, type WindowSpec } from '../src/limits'
import { consumeIp, consumeSite, peekSite } from '../src/ratelimit-client'
import type { Env } from '../src/types'

/** A Map standing in for Durable Object storage. */
function fakeState() {
  const store = new Map<string, unknown>()
  return {
    store,
    state: {
      storage: {
        get: async <T>(key: string) => store.get(key) as T | undefined,
        put: async (key: string, value: unknown) => void store.set(key, value),
      },
    } as unknown as DurableObjectState,
  }
}

const specs: WindowSpec[] = [
  { name: 'hour', ms: HOUR_MS, limit: 2 },
  { name: 'day', ms: DAY_MS, limit: 3 },
]
const NOW = 1_800_000_000_000

async function call(
  limiter: RateLimiterDO,
  body: Record<string, unknown>,
): Promise<{ allowed: boolean; notify: boolean; blockedWindow: string | null; retryAfterSeconds: number; usage: { name: string; count: number }[] }> {
  const res = await limiter.fetch(new Request('https://rate-limiter/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return await res.json()
}

describe('RateLimiterDO', () => {
  it('counts across calls and refuses past the limit', async () => {
    const { state } = fakeState()
    const limiter = new RateLimiterDO(state)
    const results: boolean[] = []
    for (let i = 0; i < 4; i++) {
      results.push((await call(limiter, { action: 'consume', specs, now: NOW })).allowed)
    }
    expect(results).toEqual([true, true, false, false])
  })

  it('persists counters between requests, which the in-memory limiter could not do globally', async () => {
    const { state, store } = fakeState()
    const limiter = new RateLimiterDO(state)
    await call(limiter, { action: 'consume', specs, now: NOW })
    expect(store.get('w:hour')).toEqual({ bucket: Math.floor(NOW / HOUR_MS), count: 1 })
    expect(store.get('w:day')).toEqual({ bucket: Math.floor(NOW / DAY_MS), count: 1 })
  })

  it('peek never moves a counter', async () => {
    const { state, store } = fakeState()
    const limiter = new RateLimiterDO(state)
    await call(limiter, { action: 'consume', specs, now: NOW })
    const before = { ...(store.get('w:hour') as object) }

    for (let i = 0; i < 5; i++) await call(limiter, { action: 'peek', specs, now: NOW })
    expect(store.get('w:hour')).toEqual(before)
  })

  it('peek still reports the true usage', async () => {
    const { state } = fakeState()
    const limiter = new RateLimiterDO(state)
    await call(limiter, { action: 'consume', specs, now: NOW })
    const peeked = await call(limiter, { action: 'peek', specs, now: NOW })
    expect(peeked.usage.find(u => u.name === 'hour')!.count).toBe(1)
  })

  it('notifies exactly once per day, not once per refused report', async () => {
    const { state } = fakeState()
    const limiter = new RateLimiterDO(state)
    for (let i = 0; i < 2; i++) await call(limiter, { action: 'consume', specs, now: NOW })

    const notices: boolean[] = []
    for (let i = 0; i < 10; i++) {
      notices.push((await call(limiter, { action: 'consume', specs, notifyOnce: true, now: NOW })).notify)
    }
    expect(notices.filter(Boolean)).toHaveLength(1)
    expect(notices[0]).toBe(true)
  })

  it('re-arms the notice the next day', async () => {
    const { state } = fakeState()
    const limiter = new RateLimiterDO(state)
    for (let i = 0; i < 2; i++) await call(limiter, { action: 'consume', specs, now: NOW })
    expect((await call(limiter, { action: 'consume', specs, notifyOnce: true, now: NOW })).notify).toBe(true)

    const tomorrow = NOW + DAY_MS
    for (let i = 0; i < 2; i++) await call(limiter, { action: 'consume', specs, now: tomorrow })
    expect((await call(limiter, { action: 'consume', specs, notifyOnce: true, now: tomorrow })).notify).toBe(true)
  })

  it('never notifies for an accepted request', async () => {
    const { state } = fakeState()
    const limiter = new RateLimiterDO(state)
    expect((await call(limiter, { action: 'consume', specs, notifyOnce: true, now: NOW })).notify).toBe(false)
  })

  it('keeps storage O(1) no matter how much traffic passes through', async () => {
    const { state, store } = fakeState()
    const limiter = new RateLimiterDO(state)
    for (let i = 0; i < 50; i++) {
      await call(limiter, { action: 'consume', specs, notifyOnce: true, now: NOW + i * 1000 })
    }
    // Two window records plus the notice marker. Nothing accumulates per request.
    expect([...store.keys()].sort()).toEqual(['notified_day', 'w:day', 'w:hour'])
  })
})

describe('the limiter client fails open', () => {
  const brokenEnv = {
    RATE_LIMITER: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => { throw new Error('DO unreachable') } }),
    },
  } as unknown as Env

  it('allows the request and flags itself as degraded when the DO throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const decision = await consumeIp(brokenEnv, '1.2.3.4')
    expect(decision).toMatchObject({ allowed: true, degraded: true })
    // Failing open silently would mean serving unlimited traffic while
    // believing we were protected.
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('fails open for site caps and the dashboard peek too', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await consumeSite(brokenEnv, 'site_x', {})).toMatchObject({ allowed: true, degraded: true })
    expect(await peekSite(brokenEnv, 'site_x', {})).toMatchObject({ allowed: true, degraded: true, usage: [] })
    spy.mockRestore()
  })

  it('treats a non-200 from the DO as a failure rather than trusting the body', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = {
      RATE_LIMITER: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }),
      },
    } as unknown as Env
    expect(await consumeIp(env, '1.2.3.4')).toMatchObject({ allowed: true, degraded: true })
    spy.mockRestore()
  })

  it('passes the decision through unchanged when the DO answers', async () => {
    const env = {
      RATE_LIMITER: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async () => Response.json({
            allowed: false, blockedWindow: 'day', retryAfterSeconds: 42,
            usage: [{ name: 'day', count: 200, limit: 200, resetAt: 1 }], notify: true,
          }),
        }),
      },
    } as unknown as Env
    expect(await consumeSite(env, 'site_x', {})).toEqual({
      allowed: false, blockedWindow: 'day', retryAfterSeconds: 42,
      usage: [{ name: 'day', count: 200, limit: 200, resetAt: 1 }], notify: true, degraded: false,
    })
  })
})
