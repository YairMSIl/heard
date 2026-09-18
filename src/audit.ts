import type { Env } from './types'
import { hashSource, sourceBucket } from './limits'
import { randomId } from './ids'

export const AUDIT_RETENTION_DAYS = 365

export type AuditActor = string // owner id, 'admin-api', or 'cron'

export const ADMIN_API_ACTOR = 'admin-api'
export const CRON_ACTOR = 'cron'

export interface AuditEntry {
  actor: AuditActor
  action: string
  targetType?: 'site' | 'report' | 'deployment' | null
  targetId?: string | null
  siteId?: string | null
  ip?: string | null
  detail?: Record<string, unknown> | null
}

export interface AuditRow {
  id: string
  ts: number
  actor: string
  action: string
  target_type: string | null
  target_id: string | null
  site_id: string | null
  ip_hash: string | null
  detail: string | null
}

/**
 * Addresses are bucketed to a /24 or /64 and then hashed. The log needs to
 * answer "was this the same source as that" without becoming a store of
 * visitor IP addresses — which would be a new privacy liability created by a
 * privacy control.
 */
export const auditIpHash = (ip: string | null | undefined): string | null =>
  ip ? hashSource(sourceBucket(ip)) : null

/**
 * Writes one audit row. Never throws: an audit failure must not turn a
 * successful deletion into a 500 for the owner, and must not make the admin API
 * unavailable. It does log loudly, because a silently missing audit trail is
 * worse than a noisy one.
 */
export async function recordAudit(env: Env, entry: AuditEntry, now: number = Date.now()): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit (id, ts, actor, action, target_type, target_id, site_id, ip_hash, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `aud_${randomId(16)}`,
      now,
      entry.actor,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.siteId ?? null,
      auditIpHash(entry.ip),
      entry.detail ? JSON.stringify(entry.detail) : null,
    ).run()
  } catch (err) {
    console.error('audit write failed', entry.action, err instanceof Error ? err.message : err)
  }
}

export async function loadAudit(env: Env, siteId: string, limit = 200): Promise<AuditRow[]> {
  const { results } = await env.DB
    .prepare('SELECT * FROM audit WHERE site_id = ? ORDER BY ts DESC LIMIT ?')
    .bind(siteId, limit).all<AuditRow>()
  return results ?? []
}
