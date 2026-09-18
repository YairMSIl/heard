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

/**
 * Hosts a webhook may never point at. Heard fetches these URLs itself, from
 * inside Cloudflare's network, so an owner-supplied URL is a request we make on
 * a stranger's behalf: the classic SSRF shape. Literal private, loopback,
 * link-local, CGNAT and IPv6 ULA addresses are refused outright.
 *
 * This is not complete protection — a hostname that resolves to a private
 * address still passes, because we do not resolve DNS here. It removes the
 * trivial cases; the delivery cap and auto-disable below remove the value of
 * the rest.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '0.0.0.0') return true
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true       // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  }
  return false
}

/** Only http(s) webhooks; anything else is a misconfiguration or an SSRF attempt. */
export type UrlResult = { ok: true; value: string | null } | { ok: false; error: string }

const MAX_ORIGINS = 20

/**
 * Parses an owner-supplied origin allow-list (newline or comma separated) into
 * a canonical `scheme://host[:port]` list. Stored as a newline-joined string.
 *
 * Empty means "any origin" — the MVP default. This check raises the cost of
 * abuse without eliminating it: a non-browser client can send any `Origin` it
 * likes, so this stops opportunistic key reuse from a real browser, not a
 * determined attacker. Said plainly in the dashboard too.
 */
export function parseAllowedOrigins(input: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return { ok: true, value: null }

  const parts = raw.split(/[\n,]+/).map(p => p.trim()).filter(Boolean)
  if (parts.length > MAX_ORIGINS) return { ok: false, error: `at most ${MAX_ORIGINS} origins` }

  const origins: string[] = []
  for (const part of parts) {
    let url: URL
    try {
      url = new URL(part.includes('://') ? part : `https://${part}`)
    } catch {
      return { ok: false, error: `"${part}" is not a valid origin` }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: `"${part}" must be http or https` }
    }
    if (!origins.includes(url.origin)) origins.push(url.origin)
  }
  return { ok: true, value: origins.join('\n') }
}

/**
 * Distinct origins a site's reports actually came from, newest first.
 *
 * Derived from `page_url`, which is visitor-supplied and therefore a hint, not
 * evidence — it is good enough to *suggest* a lock, and deliberately not used to
 * apply one. Anything unparseable is dropped rather than guessed at.
 */
export function observedOrigins(pageUrls: (string | null)[]): string[] {
  const seen: string[] = []
  for (const raw of pageUrls) {
    if (!raw) continue
    try {
      const { origin, protocol } = new URL(raw)
      if (protocol !== 'http:' && protocol !== 'https:') continue
      if (!seen.includes(origin)) seen.push(origin)
    } catch { /* not a URL; nothing to learn from it */ }
  }
  return seen
}

export function allowedOriginList(stored: string | null | undefined): string[] {
  return (stored ?? '').split('\n').map(o => o.trim()).filter(Boolean)
}

/** No list configured means no restriction; that is the documented default. */
export function isOriginAllowed(origin: string | null | undefined, stored: string | null | undefined): boolean {
  const list = allowedOriginList(stored)
  if (list.length === 0) return true
  if (!origin) return false
  try {
    return list.includes(new URL(origin).origin)
  } catch {
    return false
  }
}

/** A cap field: blank clears the override back to the default, never to "unlimited". */
export function parseCap(input: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return { ok: true, value: null }
  // Plain digits only. `Number('1e3')` is a valid integer, but someone typing
  // that into a cap field is more likely confused than deliberate.
  if (!/^\d+$/.test(raw)) return { ok: false, error: 'caps must be whole numbers of 1 or more' }
  const n = Number(raw)
  if (n < 1) return { ok: false, error: 'caps must be whole numbers of 1 or more' }
  if (n > 1_000_000) return { ok: false, error: 'that cap is unreasonably large' }
  return { ok: true, value: n }
}

export function validateWebhookUrl(value: string | null | undefined, selfOrigin?: string): UrlResult {
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
  if (isPrivateHostname(url.hostname)) {
    return { ok: false, error: 'webhook url must point at a public address, not a private or loopback one' }
  }
  // Pointing Heard at itself is a loop or a probe, never a real configuration.
  if (selfOrigin && url.origin === selfOrigin) {
    return { ok: false, error: 'webhook url cannot point back at Heard' }
  }
  return { ok: true, value: url.toString() }
}
