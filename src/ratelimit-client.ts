import type { Env } from './types'
import { ipWindows, siteWindows, type SiteCaps, type WindowSpec, type WindowUsage } from './limits'
import type { ConsumeResponse } from './rate-limiter-do'

export interface LimitDecision {
  allowed: boolean
  retryAfterSeconds: number
  blockedWindow: string | null
  usage: WindowUsage[]
  notify: boolean
  /** True when the Durable Object could not be reached and we allowed anyway. */
  degraded: boolean
}

const ALLOW_ON_ERROR: LimitDecision = {
  allowed: true,
  retryAfterSeconds: 0,
  blockedWindow: null,
  usage: [],
  notify: false,
  degraded: true,
}

async function call(
  env: Env,
  key: string,
  specs: WindowSpec[],
  action: 'consume' | 'peek',
  notifyOnce = false,
): Promise<LimitDecision> {
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key))
    const res = await stub.fetch('https://rate-limiter/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, specs, notifyOnce }),
    })
    if (!res.ok) throw new Error(`rate limiter returned ${res.status}`)
    const body = (await res.json()) as ConsumeResponse
    return { ...body, degraded: false }
  } catch (err) {
    // Fail OPEN, loudly. A rate limiter that takes the site down when it breaks
    // is a worse outage than the abuse it prevents — but this must never be
    // silent, or we would serve unlimited traffic and believe we were protected.
    console.error('rate limiter unavailable', key, err instanceof Error ? err.message : err)
    return ALLOW_ON_ERROR
  }
}

export const consumeIp = (env: Env, ip: string) =>
  call(env, `ip:${ip}`, ipWindows(), 'consume')

export const consumeSite = (env: Env, siteId: string, caps: SiteCaps) =>
  call(env, `site:${siteId}`, siteWindows(caps), 'consume', true)

/** Read-only, for the dashboard: never moves a counter. */
export const peekSite = (env: Env, siteId: string, caps: SiteCaps) =>
  call(env, `site:${siteId}`, siteWindows(caps), 'peek')
