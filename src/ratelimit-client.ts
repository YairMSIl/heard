import type { Env } from './types'
import {
  deploymentWindows,
  hashSource,
  ipWindows,
  sourceBucket,
  siteWindows,
  sourceShareWindows,
  type SiteCaps,
  type WindowSpec,
  type WindowUsage,
} from './limits'
import type { ConsumeResponse } from './rate-limiter-do'

export interface LimitDecision {
  allowed: boolean
  retryAfterSeconds: number
  blockedWindow: string | null
  usage: WindowUsage[]
  notify: boolean
  distinctSources: number
  /** True when the Durable Object could not be reached and we allowed anyway. */
  degraded: boolean
}

const ALLOW_ON_ERROR: LimitDecision = {
  allowed: true,
  retryAfterSeconds: 0,
  blockedWindow: null,
  usage: [],
  notify: false,
  distinctSources: 0,
  degraded: true,
}

/**
 * Fail-open decisions since this isolate started. Exposed on /health so an
 * attacker cannot quietly overload the limiter into permissiveness: if this
 * number moves, the limits are not being enforced and somebody should know.
 */
let degradedCount = 0
export const rateLimitDegradedCount = () => degradedCount

/**
 * The webhook delivery cap fails open through its own catch. It is counted
 * separately rather than folded in, because "requests are unlimited right now"
 * and "outbound deliveries are unlimited right now" are different incidents.
 */
let webhookDegradedCount = 0
export const webhookDeliveryDegradedCount = () => webhookDegradedCount
export const recordWebhookDeliveryDegraded = () => { webhookDegradedCount += 1 }

async function call(
  env: Env,
  key: string,
  specs: WindowSpec[],
  action: 'consume' | 'peek',
  notifyOnce = false,
  source?: string,
): Promise<LimitDecision> {
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key))
    const res = await stub.fetch('https://rate-limiter/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, specs, notifyOnce, source }),
    })
    if (!res.ok) throw new Error(`rate limiter returned ${res.status}`)
    const body = (await res.json()) as ConsumeResponse
    return { ...body, degraded: false }
  } catch (err) {
    // Fail OPEN, loudly. A rate limiter that takes the site down when it breaks
    // is a worse outage than the abuse it prevents — but this must never be
    // silent, or we would serve unlimited traffic and believe we were protected.
    degradedCount += 1
    console.error('rate limiter unavailable', key, 'degraded_total=' + degradedCount,
      err instanceof Error ? err.message : err)
    return ALLOW_ON_ERROR
  }
}

export const consumeIp = (env: Env, ip: string) =>
  call(env, `ip:${ip}`, ipWindows(), 'consume')

/**
 * `notifyOnce` is spent only when there is somewhere to deliver the notice.
 * Otherwise the first refusal of the day would burn the once-per-day marker on a
 * site with no webhook, and a later refusal — after an owner configures one —
 * would be silent until tomorrow.
 */
export const consumeSite = (env: Env, siteId: string, caps: SiteCaps, hasWebhook: boolean, ip: string) =>
  call(env, `site:${siteId}`, siteWindows(caps), 'consume', hasWebhook, hashSource(sourceBucket(ip)))

/**
 * One source network's share of a site, so a single connection cannot starve the
 * rest. Returns "allowed" unchanged when the site's cap is too small for a share
 * to make sense — `sourceShareWindows` gives an empty list and an empty window
 * set always passes.
 */
export const consumeSiteSource = (env: Env, siteId: string, caps: SiteCaps, ip: string) => {
  const windows = sourceShareWindows(caps)
  if (windows.length === 0) return Promise.resolve({ ...ALLOW_ON_ERROR, degraded: false })
  return call(env, `site:${siteId}|net:${hashSource(sourceBucket(ip))}`, windows, 'consume')
}

export const consumeDeployment = (env: Env) =>
  call(env, 'deployment:all', deploymentWindows(), 'consume')

/** Read-only, for the dashboard: never moves a counter. */
export const peekSite = (env: Env, siteId: string, caps: SiteCaps) =>
  call(env, `site:${siteId}`, siteWindows(caps), 'peek')
