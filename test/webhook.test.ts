import { describe, expect, it, vi } from 'vitest'
import { buildWebhookPayload, deliverWebhook } from '../src/webhook'
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

  it('never rejects when the receiver fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(deliverWebhook('https://hook.test/x', buildWebhookPayload('E', report))).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })
})
