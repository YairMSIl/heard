import type { ReportRow, SiteRow } from './types'

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
  input[type=text],input[type=url],input[type=password]{width:100%;padding:9px;border:1px solid #d1d5db;border-radius:8px;font:inherit}
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
  .ok{background:#d1fae5;color:#065f46;padding:10px 14px;border-radius:8px;margin-bottom:16px}
`

export function layout(title: string, body: string, opts: { nav?: boolean } = {}): string {
  const nav = opts.nav === false ? '' : `
    <header><div class="in">
      <span class="brand">fbwidget</span>
      <a href="/sites">Sites</a>
      <a href="/demo">Demo</a>
      <a href="/health">Health</a>
    </div></header>`
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · fbwidget</title>
<style>${STYLES}</style>
</head><body>${nav}<main>${body}</main></body></html>`
}

export function loginPage(error?: string): string {
  return layout('Sign in', `
    <h1>Sign in</h1>
    <p class="sub">MVP auth: the shared admin token. GitHub OAuth replaces this later.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form class="card" method="get" action="/login">
      <label for="token">Admin token</label>
      <input id="token" name="token" type="password" autocomplete="current-password" autofocus>
      <p><button type="submit">Sign in</button></p>
    </form>`, { nav: false })
}

export function sitesPage(sites: SiteRow[]): string {
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
    ${list}`)
}

export function newSitePage(error?: string): string {
  return layout('New site', `
    <h1>New site</h1>
    <p class="sub">A public key is generated for you.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form class="card" method="post" action="/sites/new">
      <label for="name">Site name</label>
      <input id="name" name="name" type="text" placeholder="example.com" required autofocus>
      <p><button type="submit">Create site</button></p>
    </form>`)
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

export function sitePage(
  site: SiteRow,
  reports: ReportRow[],
  origin: string,
  flash?: { ok?: string; error?: string },
): string {
  const snippet = `<script src="${origin}/widget.js?key=${site.public_key}" defer><\/script>`
  const list = reports.length
    ? reports.map(reportCard).join('')
    : '<div class="card empty">No reports yet. Try the widget on your site or on <a href="/demo">/demo</a>.</div>'
  return layout(site.name, `
    <div class="between"><h1>${esc(site.name)}</h1><a href="/sites" class="meta">← all sites</a></div>
    <p class="sub">Public key <code>${esc(site.public_key)}</code></p>
    ${flash?.ok ? `<div class="ok">${esc(flash.ok)}</div>` : ''}
    ${flash?.error ? `<div class="err">${esc(flash.error)}</div>` : ''}

    <h2>Embed snippet</h2>
    <div class="card"><pre>${esc(snippet)}</pre></div>

    <h2>Webhook</h2>
    <form class="card" method="post" action="/sites/${esc(site.id)}/webhook">
      <label for="webhook_url">POST each new report to this URL (optional)</label>
      <input id="webhook_url" name="webhook_url" type="url" placeholder="https://example.com/hooks/feedback"
             value="${esc(site.webhook_url ?? '')}">
      <p><button type="submit">Save webhook</button></p>
    </form>

    <h2>Reports (${reports.length})</h2>
    ${list}`)
}

export function errorPage(status: number, message: string): string {
  return layout(`${status}`, `<h1>${status}</h1><p class="sub">${esc(message)}</p>`)
}
