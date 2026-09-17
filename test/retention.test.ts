import { describe, expect, it } from 'vitest'
import { DEMO_RETENTION_HOURS, DONE_RETENTION_DAYS, pruneReports } from '../src/retention'
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
    for (const call of calls) {
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
})
