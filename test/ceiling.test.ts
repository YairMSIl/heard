import { describe, expect, it, vi } from 'vitest'
import {
  DEPLOYMENT_DAILY_CAP,
  DEPLOYMENT_HOURLY_CAP,
  DEPLOYMENT_PRESSURE,
  SITE_RESERVED_SHARE,
  shouldRefuseAtCeiling,
  type WindowUsage,
} from '../src/limits'
import {
  consumeDeployment,
  consumeSiteSource,
  deploymentCeilingRefusalCount,
  recordDeploymentCeilingRefusal,
} from '../src/ratelimit-client'
import type { Env } from '../src/types'

const HOUR_RESET = Date.now() + 600_000
const dep = (count: number, limit = DEPLOYMENT_HOURLY_CAP): WindowUsage =>
  ({ name: 'hour', count, limit, resetAt: HOUR_RESET })
const site = (count: number): WindowUsage => ({ name: 'hour', count, limit: 60, resetAt: HOUR_RESET })
const allowed = (usage: WindowUsage[]) => ({ allowed: true, retryAfterSeconds: 0, usage })

describe('shouldRefuseAtCeiling', () => {
  it('is invisible well below pressure, even to a heavy site', () => {
    const decision = shouldRefuseAtCeiling(allowed([dep(100)]), [site(500)])
    expect(decision).toMatchObject({ refuse: false, reason: null })
  })

  it('refuses everyone once the window is exhausted', () => {
    const exhausted = { allowed: false, retryAfterSeconds: 42, usage: [dep(DEPLOYMENT_HOURLY_CAP)] }
    // Even a site that has sent a single report is refused: there is no budget
    // left to allocate fairly.
    expect(shouldRefuseAtCeiling(exhausted, [site(1)]))
      .toMatchObject({ refuse: true, reason: 'exhausted', retryAfterSeconds: 42 })
  })

  it('under pressure, cuts the heavy tenant', () => {
    const pressure = Math.ceil(DEPLOYMENT_HOURLY_CAP * DEPLOYMENT_PRESSURE)
    const heavy = Math.floor(DEPLOYMENT_HOURLY_CAP * SITE_RESERVED_SHARE) + 1
    expect(shouldRefuseAtCeiling(allowed([dep(pressure)]), [site(heavy)]))
      .toMatchObject({ refuse: true, reason: 'heavy-tenant', window: 'hour' })
  })

  it('under pressure, keeps serving a light tenant', () => {
    // This is the whole point of S17: one loud site must not take the quiet
    // ones down with it.
    const pressure = Math.ceil(DEPLOYMENT_HOURLY_CAP * DEPLOYMENT_PRESSURE)
    const light = Math.floor(DEPLOYMENT_HOURLY_CAP * SITE_RESERVED_SHARE)
    expect(shouldRefuseAtCeiling(allowed([dep(pressure)]), [site(light)]))
      .toMatchObject({ refuse: false })
  })

  it('treats exactly 10% as light and one above as heavy', () => {
    const pressure = Math.ceil(DEPLOYMENT_HOURLY_CAP * DEPLOYMENT_PRESSURE)
    const tenPercent = DEPLOYMENT_HOURLY_CAP * SITE_RESERVED_SHARE
    expect(shouldRefuseAtCeiling(allowed([dep(pressure)]), [site(tenPercent)]).refuse).toBe(false)
    expect(shouldRefuseAtCeiling(allowed([dep(pressure)]), [site(tenPercent + 1)]).refuse).toBe(true)
  })

  it('applies pressure per window, so a busy day does not punish a quiet hour', () => {
    const dayPressure = Math.ceil(DEPLOYMENT_DAILY_CAP * DEPLOYMENT_PRESSURE)
    const deployment = allowed([
      dep(10),
      { name: 'day', count: dayPressure, limit: DEPLOYMENT_DAILY_CAP, resetAt: HOUR_RESET },
    ])
    const siteUsage: WindowUsage[] = [
      site(5),
      { name: 'day', count: DEPLOYMENT_DAILY_CAP * SITE_RESERVED_SHARE + 1, limit: 500, resetAt: HOUR_RESET },
    ]
    expect(shouldRefuseAtCeiling(deployment, siteUsage))
      .toMatchObject({ refuse: true, reason: 'heavy-tenant', window: 'day' })
  })

  it('allows when the limiter is degraded and reports no usage', () => {
    // No usage means we could not measure, which must read as "no pressure"
    // rather than "refuse", consistent with failing open elsewhere.
    expect(shouldRefuseAtCeiling(allowed([]), [])).toMatchObject({ refuse: false })
  })

  it('never returns a retry-after below one second when refusing', () => {
    const pressure = Math.ceil(DEPLOYMENT_HOURLY_CAP * DEPLOYMENT_PRESSURE)
    const heavy = DEPLOYMENT_HOURLY_CAP * SITE_RESERVED_SHARE + 1
    const past = { name: 'hour' as const, count: pressure, limit: DEPLOYMENT_HOURLY_CAP, resetAt: Date.now() - 1000 }
    const d = shouldRefuseAtCeiling(allowed([past]), [site(heavy)])
    expect(d.refuse).toBe(true)
    expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })
})

