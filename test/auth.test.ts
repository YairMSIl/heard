import { describe, expect, it, vi } from 'vitest'
import {
  createSession,
  exchangeCodeForToken,
  fetchGithubUser,
  githubAuthorizeUrl,
  timingSafeEqual,
  verifySession,
} from '../src/auth'

const SECRET = 'session-secret-for-tests'
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

describe('timingSafeEqual', () => {
  it('compares equal-length strings by content', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
  })
  it('is false for different lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('', 'a')).toBe(false)
  })
})

describe('sessions', () => {
  it('round-trips the owner id', async () => {
    const cookie = await createSession(SECRET, 'own_abc', NOW)
    expect(await verifySession(SECRET, cookie, NOW + 1000)).toBe('own_abc')
  })

  it('does not put anything secret in the cookie', async () => {
    const cookie = await createSession(SECRET, 'own_abc', NOW)
    expect(cookie).not.toContain(SECRET)
    expect(cookie.startsWith('own_abc.')).toBe(true)
  })

  it('rejects a tampered owner id', async () => {
    const cookie = await createSession(SECRET, 'own_abc', NOW)
    const forged = cookie.replace('own_abc', 'own_xyz')
    expect(await verifySession(SECRET, forged, NOW)).toBeNull()
  })

  it('rejects a tampered signature', async () => {
    const cookie = await createSession(SECRET, 'own_abc', NOW)
    const parts = cookie.split('.')
    parts[2] = parts[2].replace(/^./, ch => (ch === 'a' ? 'b' : 'a'))
    expect(await verifySession(SECRET, parts.join('.'), NOW)).toBeNull()
  })

  it('rejects a session signed with another secret', async () => {
    const cookie = await createSession('other-secret', 'own_abc', NOW)
    expect(await verifySession(SECRET, cookie, NOW)).toBeNull()
  })

  it('expires after 30 days', async () => {
    const cookie = await createSession(SECRET, 'own_abc', NOW)
    expect(await verifySession(SECRET, cookie, NOW + 30 * DAY - 1000)).toBe('own_abc')
    expect(await verifySession(SECRET, cookie, NOW + 30 * DAY + 1000)).toBeNull()
  })

  it('rejects a session issued in the future', async () => {
    const cookie = await createSession(SECRET, 'own_abc', NOW + 10 * DAY)
    expect(await verifySession(SECRET, cookie, NOW)).toBeNull()
  })

  it('rejects malformed and missing cookies', async () => {
    for (const bad of [undefined, '', 'nonsense', 'a.b', 'a.b.c.d']) {
      expect(await verifySession(SECRET, bad, NOW)).toBeNull()
    }
  })
})

describe('githubAuthorizeUrl', () => {
  it('asks only for the public profile and carries the state', () => {
    const url = new URL(githubAuthorizeUrl('client123', 'https://h.test/auth/github/callback', 'st8'))
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('client123')
    expect(url.searchParams.get('redirect_uri')).toBe('https://h.test/auth/github/callback')
    expect(url.searchParams.get('scope')).toBe('read:user')
    expect(url.searchParams.get('state')).toBe('st8')
  })
})

describe('exchangeCodeForToken', () => {
  it('returns the access token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'gho_x' }), { status: 200 })))
    await expect(exchangeCodeForToken('id', 'secret', 'code', 'https://h.test/cb')).resolves.toBe('gho_x')
    vi.unstubAllGlobals()
  })

  it('throws with GitHub\'s own message when the exchange fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad_verification_code', error_description: 'The code expired.' }),
        { status: 200 })))
    await expect(exchangeCodeForToken('id', 'secret', 'code', 'https://h.test/cb'))
      .rejects.toThrow('The code expired.')
    vi.unstubAllGlobals()
  })

  it('never leaks the client secret into the thrown error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })))
    await expect(exchangeCodeForToken('id', 'topsecret', 'code', 'https://h.test/cb'))
      .rejects.toThrow(/^(?!.*topsecret).*$/)
    vi.unstubAllGlobals()
  })
})

describe('fetchGithubUser', () => {
  it('returns id and login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 42, login: 'octocat', name: 'Mona' }), { status: 200 })))
    await expect(fetchGithubUser('gho_x')).resolves.toEqual({ id: 42, login: 'octocat' })
    vi.unstubAllGlobals()
  })

  it('rejects an unexpected profile shape rather than inventing an owner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ login: 'octocat' }), { status: 200 })))
    await expect(fetchGithubUser('gho_x')).rejects.toThrow(/unexpected GitHub profile/)
    vi.unstubAllGlobals()
  })

  it('surfaces an HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })))
    await expect(fetchGithubUser('bad')).rejects.toThrow(/401/)
    vi.unstubAllGlobals()
  })
})

describe('timingSafeEqual does not leak length', () => {
  it('still compares content correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
  })

  it('returns false for different lengths without an early return', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('', 'a')).toBe(false)
    expect(timingSafeEqual('a'.repeat(64), 'a'.repeat(63))).toBe(false)
  })

  it('handles empty strings on both sides', () => {
    expect(timingSafeEqual('', '')).toBe(true)
  })

  it('does not report a prefix as equal', () => {
    const token = 'f'.repeat(64)
    expect(timingSafeEqual(token.slice(0, 32), token)).toBe(false)
    expect(timingSafeEqual(token, token.slice(0, 32))).toBe(false)
  })

  it('compares long tokens correctly in both directions', () => {
    const a = 'a'.repeat(200), b = 'a'.repeat(200)
    expect(timingSafeEqual(a, b)).toBe(true)
    expect(timingSafeEqual(a, b.slice(0, 199) + 'b')).toBe(false)
  })
})

describe('timingSafeEqual regression: tails must be compared', () => {
  it('detects a difference beyond the minimum compare width', () => {
    // Regression for a real bug: wrapping the index modulo each length meant
    // characters past index 127 were never examined, so these compared equal.
    for (const len of [129, 200, 512]) {
      const a = 'a'.repeat(len)
      expect(timingSafeEqual(a, a.slice(0, len - 1) + 'b')).toBe(false)
      expect(timingSafeEqual(a, a)).toBe(true)
    }
  })

  it('detects a difference in the very last character of a long token', () => {
    const a = 'x'.repeat(300)
    expect(timingSafeEqual(a, 'x'.repeat(299) + 'y')).toBe(false)
  })
})
