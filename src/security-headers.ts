import type { MiddlewareHandler } from 'hono'

/**
 * One middleware for S6 (response headers) and S7 (cross-origin POST rejection).
 *
 * `/widget.js` and `/api/report` are exempt **deliberately, by path**, not by
 * accident: the widget must stay cacheable and readable from any origin, and the
 * report endpoint is cross-origin by design — that is the entire product. Every
 * other route is same-origin only.
 */
export const PUBLIC_CORS_PATHS = ['/widget.js', '/api/report']

/**
 * `style-src 'unsafe-inline'` is required because the dashboard ships its CSS in
 * a `<style>` block; scripts are `'self'` only, which covers the self-hosted
 * widget tag and blocks any injected inline script. `connect-src 'self'` lets the
 * widget POST back to Heard from Heard's own pages.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ')

const isExempt = (path: string) => PUBLIC_CORS_PATHS.some(p => path === p || path.startsWith(p + '?'))

/** Same-origin check for state-changing requests; `Referer` is the fallback. */
export function isSameOriginRequest(
  requestUrl: string,
  origin: string | undefined,
  referer: string | undefined,
): boolean {
  const self = new URL(requestUrl).origin
  if (origin) {
    try {
      return new URL(origin).origin === self
    } catch {
      return false
    }
  }
  if (referer) {
    try {
      return new URL(referer).origin === self
    } catch {
      return false
    }
  }
  // Neither header present. A browser always sends Origin on a cross-site form
  // POST, so this is a non-browser client; refuse rather than guess.
  return false
}

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  const path = new URL(c.req.url).pathname

  if (c.req.method === 'POST' && !isExempt(path)) {
    if (!isSameOriginRequest(c.req.url, c.req.header('origin'), c.req.header('referer'))) {
      return c.json({ error: 'cross-origin request refused' }, 403)
    }
  }

  await next()

  if (isExempt(path)) return

  c.header('x-content-type-options', 'nosniff')
  c.header('referrer-policy', 'no-referrer')
  c.header('strict-transport-security', 'max-age=31536000')
  c.header('content-security-policy', CSP)

  // Authenticated pages must not sit in a shared cache or a back-button buffer.
  const isHtml = (c.res.headers.get('content-type') ?? '').includes('text/html')
  if (isHtml || path.startsWith('/api/admin')) {
    c.header('cache-control', 'private, no-store')
  }
}
