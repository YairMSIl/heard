import { describe, expect, it, vi } from 'vitest'
import { ADMIN_API_ACTOR, CRON_ACTOR, auditIpHash, recordAudit } from '../src/audit'
import type { Env } from '../src/types'

interface Call { sql: string; args: unknown[] }

function fakeDb(fail = false) {
  const calls: Call[] = []
  const env = {
    DB: {
      prepare(sql: string) {
        const call: Call = { sql, args: [] }
        return {
          bind(...args: unknown[]) { call.args = args; return this },
          async run() {
            if (fail) throw new Error('D1 unavailable')
            calls.push(call); return { meta: { changes: 1 } }
          },
        }
      },
    },
  } as unknown as Env
  return { env, calls }
}

const NOW = 1_800_000_000_000

describe('recordAudit', () => {
  it('writes the fields the log is meant to answer with', async () => {
    const { env, calls } = fakeDb()
    await recordAudit(env, {
      actor: 'own_abc', action: 'report.delete', targetType: 'report',
      targetId: 'rep_1', siteId: 'site_1', ip: '203.0.113.9', detail: { reason: 'test' },
    }, NOW)
    const [id, ts, actor, action, targetType, targetId, siteId, ipHash, detail] = calls[0].args
    expect(String(id)).toMatch(/^aud_/)
    expect(ts).toBe(NOW)
    expect(actor).toBe('own_abc')
    expect(action).toBe('report.delete')
    expect([targetType, targetId, siteId]).toEqual(['report', 'rep_1', 'site_1'])
    expect(ipHash).toMatch(/^[0-9a-f]{8}$/)
    expect(JSON.parse(String(detail))).toEqual({ reason: 'test' })
  })

  it('never stores a raw address', async () => {
    const { env, calls } = fakeDb()
    await recordAudit(env, { actor: 'own_a', action: 'x', ip: '203.0.113.9' }, NOW)
    const serialised = JSON.stringify(calls[0].args)
    expect(serialised).not.toContain('203.0.113.9')
    expect(serialised).not.toContain('203.0.113')
  })

  it('buckets addresses so the same network hashes alike', () => {
    // Useful for "was this the same source", useless as a store of who visited.
    expect(auditIpHash('203.0.113.9')).toBe(auditIpHash('203.0.113.200'))
    expect(auditIpHash('203.0.113.9')).not.toBe(auditIpHash('203.0.114.9'))
    expect(auditIpHash(null)).toBeNull()
  })

  it('never throws, so an audit failure cannot break the action it records', async () => {
    // A failed delete-audit must not turn a successful deletion into a 500.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { env } = fakeDb(true)
    await expect(recordAudit(env, { actor: 'own_a', action: 'site.delete' }, NOW)).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('omits detail entirely when there is none', async () => {
    const { env, calls } = fakeDb()
    await recordAudit(env, { actor: CRON_ACTOR, action: 'retention.prune' }, NOW)
    expect(calls[0].args[8]).toBeNull()
  })

  it('uses stable actor constants', () => {
    expect(ADMIN_API_ACTOR).toBe('admin-api')
    expect(CRON_ACTOR).toBe('cron')
  })

  it('is an INSERT only — the table is append-only by construction', async () => {
    const { env, calls } = fakeDb()
    await recordAudit(env, { actor: 'own_a', action: 'x' }, NOW)
    expect(calls[0].sql.trim().startsWith('INSERT INTO audit')).toBe(true)
    expect(calls[0].sql).not.toMatch(/UPDATE|DELETE/)
  })
})
