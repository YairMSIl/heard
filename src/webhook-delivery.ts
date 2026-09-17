import type { Env, SiteRow } from './types'
import { HOUR_MS } from './limits'
import { MAX_CONSECUTIVE_FAILURES, WEBHOOK_DELIVERIES_PER_HOUR, deliverWebhook } from './webhook'
import type { RateLimitedPayload, WebhookPayload } from './webhook'

/**
 * One place that decides whether a delivery happens and what its outcome means.
 *
 * Three guards, each closing a different hole: a disabled webhook is not
 * retried, an hourly cap removes the volume reflection needs, and a run of
 * consecutive failures switches the webhook off so a dead endpoint stops being a
 * standing outbound request generator.
 */
export async function deliverAndRecord(
  env: Env,
  site: Pick<SiteRow, 'id' | 'webhook_url' | 'webhook_secret' | 'webhook_disabled_at'>,
  payload: WebhookPayload | RateLimitedPayload,
): Promise<void> {
  if (!site.webhook_url || site.webhook_disabled_at) return

  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`webhook:${site.id}`))
  try {
    const res = await stub.fetch('https://rate-limiter/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'consume',
        specs: [{ name: 'hour', ms: HOUR_MS, limit: WEBHOOK_DELIVERIES_PER_HOUR }],
      }),
    })
    if (res.ok && !((await res.json()) as { allowed: boolean }).allowed) {
      console.error('webhook delivery cap reached', site.id)
      return
    }
  } catch (err) {
    // Fail open on the cap, consistent with the request limiter.
    console.error('webhook delivery cap check failed', site.id, err instanceof Error ? err.message : err)
  }

  const ok = await deliverWebhook(site.webhook_url, payload, site.webhook_secret)

  if (ok) {
    await env.DB.prepare('UPDATE sites SET webhook_failures = 0 WHERE id = ?').bind(site.id).run()
    return
  }

  const row = await env.DB.prepare(
    'UPDATE sites SET webhook_failures = webhook_failures + 1 WHERE id = ? RETURNING webhook_failures',
  ).bind(site.id).first<{ webhook_failures: number }>()

  if ((row?.webhook_failures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
    await env.DB.prepare('UPDATE sites SET webhook_disabled_at = ? WHERE id = ? AND webhook_disabled_at IS NULL')
      .bind(Date.now(), site.id).run()
    console.error('webhook disabled after consecutive failures', site.id)
  }
}
