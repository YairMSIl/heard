import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Env, OwnerRow, ReportRow, ReportStatus, SiteRow } from './types'
import { REPORT_STATUSES } from './types'
import { newPublicKey, newReportId, newSiteId, newWebhookSecret, randomId } from './ids'
import { reportRateLimiter } from './ratelimit'
import { consumeIp, consumeSite, peekSite } from './ratelimit-client'
import { resolveCaps } from './limits'
import { truncateUserAgent, validateReportInput, validateWebhookUrl } from './validation'
import { buildRateLimitedPayload, buildWebhookPayload, deliverWebhook } from './webhook'
import { describePruneFreshness, LAST_PRUNE_KEY, pruneReports } from './retention'
import {
  createSession,
  exchangeCodeForToken,
  fetchGithubUser,
  githubAuthorizeUrl,
  timingSafeEqual,
  verifySession,
} from './auth'
import {
  authorizeAdmin,
  isAdminAllowedSite,
  parseAdminReportQuery,
  parseAdminStatus,
} from './admin'
import { errorPage, landingPage, loginPage, newSitePage, sitePage, sitesPage } from './views'
import { WIDGET_JS } from './widget'

const ADMIN_COOKIE = 'heard_admin'
const SESSION_COOKIE = 'heard_session'
const OAUTH_STATE_COOKIE = 'heard_oauth_state'
const LOCAL_OWNER_ID = 'own_local'
const SELF_SITE_ID = 'site_self'

type Vars = { ownerId: string; ownerLabel: string }

const app = new Hono<{ Bindings: Env; Variables: Vars }>()

const isHttps = (url: string) => new URL(url).protocol === 'https:'

/**
 * The public key of Heard's own feedback site, so Heard's pages can carry the
 * widget. Returns null rather than throwing if the row is missing, because a
 * missing self site must degrade to "no widget", never to a broken page.
 */