describe('S17 ordering: an upstream refusal must not spend global budget', () => {
  /** Records which limiter keys were consumed, in order. */
  function trackingEnv(denyKey?: string) {
    const consumed: string[] = []
    const env = {
      RATE_LIMITER: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          fetch: async (_u: string, init: { body: string }) => {
            consumed.push(name)
            const denied = denyKey !== undefined && name.includes(denyKey)
            void init
            return Response.json({
              allowed: !denied,
              blockedWindow: denied ? 'hour' : null,
              retryAfterSeconds: denied ? 30 : 0,
              usage: [{ name: 'hour', count: denied ? 60 : 1, limit: 60, resetAt: HOUR_RESET }],
              notify: false,
              distinctSources: 1,
            })
          },
        }),
      },
    } as unknown as Env
    return { env, consumed }
  }

  it('the source share and the deployment ceiling are separate instances', async () => {
    const { env, consumed } = trackingEnv()
    await consumeSiteSource(env, 'site_1', { hourly_cap: 60, daily_cap: 500 }, '1.2.3.4')
    await consumeDeployment(env)
    expect(consumed[0]).toContain('site_1|net:')
    expect(consumed[1]).toBe('deployment:all')
  })

  it('a source-share refusal leaves the deployment instance untouched', async () => {
    // The route returns before consumeDeployment, so the global counter is
    // never reached — this asserts the *absence* of the call that caused S17.
    const { env, consumed } = trackingEnv('net:')
    const decision = await consumeSiteSource(env, 'site_1', { hourly_cap: 60, daily_cap: 500 }, '1.2.3.4')
    expect(decision.allowed).toBe(false)
    expect(consumed).not.toContain('deployment:all')
    expect(consumed).toHaveLength(1)
  })
})

describe('deploymentCeilingRefusals counter', () => {
  it('counts only explicit refusals', () => {
    const before = deploymentCeilingRefusalCount()
    recordDeploymentCeilingRefusal()
    recordDeploymentCeilingRefusal()
    expect(deploymentCeilingRefusalCount()).toBe(before + 2)
  })

  it('is distinct from the degraded counters in meaning', async () => {
    // "we checked and said no" vs "we could not check" — a reader must not have
    // to guess which one a number represents.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = {
      RATE_LIMITER: { idFromName: () => ({}), get: () => ({ fetch: async () => { throw new Error('down') } }) },
    } as unknown as Env
    const before = deploymentCeilingRefusalCount()
    const decision = await consumeDeployment(broken)
    expect(decision).toMatchObject({ allowed: true, degraded: true })
    expect(deploymentCeilingRefusalCount()).toBe(before)
    spy.mockRestore()
  })
})
