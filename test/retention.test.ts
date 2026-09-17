import { describe, expect, it } from 'vitest'
import {
  DEMO_RETENTION_HOURS,
  DONE_RETENTION_DAYS,
  LAST_PRUNE_COUNTS_KEY,
  LAST_PRUNE_KEY,
  describePruneFreshness,
  pruneReports,
} from '../src/retention'
import type { Env } from '../src/types'

interface Call { sql: string; args: unknown[] }

/**
 * A D1 stand-in that records what was asked of it. The value here is asserting
 * the *cutoffs and predicates*, which is where a retention bug deletes data it
 * should have kept.
 */
function fakeDb(changes = [3, 7]) {
  const calls: Call[] = []
  let i = 0
  const env = {
    DB: {
      prepare(sql: string) {
        const call: Call = { sql, args: [] }
        return {
          bind(...args: unknown[]) {
            call.args = args
            return this
          },
          async run() {
            calls.push(call)
            return { meta: { changes: changes[i++] ?? 0 } }
          },
        }
      },
    },
  } as unknown as Env
  return { env, calls }
}

const NOW = 1_800_000_000_000

describe('pruneReports', () => {
  it('deletes only done reports past the 180-day cutoff', async () => {
    const { env, calls } = fakeDb()
    const result = await pruneReports(env, NOW)

    expect(calls[0].sql).toContain("status = 'done'")
    expect(calls[0].args[0]).toBe(NOW - DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    expect(result.doneDeleted).toBe(3)
  })

  it('never touches new or in-progress reports', async () => {
    const { env, calls } = fakeDb()
    await pruneReports(env, NOW)
    for (const call of calls.filter(c => c.sql.startsWith('DELETE'))) {
      expect(call.sql).not.toContain('in-progress')
      expect(call.sql).not.toMatch(/status\s*=\s*'new'/)
    }
  })

  it('deletes every demo report past 24 hours regardless of status', async () => {
    const { env, calls } = fakeDb()
    const result = await pruneReports(env, NOW)

    expect(calls[1].sql).toContain('site_id = ?')
    expect(calls[1].sql).not.toContain('status')
    expect(calls[1].args).toEqual(['site_demo', NOW - DEMO_RETENTION_HOURS * 60 * 60 * 1000])
    expect(result.demoDeleted).toBe(7)
  })

  it('reports zero when D1 gives no change count', async () => {
    const { env } = fakeDb([])
    const result = await pruneReports(env, NOW)
    expect(result).toMatchObject({ doneDeleted: 0, demoDeleted: 0 })
  })

  it('puts the demo cutoff far more recent than the done cutoff', async () => {
    const { env } = fakeDb()
    const { doneCutoff, demoCutoff } = await pruneReports(env, NOW)
    expect(demoCutoff).toBeGreaterThan(doneCutoff)
  })

  it('records that it ran, after the deletes', async () => {
    const { env, calls } = fakeDb()
    await pruneReports(env, NOW)

    const meta = calls.filter(c => c.sql.includes('INSERT INTO meta'))
    expect(meta).toHaveLength(2)
    // Order matters: the marker must not claim a run that then failed.
    expect(calls.indexOf(meta[0])).toBeGreaterThan(calls.findIndex(c => c.sql.startsWith('DELETE')))

    expect(meta[0].args).toEqual([LAST_PRUNE_KEY, new Date(NOW).toISOString(), NOW])
    expect(meta[0].sql).toContain('ON CONFLICT(key) DO UPDATE')
  })

  it('records the counts alongside the timestamp', async () => {
    const { env, calls } = fakeDb()
    await pruneReports(env, NOW)
    const counts = calls.find(c => c.args[0] === LAST_PRUNE_COUNTS_KEY)!
    expect(JSON.parse(counts.args[1] as string)).toEqual({ doneDeleted: 3, demoDeleted: 7 })
  })

  it('still records a run that deleted nothing', async () => {
    const { env, calls } = fakeDb([0, 0])
    await pruneReports(env, NOW)
    const counts = calls.find(c => c.args[0] === LAST_PRUNE_COUNTS_KEY)!
    expect(JSON.parse(counts.args[1] as string)).toEqual({ doneDeleted: 0, demoDeleted: 0 })
    expect(calls.some(c => c.args[0] === LAST_PRUNE_KEY)).toBe(true)
  })
})

describe('describePruneFreshness', () => {
  const NOW_MS = Date.parse('2026-09-17T12:00:00.000Z')

  it('reports null for a cron that has never run', () => {
    expect(describePruneFreshness(null, NOW_MS)).toEqual({ lastPruneAt: null, pruneAgeHours: null })
    expect(describePruneFreshness(undefined, NOW_MS)).toEqual({ lastPruneAt: null, pruneAgeHours: null })
    expect(describePruneFreshness('', NOW_MS)).toEqual({ lastPruneAt: null, pruneAgeHours: null })
  })

  it('reads an unparseable value as unknown, not as fresh', () => {
    expect(describePruneFreshness('last tuesday', NOW_MS)).toEqual({ lastPruneAt: null, pruneAgeHours: null })
  })

  it('computes the age in hours to one decimal', () => {
    expect(describePruneFreshness('2026-09-17T09:30:00.000Z', NOW_MS))
      .toEqual({ lastPruneAt: '2026-09-17T09:30:00.000Z', pruneAgeHours: 2.5 })
  })

  it('crosses the 26-hour staleness line the sensor watches', () => {
    const fresh = describePruneFreshness('2026-09-16T11:00:00.000Z', NOW_MS)
    const stale = describePruneFreshness('2026-09-16T09:00:00.000Z', NOW_MS)
    expect(fresh.pruneAgeHours).toBe(25)
    expect(stale.pruneAgeHours).toBe(27)
  })
})
