import type { Env } from './types'

export const DONE_RETENTION_DAYS = 180
/** Outer bound for reports nobody ever triaged, so "new" is not "forever". */
export const OPEN_RETENTION_DAYS = 365
/** After this, a reporter's email is dropped regardless of the report's status. */
export const EMAIL_RETENTION_DAYS = 90
/** The audit log has its own clock, longer than reports' own retention. */
export const AUDIT_RETENTION_DAYS = 365
export const DEMO_RETENTION_HOURS = 24
export const DEMO_SITE_ID = 'site_demo'

export interface PruneResult {
  doneDeleted: number
  openDeleted: number
  emailsCleared: number
  demoDeleted: number
  auditDeleted: number
  doneCutoff: number
  openCutoff: number
  emailCutoff: number
  demoCutoff: number
  auditCutoff: number
}

export const LAST_PRUNE_KEY = 'last_prune_at'
export const LAST_PRUNE_COUNTS_KEY = 'last_prune_counts'

export interface PruneFreshness {
  lastPruneAt: string | null
  pruneAgeHours: number | null
}

/**
 * Turns the stored timestamp into something a sensor can threshold on.
 * A never-run cron and an unparseable value both read as `null` rather than as
 * age 0 — "I do not know" must not look like "just ran".
 */
export function describePruneFreshness(value: string | null | undefined, now: number = Date.now()): PruneFreshness {
  if (!value) return { lastPruneAt: null, pruneAgeHours: null }
  const at = Date.parse(value)
  if (Number.isNaN(at)) return { lastPruneAt: null, pruneAgeHours: null }
  return {
    lastPruneAt: new Date(at).toISOString(),
    pruneAgeHours: Math.round(((now - at) / 3_600_000) * 10) / 10,
  }
}

/**
 * Daily cron work. Two rules, for two different reasons:
 *
 *  - Triaged ("done") reports older than 180 days are history nobody reads, and
 *    D1's free tier is finite. Anything still `new` or `in-progress` is kept
 *    forever — deleting an owner's open queue would be a bug, not a cleanup.
 *  - The demo site is a public write endpoint by design, so everything it
 *    collects is disposable and goes after 24 hours regardless of status.
 */
export async function pruneReports(env: Env, now: number = Date.now()): Promise<PruneResult> {
  const doneCutoff = now - DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const openCutoff = now - OPEN_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const emailCutoff = now - EMAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const demoCutoff = now - DEMO_RETENTION_HOURS * 60 * 60 * 1000
  const auditCutoff = now - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000

  const done = await env.DB
    .prepare("DELETE FROM reports WHERE status = 'done' AND created_at < ?")
    .bind(doneCutoff).run()

  // Reports nobody triaged still go eventually: "we keep it until you deal with
  // it" is not a retention policy anyone can promise a visitor.
  const open = await env.DB
    .prepare("DELETE FROM reports WHERE status != 'done' AND created_at < ?")
    .bind(openCutoff).run()

  // The email is the only directly identifying field a visitor gives us, and it
  // stops being useful long before the report does. Cleared on its own clock,
  // regardless of status, so an untriaged report does not keep an address alive.
  const emails = await env.DB
    .prepare('UPDATE reports SET email = NULL WHERE email IS NOT NULL AND created_at < ?')
    .bind(emailCutoff).run()

  const demo = await env.DB
    .prepare('DELETE FROM reports WHERE site_id = ? AND created_at < ?')
    .bind(DEMO_SITE_ID, demoCutoff).run()

  const audit = await env.DB
    .prepare('DELETE FROM audit WHERE ts < ?')
    .bind(auditCutoff).run()

  const result: PruneResult = {
    doneDeleted: done.meta?.changes ?? 0,
    openDeleted: open.meta?.changes ?? 0,
    emailsCleared: emails.meta?.changes ?? 0,
    demoDeleted: demo.meta?.changes ?? 0,
    auditDeleted: audit.meta?.changes ?? 0,
    doneCutoff,
    openCutoff,
    emailCutoff,
    demoCutoff,
    auditCutoff,
  }

  // Written last and unconditionally: the point of this row is "the cron ran to
  // completion", so a run that deleted nothing still counts. If the deletes
  // threw, we never get here and the row correctly goes stale.
  await env.DB.prepare(
    'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).bind(LAST_PRUNE_KEY, new Date(now).toISOString(), now).run()

  await env.DB.prepare(
    'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).bind(LAST_PRUNE_COUNTS_KEY,
    JSON.stringify({
      doneDeleted: result.doneDeleted,
      openDeleted: result.openDeleted,
      emailsCleared: result.emailsCleared,
      demoDeleted: result.demoDeleted,
      auditDeleted: result.auditDeleted,
    }), now).run()

  return result
}
