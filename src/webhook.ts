import type { ReportRow } from './types'

const TIMEOUT_MS = 5000

export interface WebhookPayload {
  event: 'report.created'
  site: { id: string; name: string }
  report: {
    id: string
    type: string
    message: string
    email: string | null
    pageUrl: string | null
    userAgent: string | null
    viewport: string | null
    status: string
    createdAt: string
  }
}

export function buildWebhookPayload(siteName: string, report: ReportRow): WebhookPayload {
  return {
    event: 'report.created',
    site: { id: report.site_id, name: siteName },
    report: {
      id: report.id,
      type: report.type,
      message: report.message,
      email: report.email,
      pageUrl: report.page_url,
      userAgent: report.user_agent,
      viewport: report.viewport,
      status: report.status,
      createdAt: new Date(report.created_at).toISOString(),
    },
  }
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * HMAC-SHA256 over the exact bytes we send, so a receiver can verify without
 * guessing at our JSON formatting. Returned in the `sha256=<hex>` shape GitHub
 * popularised — receivers already have code for it.
 */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return `sha256=${toHex(sig)}`
}

/**
 * Fire-and-forget delivery. Always resolves: a site owner's broken endpoint
 * must never turn a visitor's successful submission into an error, and the
 * report is already committed by the time this runs. Handed to
 * ctx.waitUntil() so the isolate stays alive for it without blocking the
 * response. No retries in the MVP — add a queue if delivery matters.
 */
export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  secret?: string | null,
): Promise<void> {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'Heard/1.0',
  }
  if (secret) headers['x-heard-signature'] = await signBody(secret, body)

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    await fetch(url, { method: 'POST', headers, body, signal: abort.signal })
  } catch {
    // Swallowed on purpose; see doc comment.
  } finally {
    clearTimeout(timer)
  }
}
