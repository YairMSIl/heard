import {
  DAY_MS,
  MAX_TRACKED_SOURCES,
  clampSpecs,
  evaluateWindows,
  type Bucket,
  type Evaluation,
  type WindowSpec,
} from './limits'

export interface ConsumeRequest {
  action: 'consume' | 'peek'
  specs: WindowSpec[]
  /** Only meaningful for `consume`; asks for a once-per-day notice on refusal. */
  notifyOnce?: boolean
  /** Hashed source key, counted so a refusal can say how many sources were involved. */
  source?: string
  /** Test-only clock override. Production callers never send this. */
  now?: number
}

export interface ConsumeResponse extends Omit<Evaluation, 'next'> {
  /** True on the first refusal of the day, so an owner is told once, not once per drop. */
  notify: boolean
  /** Distinct sources seen in the longest window this instance tracks. */
  distinctSources: number
}

const NOTIFIED_KEY = 'notified_day'
const SOURCES_KEY = 'sources'

interface SourceRecord {
  bucket: number
  list: string[]
}

/**
 * One instance per key: `ip:<addr>` for the per-IP window, `site:<id>` for a
 * site's caps, `site:<id>|ip:<hash>` for one source's share of a site, and
 * `deployment:all` for the global ceiling. Durable Objects serialise requests to
 * the same instance, which is the property the in-memory limiter could not give
 * us — that one counted per isolate, so the real limit was "10 per minute times
 * however many isolates Cloudflare happened to spin up".
 *
 * Storage is bounded: one record per window holding the current bucket id and
 * its count, overwritten when the bucket rolls over, plus a capped list of
 * distinct source hashes. An alarm set to the furthest reset wipes an idle
 * instance, so a site that stops receiving traffic stops holding anything.
 */
export class RateLimiterDO implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as ConsumeRequest
    const now = body.now ?? Date.now()
    // Never trust the caller's limits: clamp them to the policy constants so a
    // bug on the other side cannot ask for an effectively unlimited window.
    const specs = clampSpecs(body.specs)
    const names = specs.map(s => s.name)

    const stored: Record<string, Bucket | undefined> = {}
    for (const name of names) {
      stored[name] = await this.state.storage.get<Bucket>(`w:${name}`)
    }

    const result = evaluateWindows(specs, stored, now, body.action)

    // Distinct sources, tracked against the longest window so the number means
    // "how many addresses are involved in this", not "in the last minute".
    let sources = await this.state.storage.get<SourceRecord>(SOURCES_KEY)
    const widest = specs.reduce((a, b) => (a.ms >= b.ms ? a : b), specs[0])
    const sourceBucket = widest ? Math.floor(now / widest.ms) : 0
    if (!sources || sources.bucket !== sourceBucket) sources = { bucket: sourceBucket, list: [] }
    if (body.action === 'consume' && body.source
        && !sources.list.includes(body.source) && sources.list.length < MAX_TRACKED_SOURCES) {
      sources.list.push(body.source)
      await this.state.storage.put(SOURCES_KEY, sources)
    }

    let notify = false
    if (body.action === 'consume') {
      if (result.allowed) {
        for (const [name, bucket] of Object.entries(result.next)) {
          await this.state.storage.put(`w:${name}`, bucket)
        }
        // Wipe this instance once every window it holds has reset, so an idle
        // site leaves nothing behind.
        const furthest = Math.max(...result.usage.map(u => u.resetAt))
        if (Number.isFinite(furthest)) await this.state.storage.setAlarm(furthest)
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
      distinctSources: sources.list.length,
    }
    return Response.json(response)
  }

  /** Every window has reset; nothing here is worth keeping. */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll()
  }
}
