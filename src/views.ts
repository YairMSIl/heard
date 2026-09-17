import type { ReportRow, SiteRow } from './types'
import { allowedOriginList } from './validation'
import type { WindowUsage } from './limits'

/** Every interpolation into HTML goes through this. No exceptions. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const STYLES = `
  :root{--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#f9fafb;--accent:#111827}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{background:#fff;border-bottom:1px solid var(--line)}
  header .in{max-width:860px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:14px}
  header a{color:var(--muted);text-decoration:none;font-size:14px}
  header a:hover{color:var(--ink)}
  .brand{font-weight:700;color:var(--ink);font-size:16px}
  main{max-width:860px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:22px;margin:0 0 4px}
  h2{font-size:15px;margin:28px 0 10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  .sub{color:var(--muted);margin:0 0 20px}
  .card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:12px}
  .card.tight{padding:12px 16px}
  a.site{display:block;text-decoration:none;color:inherit}
  a.site:hover{border-color:#9ca3af}
  label{display:block;font-size:13px;font-weight:600;margin:0 0 5px}
  input[type=text],input[type=url],input[type=password],textarea{width:100%;padding:9px;border:1px solid #d1d5db;border-radius:8px;font:inherit}
  textarea{min-height:70px;resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:13px}
  button{border:0;border-radius:8px;background:var(--accent);color:#fff;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
  button.ghost{background:#fff;color:var(--ink);border:1px solid #d1d5db;padding:5px 10px;font-size:13px;font-weight:500}
  button.ghost[aria-pressed=true]{background:var(--ink);color:#fff;border-color:var(--ink)}
  form.inline{display:inline}
  pre{background:#0b1020;color:#e5e7eb;padding:12px;border-radius:8px;overflow:auto;font-size:13px;margin:0}
  .meta{color:var(--muted);font-size:12.5px}
  .msg{white-space:pre-wrap;margin:6px 0 10px}
  .tag{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:5px;background:#eef2ff;color:#3730a3}
  .tag.bug{background:#fee2e2;color:#991b1b}
  .tag.idea{background:#e0e7ff;color:#3730a3}
  .tag.praise{background:#d1fae5;color:#065f46}
  .st{font-size:12px;color:var(--muted)}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .between{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
  .empty{color:var(--muted);padding:24px;text-align:center}
  .err{background:#fee2e2;color:#991b1b;padding:10px 14px;border-radius:8px;margin-bottom:16px}
  .who{margin-left:auto;color:var(--muted);font-size:13px;display:flex;align-items:center;gap:10px}
  .who button{background:none;color:var(--muted);border:0;padding:0;font-size:13px;font-weight:500;text-decoration:underline;cursor:pointer}
  .gh{display:inline-flex;align-items:center;gap:8px;background:#111827;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600}
  .or{color:var(--muted);font-size:13px;margin:22px 0 10px;text-align:center}
  .secret{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all;background:#0b1020;color:#e5e7eb;padding:10px;border-radius:8px}
  details summary{cursor:pointer;color:var(--muted);font-size:13px}
  .usage{margin-bottom:12px}
  .usage:last-of-type{margin-bottom:6px}
  .bar{height:6px;border-radius:3px;background:#e5e7eb;overflow:hidden;margin-top:6px}
  .bar span{display:block;height:100%;background:var(--ink)}
  .hero{padding:64px 0 8px}
  .hero h1{font-size:40px;line-height:1.1;letter-spacing:-.02em;margin:0 0 14px}
  .lede{font-size:17px;color:#374151;max-width:38em;margin:0 0 28px}
  .cta{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
  .cta a.ghost-link{color:var(--ink);text-decoration:none;border:1px solid #d1d5db;background:#fff;padding:11px 18px;border-radius:8px;font-weight:600}
  .cta a.ghost-link:hover{border-color:#9ca3af}
  .colophon{border-top:1px solid var(--line);margin-top:44px;padding-top:18px;color:var(--muted);font-size:13.5px}
  .colophon a{color:var(--muted)}
  .steps{list-style:none;padding:0;margin:0;counter-reset:s}
  .steps li{counter-increment:s;padding:0 0 14px 34px;position:relative;color:#374151}
  .steps li::before{content:counter(s);position:absolute;left:0;top:0;width:22px;height:22px;border-radius:50%;background:var(--ink);color:#fff;font-size:12px;font-weight:700;display:grid;place-items:center}
  .ok{background:#d1fae5;color:#065f46;padding:10px 14px;border-radius:8px;margin-bottom:16px}
`

export function layout(
  title: string,
  body: string,
  opts: { nav?: boolean; who?: string | null; widgetKey?: string | null } = {},
): string {
  const who = opts.who
    ? `<span class="who">${esc(opts.who)}
         <form method="post" action="/logout"><button type="submit">Sign out</button></form>
       </span>`
    : ''
  const nav = opts.nav === false ? '' : `
    <header><div class="in">
      <span class="brand">Heard</span>
      <a href="/sites">Sites</a>
      <a href="/demo">Demo</a>
      <a href="/health">Health</a>
      ${who}
    </div></header>`
  // Heard collecting feedback about Heard. Rendered only when the self site
  // exists; a deployment without it simply has no widget rather than a broken
  // script tag pointing at a key that resolves to nothing.
  const widget = opts.widgetKey
    ? `<script src="/widget.js?key=${encodeURIComponent(opts.widgetKey)}" defer><\/script>`
    : ''
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Heard</title>
<style>${STYLES}</style>
</head><body>${nav}<main>${body}</main>${widget}</body></html>`
}

export function loginPage(error?: string, githubEnabled = true): string {
  return layout('Sign in', `
    <h1>Sign in to Heard</h1>
    <p class="sub">Heard only asks GitHub for your public profile — no repository access.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    ${githubEnabled
      ? `<p><a class="gh" href="/auth/github">Continue with GitHub</a></p>
         <p class="or">or use the operator token</p>`
      : `<div class="err">GitHub sign-in is not configured on this deployment.</div>`}
    <form class="card" method="get" action="/login">
      <label for="token">Operator token</label>
      <input id="token" name="token" type="password" autocomplete="current-password">
      <p><button type="submit">Sign in with token</button></p>
    </form>`, { nav: false })
}

export function sitesPage(sites: SiteRow[], who?: string | null, widgetKey?: string | null): string {
  const list = sites.length
    ? sites.map(s => `
        <a class="site card tight" href="/sites/${esc(s.id)}">
          <div class="between"><strong>${esc(s.name)}</strong>
          <span class="meta">${esc(s.public_key)}</span></div>
        </a>`).join('')
    : '<div class="card empty">No sites yet. Create your first one.</div>'
  return layout('Sites', `
    <div class="between"><h1>Sites</h1><a href="/sites/new"><button>New site</button></a></div>
    <p class="sub">Each site gets a public key and its own embed snippet.</p>
    ${list}`, { who, widgetKey })
}

export function newSitePage(error?: string, who?: string | null, widgetKey?: string | null): string {
  return layout('New site', `
    <h1>New site</h1>
    <p class="sub">A public key is generated for you.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form class="card" method="post" action="/sites/new">
      <label for="name">Site name</label>
      <input id="name" name="name" type="text" placeholder="example.com" required autofocus>
      <p><button type="submit">Create site</button></p>
    </form>`, { who, widgetKey })
}

function reportCard(report: ReportRow): string {
  const when = new Date(report.created_at).toISOString().replace('T', ' ').slice(0, 16)
  const statuses = ['new', 'in-progress', 'done']
  const buttons = statuses.map(s => `
    <form class="inline" method="post" action="/reports/${esc(report.id)}/status">
      <input type="hidden" name="status" value="${esc(s)}">
      <button class="ghost" type="submit" aria-pressed="${s === report.status}">${esc(s)}</button>
    </form>`).join('')
  return `<div class="card">
    <div class="between">
      <span><span class="tag ${esc(report.type)}">${esc(report.type)}</span></span>
      <span class="meta">${esc(when)} UTC</span>
    </div>
    <p class="msg">${esc(report.message)}</p>
    <p class="meta">
      ${report.email ? `<a href="mailto:${esc(report.email)}">${esc(report.email)}</a> · ` : ''}
      ${report.page_url ? `${esc(report.page_url)} · ` : ''}
      ${report.viewport ? `${esc(report.viewport)} · ` : ''}
      ${esc(report.user_agent ?? '')}
    </p>
    <div class="row">${buttons}</div>
  </div>`
}

export interface SitePageOptions {
  /** Current rate-limit consumption, read without incrementing. */
  usage?: WindowUsage[]
  caps?: { hourly: number; daily: number }
  /** Present only on the one response that created it; never re-readable. */
  revealedSecret?: string | null
  who?: string | null
  widgetKey?: string | null
  flash?: { ok?: string; error?: string }
}

