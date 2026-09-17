import type { Env, SiteRow } from './types'
import { HOUR_MS } from './limits'
import {
  MAX_CONSECUTIVE_FAILURES,
  WEBHOOK_DELIVERIES_PER_HOUR,
  deliverWebhook,
  verifyWebhookTarget,
} from './webhook'
import { resolvesToPublicAddress } from './dns'
import { randomId } from './ids'
import { recordWebhookDeliveryDegraded } from './ratelimit-client'
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
    // Fail open on the cap, consistent with the request limiter — and counted,
    // so /health can show that outbound deliveries are currently uncapped.
    recordWebhookDeliveryDegraded()
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

/** Re-verification interval for a stored webhook. */
export const RECHECK_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export interface RecheckResult {
  checked: number
  disabled: number
}

/**
 * Re-resolves and re-challenges every verified webhook once a week.
 *
 * A webhook verified in January is a claim about January. DNS rebinding, an
 * expired domain and an endpoint that quietly changed hands all look identical
 * to a stored URL that nobody has asked again — this is what turns the one-time
 * consent into a standing one.
 */
export async function recheckWebhooks(env: Env, now: number = Date.now()): Promise<RecheckResult> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, webhook_url, webhook_secret FROM sites
     WHERE webhook_url IS NOT NULL AND webhook_disabled_at IS NULL
       AND (webhook_verified_at IS NULL OR webhook_verified_at < ?)`,
  ).bind(now - RECHECK_AFTER_MS).all<{ id: string; name: string; webhook_url: string; webhook_secret: string | null }>()

  let disabled = 0
  for (const site of results ?? []) {
    const resolved = await resolvesToPublicAddress(new URL(site.webhook_url).hostname)
    const verified = resolved.ok
      ? await verifyWebhookTarget(site.webhook_url, randomId(24), site.webhook_secret)
      : { ok: false as const, error: resolved.error }

    if (verified.ok) {
      await env.DB.prepare('UPDATE sites SET webhook_verified_at = ?, webhook_failures = 0 WHERE id = ?')
        .bind(now, site.id).run()
    } else {
      disabled += 1
      await env.DB.prepare('UPDATE sites SET webhook_disabled_at = ? WHERE id = ?').bind(now, site.id).run()
      console.error('webhook disabled at recheck', site.id, verified.error)
    }
  }
  return { checked: (results ?? []).length, disabled }
}
