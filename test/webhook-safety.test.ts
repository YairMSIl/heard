import { describe, expect, it, vi } from 'vitest'
import { validateWebhookUrl } from '../src/validation'
import { MAX_CONSECUTIVE_FAILURES, verifyWebhookTarget } from '../src/webhook'

describe('validateWebhookUrl blocks SSRF targets', () => {
  it.each([
    ['loopback v4', 'http://127.0.0.1/hook'],
    ['loopback name', 'http://localhost:9000/hook'],
    ['localhost suffix', 'http://api.localhost/hook'],
    ['mdns .local', 'http://printer.local/hook'],
    ['all-zeros', 'http://0.0.0.0/hook'],
    ['rfc1918 10/8', 'http://10.1.2.3/hook'],
    ['rfc1918 192.168', 'http://192.168.1.1/hook'],
    ['rfc1918 172.16', 'http://172.16.0.5/hook'],
    ['rfc1918 172.31', 'http://172.31.255.254/hook'],
    ['link-local / metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['CGNAT', 'http://100.100.0.1/hook'],
    ['IPv6 loopback', 'http://[::1]/hook'],
    ['IPv6 ULA', 'http://[fd00::1]/hook'],
    ['IPv6 link-local', 'http://[fe80::1]/hook'],
  ])('refuses %s', (_label, url) => {
    expect(validateWebhookUrl(url)).toMatchObject({ ok: false })
  })

  it('still allows ordinary public endpoints', () => {
    for (const url of ['https://example.com/hook', 'http://203.0.113.7/hook', 'https://hooks.slack.com/x']) {
      expect(validateWebhookUrl(url)).toMatchObject({ ok: true })
    }
  })

  it('does not mistake a public address for a private one', () => {
    // 172.32 and 100.63 sit just outside the private ranges.
    expect(validateWebhookUrl('http://172.32.0.1/hook')).toMatchObject({ ok: true })
    expect(validateWebhookUrl('http://100.63.0.1/hook')).toMatchObject({ ok: true })
    expect(validateWebhookUrl('http://11.0.0.1/hook')).toMatchObject({ ok: true })
  })

  it('refuses a webhook pointing back at Heard', () => {
    const self = 'https://heard.yairms.workers.dev'
    expect(validateWebhookUrl(`${self}/api/report`, self)).toMatchObject({ ok: false })
    expect(validateWebhookUrl('https://elsewhere.example/hook', self)).toMatchObject({ ok: true })
  })
})

describe('verifyWebhookTarget', () => {
  const challenge = 'chal_abc123'

  it('accepts an endpoint that echoes the challenge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`{"challenge":"${challenge}"}`, { status: 200 })))
    await expect(verifyWebhookTarget('https://e.test/hook', challenge)).resolves.toEqual({ ok: true })
    vi.unstubAllGlobals()
  })

  it('refuses an endpoint that answers 200 without the challenge', async () => {
    // Consent has to be proof of receipt, not merely of being online — a random
    // URL that 200s everything must not become a delivery target.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('OK', { status: 200 })))
    await expect(verifyWebhookTarget('https://e.test/hook', challenge))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('echo') })
    vi.unstubAllGlobals()
  })

  it('refuses a non-2xx endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(challenge, { status: 404 })))
    await expect(verifyWebhookTarget('https://e.test/hook', challenge)).resolves.toMatchObject({ ok: false })
    vi.unstubAllGlobals()
  })

  it('refuses an unreachable endpoint without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(verifyWebhookTarget('https://e.test/hook', challenge)).resolves.toMatchObject({ ok: false })
    vi.unstubAllGlobals()
  })

  it('signs the challenge when the site has a secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(challenge, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await verifyWebhookTarget('https://e.test/hook', challenge, 'whsec_x')
    expect(fetchMock.mock.calls[0][1].headers['x-heard-signature']).toMatch(/^sha256=/)
    vi.unstubAllGlobals()
  })
})

describe('failure policy', () => {
  it('disables after ten consecutive failures', () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(10)
  })
})