export function sitePage(
  site: SiteRow,
  reports: ReportRow[],
  origin: string,
  opts: SitePageOptions = {},
): string {
  const { revealedSecret, who, widgetKey, usage, caps, flash } = opts
  const snippet = `<script src="${origin}/widget.js?key=${site.public_key}" defer><\/script>`
  const list = reports.length
    ? reports.map(reportCard).join('')
    : '<div class="card empty">No reports yet. Try the widget on your site or on <a href="/demo">/demo</a>.</div>'

  // The secret is shown exactly once, on the response that generated it. After
  // that the dashboard can only tell you whether one exists — storing it and
  // re-displaying it would turn every dashboard page load into a place to leak it.
  const secretBlock = revealedSecret
    ? `<div class="ok">Copy this signing secret now — it is not shown again.</div>
       <p class="secret">${esc(revealedSecret)}</p>`
    : `<p class="meta">${site.webhook_secret
        ? 'A signing secret is set. Regenerate it if it leaked — deliveries signed with the old secret stop verifying immediately.'
        : 'No signing secret yet. Generate one so your endpoint can verify that a delivery really came from Heard.'}</p>`

  return layout(site.name, `
    <div class="between"><h1>${esc(site.name)}</h1><a href="/sites" class="meta">← all sites</a></div>
    <p class="sub">Public key <code>${esc(site.public_key)}</code></p>
    ${flash?.ok ? `<div class="ok">${esc(flash.ok)}</div>` : ''}
    ${flash?.error ? `<div class="err">${esc(flash.error)}</div>` : ''}

    <h2>Embed snippet</h2>
    <div class="card"><pre>${esc(snippet)}</pre></div>

    <h2>Settings</h2>
    <form class="card" method="post" action="/sites/${esc(site.id)}/settings">
      <label for="allowed_origins">Allowed origins (one per line)</label>
      <textarea id="allowed_origins" name="allowed_origins" rows="3"
        placeholder="https://example.com&#10;https://www.example.com">${esc(allowedOriginList(site.allowed_origins).join('\n'))}</textarea>
      <p class="meta">Leave empty to accept reports from anywhere, which is the default.
        Locking the key to your domains stops someone lifting it from your page source and
        filing reports from elsewhere. It raises the cost of abuse rather than removing it:
        a non-browser client can claim any origin it likes.</p>
      <div class="row">
        <div style="flex:1">
          <label for="hourly_cap">Hourly cap</label>
          <input id="hourly_cap" name="hourly_cap" type="text" inputmode="numeric"
            placeholder="${esc(caps?.hourly ?? 30)} (default)" value="${esc(site.hourly_cap ?? '')}">
        </div>
        <div style="flex:1">
          <label for="daily_cap">Daily cap</label>
          <input id="daily_cap" name="daily_cap" type="text" inputmode="numeric"
            placeholder="${esc(caps?.daily ?? 200)} (default)" value="${esc(site.daily_cap ?? '')}">
        </div>
      </div>
      <p class="meta">Blank restores the default. Lowering a cap takes effect immediately,
        so a site already past the new limit stops accepting reports until the window resets.</p>
      <p><button type="submit">Save settings</button></p>
    </form>

    <h2>Webhook</h2>
    <form class="card" method="post" action="/sites/${esc(site.id)}/webhook">
      <label for="webhook_url">POST each new report to this URL (optional)</label>
      <input id="webhook_url" name="webhook_url" type="url" placeholder="https://example.com/hooks/feedback"
             value="${esc(site.webhook_url ?? '')}">
      <p><button type="submit">Save webhook</button></p>
    </form>

    <h2>Signing secret</h2>
    <div class="card">
      ${secretBlock}
      <p class="meta">Each delivery carries
        <code>X-Heard-Signature: sha256=&lt;hex&gt;</code>, an HMAC-SHA256 of the raw
        request body.</p>
      <form method="post" action="/sites/${esc(site.id)}/secret">
        <button type="submit">${site.webhook_secret ? 'Regenerate secret' : 'Generate secret'}</button>
      </form>
    </div>

    <h2>Submission limits</h2>
    ${usageBlock(usage, caps)}

    <h2>Reports (${reports.length})</h2>
    ${list}`, { who, widgetKey })
}

