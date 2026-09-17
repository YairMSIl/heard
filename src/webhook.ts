import type { ReportRow } from './types'

const TIMEOUT_MS = 5000
/** Consecutive failures before a webhook is switched off. */
export const MAX_CONSECUTIVE_FAILURES = 10
/** Deliveries per site per hour: reflection needs volume, so remove the volume. */
export const WEBHOOK_DELIVERIES_PER_HOUR = 60

export interface RateLimitedPayload {
  event: 'report.rate_limited'
  site: { id: string; name: string }
  limit: { window: string; limit: number; count: number; resetAt: string }
  message: string
}

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

/**
 * Sent at most once per day, on the first submission a site's cap refuses.
 * Owners need to know reports are being dropped; they do not need one delivery
 * per dropped report, which would turn a rate limit into its own flood.
 */
export function buildRateLimitedPayload(
  site: { id: string; name: string },
  limit: { window: string; limit: number; count: number; resetAt: number },
): RateLimitedPayload {
  return {
    event: 'report.rate_limited',
    site: { id: site.id, name: site.name },
    limit: { ...limit, resetAt: new Date(limit.resetAt).toISOString() },
    message: `Heard is refusing new reports for "${site.name}": the ${limit.window} cap of ${limit.limit} was reached. Submissions resume after the window resets. You will not get another notice today.`,
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
/**
 * Asks the destination to prove it wants our deliveries by echoing a one-time
 * challenge. This is the control that actually kills reflection: consent comes
 * from the endpoint rather than from whoever typed the URL.
 */
export async function verifyWebhookTarget(
  url: string,
  challenge: string,
  secret?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const body = JSON.stringify({ event: 'webhook.challenge', challenge })
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Heard/1.0' }
  if (secret) headers['x-heard-signature'] = await signBody(secret, body)

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: abort.signal })
    if (!res.ok) return { ok: false, error: `the endpoint answered ${res.status}` }
    const text = (await res.text()).trim()
    if (!text.includes(challenge)) {
      return { ok: false, error: 'the endpoint did not echo the challenge value back' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'the endpoint could not be reached' }
  } finally {
    clearTimeout(timer)
  }
}

export async function deliverWebhook(
  url: string,
  payload: WebhookPayload | RateLimitedPayload,
  secret?: string | null,
): Promise<boolean> {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'Heard/1.0',
  }
  if (secret) headers['x-heard-signature'] = await signBody(secret, body)

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: abort.signal })
    // Reported, never thrown: the caller uses this to count consecutive
    // failures, but a broken endpoint still must not fail the visitor's request.
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
