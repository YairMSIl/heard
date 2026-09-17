import { describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { buildRateLimitedPayload, buildWebhookPayload, deliverWebhook, signBody } from '../src/webhook'
import type { ReportRow } from '../src/types'

const report: ReportRow = {
  id: 'rep_1', site_id: 'site_1', type: 'idea', message: 'dark mode please',
  email: null, page_url: 'https://example.com/', user_agent: 'UA', viewport: '800x600',
  status: 'new', created_at: 1_700_000_000_000,
}

describe('buildWebhookPayload', () => {
  it('shapes a stable public payload with an ISO timestamp', () => {
    expect(buildWebhookPayload('Example', report)).toEqual({
      event: 'report.created',
      site: { id: 'site_1', name: 'Example' },
      report: {
        id: 'rep_1', type: 'idea', message: 'dark mode please', email: null,
        pageUrl: 'https://example.com/', userAgent: 'UA', viewport: '800x600',
        status: 'new', createdAt: '2023-11-14T22:13:20.000Z',
      },
    })
  })
})

describe('signBody', () => {
  it('matches an independent HMAC-SHA256 implementation', async () => {
    const body = JSON.stringify({ hello: 'world' })
    const expected = createHmac('sha256', 'whsec_test').update(body).digest('hex')
    expect(await signBody('whsec_test', body)).toBe(`sha256=${expected}`)
  })

  it('changes when either the body or the secret changes', async () => {
    const a = await signBody('whsec_a', 'body')
    expect(await signBody('whsec_a', 'body ')).not.toBe(a)
    expect(await signBody('whsec_b', 'body')).not.toBe(a)
  })
})

describe('deliverWebhook', () => {
  it('POSTs JSON to the configured url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    await deliverWebhook('https://hook.test/x', buildWebhookPayload('Example', report))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://hook.test/x')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body).report.id).toBe('rep_1')
    vi.unstubAllGlobals()
  })

  it('signs the exact bytes it sends', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    await deliverWebhook('https://hook.test/x', buildWebhookPayload('Example', report), 'whsec_test')
    const [, init] = fetchMock.mock.calls[0]

    // A receiver verifies over the raw body, so the signature must cover the
    // string we actually transmitted, not a re-serialised copy.
    const expected = createHmac('sha256', 'whsec_test').update(init.body).digest('hex')
    expect(init.headers['x-heard-signature']).toBe(`sha256=${expected}`)
    expect(init.headers['user-agent']).toBe('Heard/1.0')
    vi.unstubAllGlobals()
  })

  it('omits the signature header when the site has no secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    await deliverWebhook('https://hook.test/x', buildWebhookPayload('Example', report), null)
    expect(fetchMock.mock.calls[0][1].headers['x-heard-signature']).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('never rejects when the receiver fails — it reports false instead', async () => {
    // The caller counts consecutive failures, so the outcome must be visible;
    // it still must never throw into the visitor's request path.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(deliverWebhook('https://hook.test/x', buildWebhookPayload('E', report))).resolves.toBe(false)
    vi.unstubAllGlobals()
  })

  it('reports true only for a 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })))
    await expect(deliverWebhook('https://hook.test/x', buildWebhookPayload('E', report))).resolves.toBe(true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await expect(deliverWebhook('https://hook.test/x', buildWebhookPayload('E', report))).resolves.toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('rate-limited payload carries source shape (R1.3)', () => {
  const site = { id: 'site_1', name: 'Example' }
  const base = { window: 'hour', limit: 30, count: 30, resetAt: 1_700_000_000_000 }

  it('names a single source explicitly', () => {
    const p = buildRateLimitedPayload(site, { ...base, distinctSources: 1 })
    expect(p.limit.distinctSources).toBe(1)
    expect(p.message).toMatch(/single source address/)
  })

  it('reports a spread of sources', () => {
    const p = buildRateLimitedPayload(site, { ...base, distinctSources: 17 })
    expect(p.message).toMatch(/17 distinct source addresses/)
  })

  it('says nothing about sources when the count is unknown', () => {
    const p = buildRateLimitedPayload(site, base)
    expect(p.limit.distinctSources).toBe(0)
    expect(p.message).not.toMatch(/source address/)
  })
})
