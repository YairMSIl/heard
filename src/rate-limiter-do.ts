import { DAY_MS, evaluateWindows, type Bucket, type Evaluation, type WindowSpec } from './limits'

export interface ConsumeRequest {
  action: 'consume' | 'peek'
  specs: WindowSpec[]
  /** Only meaningful for `consume`; asks for a once-per-day notice on refusal. */
  notifyOnce?: boolean
  now?: number
}

export interface ConsumeResponse extends Omit<Evaluation, 'next'> {
  /** True on the first refusal of the day, so an owner is told once, not once per drop. */
  notify: boolean
}

const NOTIFIED_KEY = 'notified_day'

/**
 * One instance per key: `ip:<addr>` for the per-IP window, `site:<id>` for a
 * site's hourly and daily caps. Durable Objects serialise requests to the same
 * instance, which is exactly the property the in-memory limiter could not give
 * us — that one counted per isolate, so the real limit was "10 per minute times
 * however many isolates Cloudflare happened to spin up".
 *
 * Storage is O(1): one record per window holding the current bucket id and its
 * count, overwritten when the bucket rolls over. Nothing accumulates, so no
 * cleanup alarm is needed.
 */
export class RateLimiterDO implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as ConsumeRequest
    const now = body.now ?? Date.now()
    const names = body.specs.map(s => s.name)

    const stored: Record<string, Bucket | undefined> = {}
    for (const name of names) {
      stored[name] = await this.state.storage.get<Bucket>(`w:${name}`)
    }

    const result = evaluateWindows(body.specs, stored, now, body.action)

    let notify = false
    if (body.action === 'consume') {
      if (result.allowed) {
        for (const [name, bucket] of Object.entries(result.next)) {
          await this.state.storage.put(`w:${name}`, bucket)
        }
      } else if (body.notifyOnce) {
        // The day bucket is the natural "once per day" key: it rolls over on
        // its own, so there is nothing to reset or clean up.
        const today = Math.floor(now / DAY_MS)
        const lastNotified = await this.state.storage.get<number>(NOTIFIED_KEY)
        if (lastNotified !== today) {
          await this.state.storage.put(NOTIFIED_KEY, today)
          notify = true
        }
      }
    }

    const response: ConsumeResponse = {
      allowed: result.allowed,
      blockedWindow: result.blockedWindow,
      retryAfterSeconds: result.retryAfterSeconds,
      usage: result.usage,
      notify,
    }
    return Response.json(response)
  }
}