async function selfWidgetKey(env: Env): Promise<string | null> {
  try {
    const row = await env.DB.prepare('SELECT public_key FROM sites WHERE id = ?')
      .bind(SELF_SITE_ID).first<{ public_key: string }>()
    return row?.public_key ?? null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ public */

app.get('/health', async c => {
  let db: 'ok' | 'error' = 'ok'
  let detail: string | undefined
  // A stale cron is reported, never judged here: `status` stays 'ok' so the
  // uptime sensor keeps deciding what is worth waking someone for.
  let freshness = describePruneFreshness(null)

  try {
    const row = await c.env.DB.prepare('SELECT value FROM meta WHERE key = ?')
      .bind(LAST_PRUNE_KEY).first<{ value: string }>()
    freshness = describePruneFreshness(row?.value ?? null)
  } catch (err) {
    db = 'error'
    detail = err instanceof Error ? err.message : String(err)
  }

  return c.json({
    status: db === 'ok' ? 'ok' : 'degraded',
    db,
    detail,
    lastPruneAt: freshness.lastPruneAt,
    pruneAgeHours: freshness.pruneAgeHours,
    time: new Date().toISOString(),
  }, db === 'ok' ? 200 : 503)
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

const tooMany = (c: Context, retryAfterSeconds: number, message = 'Too many reports, please slow down.') =>
  c.json({ error: message }, 429, { 'retry-after': String(Math.max(1, retryAfterSeconds)) })

app.post('/api/report', async c => {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'

  // First line: per-isolate and free. It cannot enforce a global limit, but it
  // absorbs an obvious burst without paying for a Durable Object round trip.
  const local = reportRateLimiter.check(ip)
  if (!local.allowed) return tooMany(c, local.retryAfterSeconds)

  // Second line: the real per-IP limit, global because one Durable Object
  // instance owns the counter for a given address.
  const ipLimit = await consumeIp(c.env, ip)
  if (!ipLimit.allowed) return tooMany(c, ipLimit.retryAfterSeconds)

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
  if (!site) return c.json({ error: 'unknown site key' }, 404)

  // Per-site caps come after the site is known, and before validation: a cap is
  // about how much of our capacity one site may consume, and a malformed body
  // consumes it just the same.
  const siteLimit = await consumeSite(c.env, site.id, site)
  if (!siteLimit.allowed) {
    const blocked = siteLimit.usage.find(u => u.name === siteLimit.blockedWindow)
    if (siteLimit.notify && site.webhook_url && blocked) {
      c.executionCtx.waitUntil(deliverWebhook(
        site.webhook_url,
        buildRateLimitedPayload(site, {
          window: blocked.name, limit: blocked.limit, count: blocked.count, resetAt: blocked.resetAt,
        }),
        site.webhook_secret,
      ))
    }
    return tooMany(c, siteLimit.retryAfterSeconds,
      'This site is not accepting more feedback right now. Please try again later.')
  }

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
    c.executionCtx.waitUntil(
      deliverWebhook(site.webhook_url, buildWebhookPayload(site.name, report), site.webhook_secret),
    )
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
<title>Heard demo</title>
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
  <p>Anything you send here lands in the demo dashboard and is deleted automatically
     after 24 hours, so please do not write anything you would mind losing — or anyone reading.</p>
  <p><code>&lt;script src="/widget.js?key=${site.public_key}" defer&gt;&lt;/script&gt;</code></p>
</div>
<script src="/widget.js?key=${site.public_key}" defer><\/script>
</body></html>`)
})

/* ------------------------------------------------------------- admin API */

/**
 * Machine-facing endpoints for the agent that operates Heard: read feedback
 * about Heard, and triage it, without holding a GitHub session. Scoped by
 * src/admin.ts to Heard's own site and the demo — the shared operator token is
 * deliberately not a key to customers' feedback.
 */
app.get('/api/admin/reports', async c => {
  const auth = authorizeAdmin(c.req.header('authorization'), c.env.ADMIN_TOKEN)
  if (!auth.ok) return c.json({ error: auth.error }, auth.status)

  const parsed = parseAdminReportQuery({
    site: c.req.query('site'),
    since: c.req.query('since'),
    status: c.req.query('status'),
    limit: c.req.query('limit'),
  })
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
  const { site, since, status, limit } = parsed.value

  const conditions = ['site_id = ?']
  const bindings: (string | number)[] = [site]
  if (since !== null) { conditions.push('created_at > ?'); bindings.push(since) }
  if (status !== null) { conditions.push('status = ?'); bindings.push(status) }

  const { results } = await c.env.DB.prepare(
    `SELECT id, site_id, type, message, email, page_url, user_agent, viewport, status, created_at
     FROM reports WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC LIMIT ?`,
  ).bind(...bindings, limit).all<ReportRow>()

  const reports = (results ?? []).map(r => ({ ...r, created_at_iso: new Date(r.created_at).toISOString() }))
  return c.json({ site, count: reports.length, reports })
})

app.post('/api/admin/reports/:id/status', async c => {
  const auth = authorizeAdmin(c.req.header('authorization'), c.env.ADMIN_TOKEN)
  if (!auth.ok) return c.json({ error: auth.error }, auth.status)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'body must be valid JSON' }, 400)
  }
  const parsed = parseAdminStatus((body as Record<string, unknown>)?.status)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

  const report = await c.env.DB.prepare('SELECT id, site_id, status FROM reports WHERE id = ?')
    .bind(c.req.param('id')).first<{ id: string; site_id: string; status: string }>()
  if (!report) return c.json({ error: 'no such report' }, 404)
  // Scope is checked against the row's real site, not against anything the
  // caller supplied, so a report id alone cannot reach a customer's data.
  if (!isAdminAllowedSite(report.site_id)) {
    return c.json({ error: 'that report is out of scope for the admin API' }, 403)
  }

  await c.env.DB.prepare('UPDATE reports SET status = ? WHERE id = ?')
    .bind(parsed.value, report.id).run()
  return c.json({ ok: true, id: report.id, status: parsed.value, previousStatus: report.status })
})

/* -------------------------------------------------------------------- auth */

/**
 * Resolves the current owner from either credential. GitHub OAuth is the normal
 * path; ADMIN_TOKEN is break-glass and maps to the local owner that holds the
 * demo site. Everything downstream reads only `ownerId`, so neither path is
 * privileged over the other once you are through here.
 */
interface ResolvedOwner {
  id: string
  label: string
}

/**
 * Who is calling, or null. Split out from the middleware because `/` needs the
 * answer without enforcing it: signed-in visitors go to their dashboard,
 * everyone else gets the landing page.
 */
async function resolveOwner(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<ResolvedOwner | null> {
  if (c.env.SESSION_SECRET) {
    const ownerId = await verifySession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE))
    if (ownerId) {
      const owner = await c.env.DB.prepare('SELECT * FROM owners WHERE id = ?')
        .bind(ownerId).first<OwnerRow>()
      // A valid signature for a deleted owner is not a session.
      if (owner) return { id: owner.id, label: owner.login ? `@${owner.login}` : 'signed in' }
    }
  }

  const adminCookie = getCookie(c, ADMIN_COOKIE)
  if (c.env.ADMIN_TOKEN && adminCookie && timingSafeEqual(adminCookie, c.env.ADMIN_TOKEN)) {
    return { id: LOCAL_OWNER_ID, label: 'operator' }
  }

  return null
}

const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  // `/sites` matches both registrations below, so this can run twice per
  // request. Resolving once avoids a second owner lookup in D1.
  if (c.get('ownerId')) return await next()

  const owner = await resolveOwner(c)
  if (!owner) return c.redirect('/login', 302)
  c.set('ownerId', owner.id)
  c.set('ownerLabel', owner.label)
  await next()
}

app.get('/login', c => {
  const githubEnabled = Boolean(c.env.GITHUB_OAUTH_CLIENT_ID && c.env.GITHUB_OAUTH_CLIENT_SECRET && c.env.SESSION_SECRET)
  const token = c.req.query('token')
  if (token === undefined) return c.html(loginPage(undefined, githubEnabled))

  if (!c.env.ADMIN_TOKEN) {
    return c.html(loginPage('Token sign-in is not configured on this deployment.', githubEnabled), 500)
  }
  if (!timingSafeEqual(token, c.env.ADMIN_TOKEN)) {
    return c.html(loginPage('That token is not right.', githubEnabled), 401)
  }

  setCookie(c, ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: isHttps(c.req.url),
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.redirect('/sites', 302)
})

app.post('/logout', c => {
  deleteCookie(c, ADMIN_COOKIE, { path: '/' })
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.redirect('/login', 302)
})

const callbackUrl = (reqUrl: string) => `${new URL(reqUrl).origin}/auth/github/callback`

app.get('/auth/github', c => {
  if (!c.env.GITHUB_OAUTH_CLIENT_ID || !c.env.SESSION_SECRET) {
    return c.html(errorPage(500, 'GitHub sign-in is not configured on this deployment.'), 500)
  }
  const state = randomId(24)
  // CSRF guard: the state we get back must match the one we minted. Short-lived
  // and httpOnly so it cannot be planted from another page.
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: isHttps(c.req.url),
    maxAge: 600,
  })
  return c.redirect(githubAuthorizeUrl(c.env.GITHUB_OAUTH_CLIENT_ID, callbackUrl(c.req.url), state), 302)
})

app.get('/auth/github/callback', async c => {
  const { GITHUB_OAUTH_CLIENT_ID: clientId, GITHUB_OAUTH_CLIENT_SECRET: clientSecret, SESSION_SECRET: sessionSecret } = c.env
  if (!clientId || !clientSecret || !sessionSecret) {
    return c.html(errorPage(500, 'GitHub sign-in is not configured on this deployment.'), 500)
  }

  const oauthError = c.req.query('error_description') ?? c.req.query('error')
  if (oauthError) return c.html(loginPage(`GitHub declined the sign-in: ${oauthError}`), 400)

  const code = c.req.query('code')
  const state = c.req.query('state')
  const expectedState = getCookie(c, OAUTH_STATE_COOKIE)
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' })

  if (!code) return c.html(loginPage('GitHub did not send an authorization code.'), 400)
  if (!state || !expectedState || !timingSafeEqual(state, expectedState)) {
    return c.html(loginPage('That sign-in link expired. Please try again.'), 400)
  }

  let owner: { id: string; login: string }
  try {
    const token = await exchangeCodeForToken(clientId, clientSecret, code, callbackUrl(c.req.url))
    const user = await fetchGithubUser(token)
    const externalId = String(user.id)

    const existing = await c.env.DB
      .prepare("SELECT * FROM owners WHERE provider = 'github' AND external_id = ?")
      .bind(externalId).first<OwnerRow>()

    if (existing) {
      // Logins are renameable on GitHub; the numeric id is the identity.
      await c.env.DB.prepare('UPDATE owners SET login = ? WHERE id = ?')
        .bind(user.login, existing.id).run()
      owner = { id: existing.id, login: user.login }
    } else {
      const id = `own_${randomId(12)}`
      await c.env.DB.prepare(
        "INSERT INTO owners (id, provider, external_id, email, login, created_at) VALUES (?, 'github', ?, NULL, ?, ?)",
      ).bind(id, externalId, user.login, Date.now()).run()
      owner = { id, login: user.login }
    }
  } catch (err) {
    console.error('github oauth', err)
    return c.html(loginPage(err instanceof Error ? err.message : 'GitHub sign-in failed.'), 502)
  }

  setCookie(c, SESSION_COOKIE, await createSession(sessionSecret, owner.id), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: isHttps(c.req.url),
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.redirect('/sites', 302)
})

app.use('/sites', requireAuth)
app.use('/sites/*', requireAuth)
app.use('/reports/*', requireAuth)

/* --------------------------------------------------------------- dashboard */

app.get('/', async c => {
  if (await resolveOwner(c)) return c.redirect('/sites', 302)
  return c.html(landingPage(new URL(c.req.url).origin, await selfWidgetKey(c.env)))
})

app.get('/sites', async c => {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM sites WHERE owner_id = ? ORDER BY created_at DESC')
    .bind(c.get('ownerId')).all<SiteRow>()
  return c.html(sitesPage(results ?? [], c.get('ownerLabel'), await selfWidgetKey(c.env)))
})

app.get('/sites/new', async c =>
  c.html(newSitePage(undefined, c.get('ownerLabel'), await selfWidgetKey(c.env))))

app.post('/sites/new', async c => {
  const form = await c.req.formData()
  const name = String(form.get('name') ?? '').trim()
  if (!name) return c.html(newSitePage('Site name is required.', c.get('ownerLabel')), 400)
  if (name.length > 120) return c.html(newSitePage('Site name is too long.', c.get('ownerLabel')), 400)

  const id = newSiteId()
  await c.env.DB.prepare(
    'INSERT INTO sites (id, owner_id, name, public_key, webhook_url, webhook_secret, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
  ).bind(id, c.get('ownerId'), name, newPublicKey(), Date.now()).run()
  return c.redirect(`/sites/${id}`, 302)
})

async function loadSite(c: { env: Env }, id: string, ownerId: string): Promise<SiteRow | null> {
  return await c.env.DB.prepare('SELECT * FROM sites WHERE id = ? AND owner_id = ?')
    .bind(id, ownerId).first<SiteRow>()
}

async function loadReports(c: { env: Env }, siteId: string): Promise<ReportRow[]> {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM reports WHERE site_id = ? ORDER BY created_at DESC LIMIT 200')
    .bind(siteId).all<ReportRow>()
  return results ?? []
}

app.get('/sites/:id', async c => {
  const site = await loadSite(c, c.req.param('id'), c.get('ownerId'))
  if (!site) return c.html(errorPage(404, 'No such site.'), 404)
  return c.html(sitePage(site, await loadReports(c, site.id), new URL(c.req.url).origin, {
    who: c.get('ownerLabel'),
    widgetKey: await selfWidgetKey(c.env),
    usage: (await peekSite(c.env, site.id, site)).usage,
    caps: resolveCaps(site),
    flash: c.req.query('saved') ? { ok: 'Saved.' } : undefined,
  }))
})

app.post('/sites/:id/webhook', async c => {
  const site = await loadSite(c, c.req.param('id'), c.get('ownerId'))
  if (!site) return c.html(errorPage(404, 'No such site.'), 404)

  const form = await c.req.formData()
  const parsed = validateWebhookUrl(String(form.get('webhook_url') ?? ''))
  if (!parsed.ok) {
    return c.html(sitePage(site, await loadReports(c, site.id), new URL(c.req.url).origin, {
      who: c.get('ownerLabel'),
      flash: { error: parsed.error },
    }), 400)
  }
  await c.env.DB.prepare('UPDATE sites SET webhook_url = ? WHERE id = ?')
    .bind(parsed.value, site.id).run()
  return c.redirect(`/sites/${site.id}?saved=1`, 302)
})

app.post('/sites/:id/secret', async c => {
  const site = await loadSite(c, c.req.param('id'), c.get('ownerId'))
  if (!site) return c.html(errorPage(404, 'No such site.'), 404)

  const secret = newWebhookSecret()
  await c.env.DB.prepare('UPDATE sites SET webhook_secret = ? WHERE id = ?').bind(secret, site.id).run()

  // Rendered rather than redirected: a redirect would have to carry the secret
  // in a URL, which lands in history, logs and referrers.
  return c.html(sitePage({ ...site, webhook_secret: secret }, await loadReports(c, site.id),
    new URL(c.req.url).origin, { revealedSecret: secret, who: c.get('ownerLabel') }))
})

app.post('/reports/:id/status', async c => {
  const form = await c.req.formData()
  const status = String(form.get('status') ?? '')
  if (!(REPORT_STATUSES as string[]).includes(status)) {
    return c.html(errorPage(400, 'Unknown status.'), 400)
  }
  // The join on sites is what scopes this to the caller: a report id alone is
  // never enough to touch another owner's data.
  const report = await c.env.DB.prepare(
    `SELECT reports.id AS id, reports.site_id AS site_id FROM reports
     JOIN sites ON sites.id = reports.site_id
     WHERE reports.id = ? AND sites.owner_id = ?`,
  ).bind(c.req.param('id'), c.get('ownerId')).first<{ id: string; site_id: string }>()
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

export { RateLimiterDO } from './rate-limiter-do'

export default {
  fetch: app.fetch,
  /** Daily retention cron; see wrangler.toml [triggers]. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      pruneReports(env).then(result => {
        console.log('retention', JSON.stringify(result))
      }),
    )
  },
} satisfies ExportedHandler<Env>
