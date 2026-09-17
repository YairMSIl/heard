import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/ratelimit'

describe('RateLimiter', () => {
  it('allows up to the limit inside one window', () => {
    const rl = new RateLimiter(3, 1000)
    const now = 1_000_000
    expect(rl.check('ip', now).allowed).toBe(true)
    expect(rl.check('ip', now + 10).allowed).toBe(true)
    expect(rl.check('ip', now + 20).allowed).toBe(true)
    expect(rl.check('ip', now + 30).allowed).toBe(false)
  })

  it('reports remaining budget', () => {
    const rl = new RateLimiter(2, 1000)
    expect(rl.check('ip', 0).remaining).toBe(1)
    expect(rl.check('ip', 1).remaining).toBe(0)
  })

  it('returns a retry-after of at least one second when blocked', () => {
    const rl = new RateLimiter(1, 60_000)
    rl.check('ip', 0)
    const blocked = rl.check('ip', 100)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBe(60)
    expect(rl.check('ip', 59_999).retryAfterSeconds).toBe(1)
  })

  it('resets once the window rolls over', () => {
    const rl = new RateLimiter(1, 1000)
    expect(rl.check('ip', 0).allowed).toBe(true)
    expect(rl.check('ip', 999).allowed).toBe(false)
    expect(rl.check('ip', 1000).allowed).toBe(true)
  })

  it('keeps keys independent', () => {
    const rl = new RateLimiter(1, 1000)
    expect(rl.check('a', 0).allowed).toBe(true)
    expect(rl.check('b', 0).allowed).toBe(true)
    expect(rl.check('a', 0).allowed).toBe(false)
  })

  it('sweeps expired buckets so memory does not grow without bound', () => {
    const rl = new RateLimiter(5, 1000)
    for (let i = 0; i < 1200; i++) rl.check('ip' + i, 0)
    expect(rl.size).toBe(1200)
    rl.check('fresh', 5000)
    expect(rl.size).toBeLessThan(10)
  })
})