/**
 * Shows what the site has spent against its caps. Rendered from a read-only
 * peek at the limiter, so opening the dashboard never consumes a visitor's
 * budget.
 */
function usageBlock(usage: WindowUsage[] | undefined, caps?: { hourly: number; daily: number }): string {
  if (!usage?.length) {
    return `<div class="card"><p class="meta">Limits are
      ${caps ? `${esc(caps.hourly)}/hour and ${esc(caps.daily)}/day` : 'at their defaults'},
      but current usage is unavailable right now.</p></div>`
  }
  const rows = usage.map(u => {
    const pct = u.limit > 0 ? Math.min(100, Math.round((u.count / u.limit) * 100)) : 0
    const resets = new Date(u.resetAt).toISOString().replace('T', ' ').slice(0, 16)
    return `<div class="usage">
      <div class="between"><span><strong>${esc(u.count)}</strong> of ${esc(u.limit)} this ${esc(u.name)}</span>
      <span class="meta">resets ${esc(resets)} UTC</span></div>
      <div class="bar"><span style="width:${pct}%"></span></div>
    </div>`
  }).join('')
  return `<div class="card">${rows}
    <p class="meta">Reports beyond a cap are refused with a 429 while the window is full.
      Visitors see a short "try again later" message; nothing is lost silently on our side.</p>
  </div>`
}

