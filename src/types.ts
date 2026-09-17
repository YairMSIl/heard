export interface Env {
  DB: D1Database
  /** Break-glass shared token; the normal way in is GitHub OAuth. */
  ADMIN_TOKEN?: string
  GITHUB_OAUTH_CLIENT_ID?: string
  GITHUB_OAUTH_CLIENT_SECRET?: string
  /** Signs session cookies. Rotating it signs everyone out. */
  SESSION_SECRET?: string
}

export interface OwnerRow {
  id: string
  provider: string
  external_id: string | null
  email: string | null
  login: string | null
  created_at: number
}

export type ReportType = 'bug' | 'idea' | 'praise'
export type ReportStatus = 'new' | 'in-progress' | 'done'

export const REPORT_TYPES: ReportType[] = ['bug', 'idea', 'praise']
export const REPORT_STATUSES: ReportStatus[] = ['new', 'in-progress', 'done']

export interface SiteRow {
  id: string
  owner_id: string
  name: string
  public_key: string
  webhook_url: string | null
  webhook_secret: string | null
  created_at: number
}

export interface ReportRow {
  id: string
  site_id: string
  type: ReportType
  message: string
  email: string | null
  page_url: string | null
  user_agent: string | null
  viewport: string | null
  status: ReportStatus
  created_at: number
}
