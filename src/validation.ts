import { REPORT_TYPES, type ReportType } from './types'

export const MAX_MESSAGE_LENGTH = 2000
const MAX_EMAIL_LENGTH = 254
const MAX_URL_LENGTH = 2048
const MAX_USER_AGENT_LENGTH = 512
const MAX_VIEWPORT_LENGTH = 32

export interface ValidReport {
  type: ReportType
  message: string
  email: string | null
  pageUrl: string | null
  viewport: string | null
}

export type ValidationResult =
  | { ok: true; value: ValidReport }
  | { ok: false; error: string }

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Trim, collapse to null when empty, and hard-cap length. */
function optional(value: unknown, max: number): string | null {
  const s = asString(value)?.trim()
  if (!s) return null
  return s.slice(0, max)
}

/**
 * Deliberately loose: an MVP feedback form should never reject a visitor over
 * an exotic-but-legal address. We only guard against values that are obviously
 * not addresses, so the dashboard's "reply to" link is usable.
 */
function isPlausibleEmail(value: string): boolean {
  if (value.length > MAX_EMAIL_LENGTH) return false
  const at = value.indexOf('@')
  if (at <= 0 || at !== value.lastIndexOf('@')) return false
  const domain = value.slice(at + 1)
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.') && !/\s/.test(value)
}

export function isReportType(value: unknown): value is ReportType {
  return typeof value === 'string' && (REPORT_TYPES as string[]).includes(value)
}

/**
 * Validates the untrusted body of POST /api/report. Anything the visitor's
 * browser reports about itself (page url, viewport) is treated as a hint, not
 * as fact — capped and stored verbatim, never interpreted.
 */
export function validateReportInput(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const body = input as Record<string, unknown>

  if (!isReportType(body.type)) {
    return { ok: false, error: `type must be one of ${REPORT_TYPES.join(', ')}` }
  }

  const message = asString(body.message)?.trim() ?? ''
  if (message.length === 0) return { ok: false, error: 'message is required' }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `message must be at most ${MAX_MESSAGE_LENGTH} characters` }
  }

  const email = optional(body.email, MAX_EMAIL_LENGTH)
  if (email !== null && !isPlausibleEmail(email)) {
    return { ok: false, error: 'email is not a valid address' }
  }

  return {
    ok: true,
    value: {
      type: body.type,
      message,
      email,
      pageUrl: optional(body.pageUrl ?? body.page_url, MAX_URL_LENGTH),
      viewport: optional(body.viewport, MAX_VIEWPORT_LENGTH),
    },
  }
}

export function truncateUserAgent(value: string | null | undefined): string | null {
  return optional(value, MAX_USER_AGENT_LENGTH)
}

/** Only http(s) webhooks; anything else is a misconfiguration or an SSRF attempt. */
export type UrlResult = { ok: true; value: string | null } | { ok: false; error: string }

export function validateWebhookUrl(value: string | null | undefined): UrlResult {
  const raw = asString(value)?.trim()
  if (!raw) return { ok: true, value: null }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'webhook url is not a valid URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'webhook url must be http or https' }
  }
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: 'webhook url is too long' }
  return { ok: true, value: url.toString() }
}