export const REPO_URL = 'https://github.com/YairMSIl/heard'
export const ISSUES_URL = `${REPO_URL}/issues`

/**
 * What a signed-out visitor sees at `/`. Deliberately a single screen: the
 * embed snippet is the product, so it appears above the fold rather than
 * behind a sign-up.
 */
export function landingPage(origin: string, widgetKey?: string | null): string {
  const snippet = `<script src="${origin}/widget.js?key=YOUR_PUBLIC_KEY" defer><\/script>`
  return layout('Feedback your visitors can actually send', `
    <div class="hero">
      <h1>Feedback your visitors<br>can actually send.</h1>
      <p class="lede">
        Heard is a hosted feedback widget. Paste one script tag and a small
        &ldquo;Feedback&rdquo; button appears on your site: visitors pick bug, idea or
        praise, write a message, and optionally leave an email. Heard captures the page
        URL, browser and viewport for you, and the report lands in a dashboard where you
        can work it from new to done &mdash; or forward it straight to your own endpoint
        with a signed webhook.
      </p>
      <div class="cta">
        <a class="gh" href="/auth/github">Sign in with GitHub</a>
        <a class="ghost-link" href="/demo">See it on a live page</a>
      </div>
    </div>

    <h2>How it works</h2>
    <div class="card">
      <ol class="steps">
        <li>Sign in with GitHub and add your site &mdash; you get a public key.</li>
        <li>Paste the snippet into your page, once, anywhere before <code>&lt;/body&gt;</code>.</li>
        <li>Read and triage what comes in.</li>
      </ol>
      <pre>${esc(snippet)}</pre>
      <p class="meta">The public key only identifies your site and grants no read access,
        so it is safe in page source.</p>
    </div>

    <p class="colophon">
      Heard is designed, built, deployed and operated autonomously by an AI agent &mdash;
      the source is public at <a href="${REPO_URL}">github.com/YairMSIl/heard</a>.
      Support: <a href="${ISSUES_URL}">GitHub Issues</a>.
      ${widgetKey ? 'Found a problem on this page? The Feedback button in the corner reports it to Heard itself.' : ''}
    </p>`, { nav: false, widgetKey })
}

export function errorPage(status: number, message: string): string {
  return layout(`${status}`, `<h1>${status}</h1><p class="sub">${esc(message)}</p>`)
}
