import { describe, expect, it, vi } from 'vitest'
import { resolvesToPublicAddress } from '../src/dns'
import { RECHECK_AFTER_MS } from '../src/webhook-delivery'

/** Fresh Response per call: a body can only be read once, and we make two lookups. */
const answers = (data: string, type = 1) =>
  vi.fn().mockImplementation(() => new Response(JSON.stringify({ Answer: [{ type, data }] })))
const answer = (data: string, type = 1) => new Response(JSON.stringify({ Answer: [{ type, data }] }))

describe('resolvesToPublicAddress', () => {
  it('accepts a name resolving to a public address', async () => {
    vi.stubGlobal('fetch', answers('203.0.113.9'))
    await expect(resolvesToPublicAddress('example.com')).resolves.toEqual({ ok: true })
    vi.unstubAllGlobals()
  })

  it('refuses the nip.io-style bypass that beat the textual guard', async () => {
    // `127.0.0.1.nip.io` looks like an ordinary hostname and resolves to loopback.
    vi.stubGlobal('fetch', answers('127.0.0.1'))
    await expect(resolvesToPublicAddress('127.0.0.1.nip.io'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('private address') })
    vi.unstubAllGlobals()
  })

  it.each([
    ['metadata', '169.254.169.254'],
    ['rfc1918', '10.0.0.1'],
    ['CGNAT', '100.100.1.1'],
  ])('refuses a name resolving to %s', async (_l, addr) => {
    vi.stubGlobal('fetch', answers(addr))
    await expect(resolvesToPublicAddress('sneaky.example')).resolves.toMatchObject({ ok: false })
    vi.unstubAllGlobals()
  })

  it('refuses an IPv6 ULA answer', async () => {
    vi.stubGlobal('fetch', answers('fd00::1', 28))
    await expect(resolvesToPublicAddress('sneaky.example')).resolves.toMatchObject({ ok: false })
    vi.unstubAllGlobals()
  })

  it('refuses when a name has one public and one private answer', async () => {
    // Splitting answers must not launder the private one.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(answer('203.0.113.9'))
      .mockResolvedValueOnce(answer('fd00::1', 28))
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolvesToPublicAddress('mixed.example')).resolves.toMatchObject({ ok: false })
    vi.unstubAllGlobals()
  })

  it('refuses a name with no address records rather than assuming public', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response(JSON.stringify({}))))
    await expect(resolvesToPublicAddress('void.example'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('does not resolve') })
    vi.unstubAllGlobals()
  })

  it('refuses when the resolver itself fails — never fails open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(resolvesToPublicAddress('example.com')).resolves.toMatchObject({ ok: false })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response('nope', { status: 500 })))
    await expect(resolvesToPublicAddress('example.com')).resolves.toMatchObject({ ok: false })
    vi.unstubAllGlobals()
  })

  it('skips resolution for a literal address, which the textual guard already judged', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolvesToPublicAddress('203.0.113.9')).resolves.toEqual({ ok: true })
    await expect(resolvesToPublicAddress('2001:db8::1')).resolves.toEqual({ ok: true })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('webhook re-verification', () => {
  it('re-challenges weekly, so consent does not become permanent', () => {
    expect(RECHECK_AFTER_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})
