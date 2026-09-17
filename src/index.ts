import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Env, ReportRow, ReportStatus, SiteRow } from './types'
import { REPORT_STATUSES } from './types'
import { newPublicKey, newReportId, newSiteId } from './ids'
import { reportRateLimiter } from './ratelimit'
import { truncateUserAgent, validateReportInput, validateWebhookUrl } from './validation'
import { buildWebhookPayload, deliverWebhook } from './webhook'
import { errorPage, loginPage, newSitePage, sitePage, sitesPage } from './views'
import { WIDGET_JS } from './widget'

const AUTH_COOKIE = 'fb_admin'
const LOCAL_OWNER_ID = 'own_local'

const app = new Hono<{ Bindings: Env }>()

/* ------------------------------------------------------------------ public */

app.get('/health', async c => {
  let db: 'ok' | 'error' = 'ok'
  let detail: string | undefined
  try {
    await c.env.DB.prepare('SELECT 1').first()
  } catch (err) {
    db = 'error'
    detail = err instanceof Error ? err.message : String(err)
  }
  return c.json({ status: db === 'ok' ? 'ok' : 'degraded', db, detail, time: new Date().toISOString() },
    db === 'ok' ? 200 : 503)
})

app.get('/widget.js', c =>
  c.body(WIDGET_JS, 200, {
    'content-type': 'application/javascript; charset=utf-8',
    // Long cache with a short revalidate window: the widget is versionless and
    // embedded on pages we do not control, so a bad deploy must age out fast.
    'cache-control': 'public, max-age=300, s-maxage=300',
    'access-control-allow-origin': '*',
  }))

// The report endpoint is called from arbitrary origins by design.
app.use('/api/report', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], allowHeaders: ['content-type'], maxAge: 86400 }))

app.post('/api/report', async c => {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'
  const limit = reportRateLimiter.check(ip)
  if (!limit.allowed) {
    return c.json({ error: 'Too many reports, please slow down.' }, 429, {
      'retry-after': String(limit.retryAfterSeconds),
    })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'body must be valid JSON' }, 400)
  }

  const key = typeof (body as Record<string, unknown>)?.key === 'string'
    ? ((body as Record<string, unknown>).key as string)
    : null
  if (!key) return c.json({ error: 'key is required' }, 400)

  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE public_key = ?')
    .bind(key).first<SiteRow>()
  // Same response for "no such site" as for a real one: the public key should
  // not double as an oracle for enumerating sites.
  if (!site) return c.json({ error: 'unknown site key' }, 404)

  const parsed = validateReportInput(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const report: ReportRow = {
    id: newReportId(),
    site_id: site.id,
    type: parsed.value.type,
    message: parsed.value.message,
    email: parsed.value.email,
    page_url: parsed.value.pageUrl,
    user_agent: truncateUserAgent(c.req.header('user-agent')),
    viewport: parsed.value.viewport,
    status: 'new',
    created_at: Date.now(),
  }

  await c.env.DB.prepare(
    `INSERT INTO reports (id, site_id, type, message, email, page_url, user_agent, viewport, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(report.id, report.site_id, report.type, report.message, report.email,
    report.page_url, report.user_agent, report.viewport, report.status, report.created_at).run()

  if (site.webhook_url) {
    c.executionCtx.waitUntil(deliverWebhook(site.webhook_url, buildWebhookPayload(site.name, report)))
  }

  return c.json({ ok: true, id: report.id }, 201)
})

app.get('/demo', async c => {
  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?')
    .bind('site_demo').first<SiteRow>()
  if (!site) {
    return c.html(errorPage(404, 'Demo site missing. Run: npm run db:migrate:local'), 404)
  }
  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>fbwidget demo</title>
<style>
  body{margin:0;font:16px/1.6 ui-sans-serif,system-ui,sans-serif;color:#111827;background:#fff}
  .wrap{max-width:640px;margin:0 auto;padding:80px 24px}
  h1{font-size:30px;margin:0 0 8px}
  p{color:#4b5563}
  code{background:#f3f4f6;padding:2px 5px;border-radius:4px;font-size:14px}
</style></head>
<body><div class="wrap">
  <h1>A perfectly ordinary page</h1>
  <p>This page is the host site. The only thing it does differently is load the widget
     with one script tag. Look at the bottom-right corner.</p>
  <p>Submit something, then open <a href="/sites/site_demo">the demo site dashboard</a> to see it land.</p>
  <p><code>&lt;script src="/widget.js?key=${site.public_key}" defer&gt;&lt;/script&gt;</code></p>
</div>
<script src="/widget.js?key=${site.public_key}" defer><\/script>
</body></html>`)
})

/* -------------------------------------------------------------------- auth */

