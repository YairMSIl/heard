import { timingSafeEqual } from './auth'
import { REPORT_STATUSES, type ReportStatus } from './types'

/**
 * The admin API exists so the operating agent can read and triage feedback
 * *about Heard* without a GitHub session. The bearer token is the same shared
 * ADMIN_TOKEN that unlocks the break-glass dashboard login.
 *
 * That token must never become a way to read customers' feedback, so this
 * module hard-codes the only two sites it may touch: Heard's own site and the
 * public demo. The allow-list lives here, next to the auth, rather than in the
 * route handlers — a new admin endpoint that forgets to scope itself is a data
 * breach, and the failure should be impossible to write rather than easy to
 * review.
 */
export const ADMIN_ALLOWED_SITES = ['site_self', 'site_demo'] as const

export const DEFAULT_ADMIN_SITE = 'site_self'
const MAX_LIMIT = 200

export type AdminFailure = { ok: false; status: 400 | 401 | 403 | 500; error: string }

export function isAdminAllowedSite(siteId: string): boolean {
  return (ADMIN_ALLOWED_SITES as readonly string[]).includes(siteId)
}

/** `Authorization: Bearer <ADMIN_TOKEN>`. */
export function authorizeAdmin(
  header: string | undefined,
  expected: string | undefined,
): { ok: true } | AdminFailure {
  if (!expected) return { ok: false, status: 500, error: 'admin API is not configured' }
  const prefix = 'Bearer '
  if (!header || !header.startsWith(prefix)) {
    return { ok: false, status: 401, error: 'missing bearer token' }
  }
  const presented = header.slice(prefix.length).trim()
  if (!timingSafeEqual(presented, expected)) {
    return { ok: false, status: 401, error: 'invalid token' }
  }
  return { ok: true }
}

export interface AdminReportQuery {
  site: string
  since: number | null
  status: ReportStatus | null
  limit: number
}

export function parseAdminReportQuery(params: {
  site?: string | null
  since?: string | null
  status?: string | null
  limit?: string | null
}): { ok: true; value: AdminReportQuery } | AdminFailure {
  const site = params.site?.trim() || DEFAULT_ADMIN_SITE
  // 403 rather than 404: the caller is authenticated, the site may well exist,
  // and we are refusing on scope. Saying "not found" would be a lie.
  if (!isAdminAllowedSite(site)) {
    return {
      ok: false,
      status: 403,
      error: `the admin API is limited to ${ADMIN_ALLOWED_SITES.join(', ')}`,
    }
  }

  let since: number | null = null
  if (params.since) {
    const parsed = Date.parse(params.since)
    if (Number.isNaN(parsed)) return { ok: false, status: 400, error: 'since must be an ISO timestamp' }
    since = parsed
  }

  let status: ReportStatus | null = null
  if (params.status) {
    if (!(REPORT_STATUSES as string[]).includes(params.status)) {
      return { ok: false, status: 400, error: `status must be one of ${REPORT_STATUSES.join(', ')}` }
    }
    status = params.status as ReportStatus
  }

  let limit = MAX_LIMIT
  if (params.limit) {
    const parsed = Number(params.limit)
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, status: 400, error: 'limit must be a positive integer' }
    }
    limit = Math.min(parsed, MAX_LIMIT)
  }

  return { ok: true, value: { site, since, status, limit } }
}

export function parseAdminStatus(value: unknown): { ok: true; value: ReportStatus } | AdminFailure {
  if (typeof value !== 'string' || !(REPORT_STATUSES as string[]).includes(value)) {
    return { ok: false, status: 400, error: `status must be one of ${REPORT_STATUSES.join(', ')}` }
  }
  return { ok: true, value: value as ReportStatus }
}
