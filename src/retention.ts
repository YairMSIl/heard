import type { Env } from './types'

export const DONE_RETENTION_DAYS = 180
export const DEMO_RETENTION_HOURS = 24
export const DEMO_SITE_ID = 'site_demo'

export interface PruneResult {
  doneDeleted: number
  demoDeleted: number
  doneCutoff: number
  demoCutoff: number
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
  const demoCutoff = now - DEMO_RETENTION_HOURS * 60 * 60 * 1000

  const done = await env.DB
    .prepare("DELETE FROM reports WHERE status = 'done' AND created_at < ?")
    .bind(doneCutoff).run()

  const demo = await env.DB
    .prepare('DELETE FROM reports WHERE site_id = ? AND created_at < ?')
    .bind(DEMO_SITE_ID, demoCutoff).run()

  return {
    doneDeleted: done.meta?.changes ?? 0,
    demoDeleted: demo.meta?.changes ?? 0,
    doneCutoff,
    demoCutoff,
  }
}