/**
 * MVP auth: one shared token in a cookie. Everything downstream already reads
 * an owner id (hardcoded to the local owner here), so swapping in GitHub OAuth
 * means changing this middleware and nothing else.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

app.get('/login', c => {
  const expected = c.env.ADMIN_TOKEN
  if (!expected) return c.html(errorPage(500, 'ADMIN_TOKEN is not configured on this Worker.'), 500)

  const token = c.req.query('token')
  if (token === undefined) return c.html(loginPage())
  if (!timingSafeEqual(token, expected)) return c.html(loginPage('That token is not right.'), 401)

  setCookie(c, AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.redirect('/sites', 302)
})

app.post('/logout', c => {
  deleteCookie(c, AUTH_COOKIE, { path: '/' })
  return c.redirect('/login', 302)
})

const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.ADMIN_TOKEN
  if (!expected) return c.html(errorPage(500, 'ADMIN_TOKEN is not configured on this Worker.'), 500)
  const cookie = getCookie(c, AUTH_COOKIE)
  if (!cookie || !timingSafeEqual(cookie, expected)) return c.redirect('/login', 302)
  await next()
}

app.use('/sites', requireAuth)
app.use('/sites/*', requireAuth)
app.use('/reports/*', requireAuth)

/* --------------------------------------------------------------- dashboard */

app.get('/', c => c.redirect('/sites', 302))

app.get('/sites', async c => {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM sites WHERE owner_id = ? ORDER BY created_at DESC')
    .bind(LOCAL_OWNER_ID).all<SiteRow>()
  return c.html(sitesPage(results ?? []))
})

app.get('/sites/new', c => c.html(newSitePage()))

app.post('/sites/new', async c => {
  const form = await c.req.formData()
  const name = String(form.get('name') ?? '').trim()
  if (!name) return c.html(newSitePage('Site name is required.'), 400)
  if (name.length > 120) return c.html(newSitePage('Site name is too long.'), 400)

  const id = newSiteId()
  await c.env.DB.prepare(
    'INSERT INTO sites (id, owner_id, name, public_key, webhook_url, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
  ).bind(id, LOCAL_OWNER_ID, name, newPublicKey(), Date.now()).run()
  return c.redirect(`/sites/${id}`, 302)
})

async function loadSite(c: { env: Env }, id: string): Promise<SiteRow | null> {
  return await c.env.DB.prepare('SELECT * FROM sites WHERE id = ? AND owner_id = ?')
    .bind(id, LOCAL_OWNER_ID).first<SiteRow>()
}

app.get('/sites/:id', async c => {
  const site = await loadSite(c, c.req.param('id'))
  if (!site) return c.html(errorPage(404, 'No such site.'), 404)
  const { results } = await c.env.DB
    .prepare('SELECT * FROM reports WHERE site_id = ? ORDER BY created_at DESC LIMIT 200')
    .bind(site.id).all<ReportRow>()
  const flash = c.req.query('saved') ? { ok: 'Saved.' } : undefined
  return c.html(sitePage(site, results ?? [], new URL(c.req.url).origin, flash))
})

app.post('/sites/:id/webhook', async c => {
  const site = await loadSite(c, c.req.param('id'))
  if (!site) return c.html(errorPage(404, 'No such site.'), 404)

  const form = await c.req.formData()
  const parsed = validateWebhookUrl(String(form.get('webhook_url') ?? ''))
  if (!parsed.ok) {
    return c.html(sitePage(site, [], new URL(c.req.url).origin, { error: parsed.error }), 400)
  }
  await c.env.DB.prepare('UPDATE sites SET webhook_url = ? WHERE id = ?')
    .bind(parsed.value, site.id).run()
  return c.redirect(`/sites/${site.id}?saved=1`, 302)
})

app.post('/reports/:id/status', async c => {
  const form = await c.req.formData()
  const status = String(form.get('status') ?? '')
  if (!(REPORT_STATUSES as string[]).includes(status)) {
    return c.html(errorPage(400, 'Unknown status.'), 400)
  }
  // The join on sites keeps a report id from another owner out of reach once
  // owners are real.
  const report = await c.env.DB.prepare(
    `SELECT reports.id AS id, reports.site_id AS site_id FROM reports
     JOIN sites ON sites.id = reports.site_id
     WHERE reports.id = ? AND sites.owner_id = ?`,
  ).bind(c.req.param('id'), LOCAL_OWNER_ID).first<{ id: string; site_id: string }>()
  if (!report) return c.html(errorPage(404, 'No such report.'), 404)

  await c.env.DB.prepare('UPDATE reports SET status = ? WHERE id = ?')
    .bind(status as ReportStatus, report.id).run()
  return c.redirect(`/sites/${report.site_id}`, 302)
})

app.notFound(c => c.html(errorPage(404, 'Nothing here.'), 404))

app.onError((err, c) => {
  console.error('unhandled', err)
  return c.html(errorPage(500, 'Something broke on our side.'), 500)
})

export default app
