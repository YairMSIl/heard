import { describe, expect, it } from 'vitest'
import { esc, landingPage, newSitePage, sitePage, sitesPage } from '../src/views'
import type { ReportRow, SiteRow } from '../src/types'

const site: SiteRow = {
  id: 'site_1', owner_id: 'own_local', name: 'Example', public_key: 'pk_abc',
  webhook_url: null, webhook_secret: null, hourly_cap: null, daily_cap: null, allowed_origins: null,
  webhook_failures: 0, webhook_disabled_at: null, webhook_verified_at: null, created_at: 0,
}

describe('esc', () => {
  it('escapes every HTML-significant character', () => {
    expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
  it('renders null and undefined as empty', () => {
    expect(esc(null)).toBe('')
    expect(esc(undefined)).toBe('')
  })
})

describe('sitePage', () => {
  const hostile: ReportRow = {
    id: 'rep_1', site_id: 'site_1', type: 'bug',
    message: '<img src=x onerror=alert(1)>', email: null,
    page_url: '"><script>alert(2)</script>', user_agent: null, viewport: null,
    status: 'new', created_at: 0,
  }

  it('escapes attacker-controlled report fields', () => {
    const html = sitePage(site, [hostile], 'http://localhost:8787')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>alert(2)')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('includes an embed snippet for the site key', () => {
    const html = sitePage(site, [], 'https://heard.example.com')
    expect(html).toContain('https://heard.example.com/widget.js?key=pk_abc')
  })

  it('shows a signing secret only on the response that generated it', () => {
    const secret = 'whsec_supersecretvalue'
    const revealed = sitePage({ ...site, webhook_secret: secret }, [], 'https://h.test', { revealedSecret: secret })
    expect(revealed).toContain(secret)
    expect(revealed).toMatch(/not shown again/i)

    // A later page load knows a secret exists but never reprints it.
    const later = sitePage({ ...site, webhook_secret: secret }, [], 'https://h.test')
    expect(later).not.toContain(secret)
    expect(later).toMatch(/signing secret is set/i)
  })

  it('offers to generate a secret when the site has none', () => {
    expect(sitePage(site, [], 'https://h.test')).toContain('Generate secret')
    expect(sitePage({ ...site, webhook_secret: 'whsec_x' }, [], 'https://h.test')).toContain('Regenerate secret')
  })

  it('shows usage against the caps when the limiter answered', () => {
    const html = sitePage(site, [], 'https://h.test', {
      usage: [
        { name: 'hour', count: 4, limit: 30, resetAt: Date.parse('2026-09-17T20:00:00Z') },
        { name: 'day', count: 12, limit: 200, resetAt: Date.parse('2026-09-18T00:00:00Z') },
      ],
      caps: { hourly: 30, daily: 200 },
    })
    expect(html).toContain('of 30 this hour')
    expect(html).toContain('of 200 this day')
    expect(html).toContain('2026-09-17 20:00 UTC')
  })

  it('says so plainly when usage could not be read, rather than showing zero', () => {
    // Zero would read as "no traffic", which is a different and wrong claim.
    const html = sitePage(site, [], 'https://h.test', { caps: { hourly: 30, daily: 200 } })
    expect(html).toMatch(/usage is unavailable/i)
    expect(html).toContain('30/hour and 200/day')
  })

  it('warns on the dashboard when a webhook was auto-disabled', () => {
    const html = sitePage({ ...site, webhook_disabled_at: Date.parse('2026-09-17T12:00:00Z') }, [], 'https://h.test')
    expect(html).toMatch(/switched off after 10 consecutive failed deliveries/)
    expect(html).toContain('2026-09-17 12:00')
  })

  it('says nothing about disabling when the webhook is healthy', () => {
    expect(sitePage(site, [], 'https://h.test')).not.toMatch(/switched off/)
  })

  it('shows who is signed in and a sign-out control', () => {
    const html = sitePage(site, [], 'https://h.test', { who: '@octocat' })
    expect(html).toContain('@octocat')
    expect(html).toContain('action="/logout"')
  })
})

describe('landingPage', () => {
  const html = landingPage('https://heard.example.com')

  it('leads with what Heard is, not a sign-up wall', () => {
    expect(html).toMatch(/hosted feedback widget/i)
    expect(html).toContain('bug, idea or')
  })

  it('shows the embed snippet with a placeholder key, escaped', () => {
    expect(html).toContain('https://heard.example.com/widget.js?key=YOUR_PUBLIC_KEY')
    // The snippet must render as text, not execute as a tag: the placeholder
    // key may never appear inside a live <script src="...">.
    expect(html).toContain('&lt;script src=')
    expect(html).not.toMatch(/<script src="[^"]*YOUR_PUBLIC_KEY/)
  })

  it('offers GitHub sign-in and the demo', () => {
    expect(html).toContain('href="/auth/github"')
    expect(html).toContain('href="/demo"')
  })

  it('discloses the AI operator and links the repo and support channel', () => {
    expect(html).toMatch(/operated autonomously by an AI agent/i)
    expect(html).toContain('https://github.com/YairMSIl/heard')
    expect(html).toContain('https://github.com/YairMSIl/heard/issues')
  })

  it('does not show the signed-in navigation', () => {
    expect(html).not.toContain('href="/sites"')
  })

  it('carries no widget when the self site does not exist', () => {
    expect(html).not.toContain('<script src="/widget.js')
    expect(html).not.toMatch(/Feedback button in the corner/)
  })
})

describe('the self-feedback widget (dogfooding)', () => {
  const key = 'pk_selfsite123'

  it('embeds a live widget tag on the landing page when a key is given', () => {
    const html = landingPage('https://heard.example.com', key)
    expect(html).toContain(`<script src="/widget.js?key=${key}" defer></script>`)
    expect(html).toMatch(/Feedback button in the corner/)
  })

  it('embeds it on the dashboard pages too', () => {
    expect(sitesPage([], '@octocat', key)).toContain(`/widget.js?key=${key}`)
    expect(newSitePage(undefined, '@octocat', key)).toContain(`/widget.js?key=${key}`)
    expect(sitePage(site, [], 'https://h.test', { widgetKey: key })).toContain(`/widget.js?key=${key}`)
  })

  it('omits it everywhere when there is no self site', () => {
    for (const html of [
      landingPage('https://h.test', null),
      sitesPage([], '@octocat', null),
      newSitePage(undefined, '@octocat', null),
      sitePage(site, [], 'https://h.test', {}),
    ]) {
      expect(html).not.toContain('<script src="/widget.js')
    }
  })

  it('url-encodes the key rather than trusting it into an attribute', () => {
    const html = landingPage('https://h.test', 'pk_a b"c')
    expect(html).toContain('/widget.js?key=pk_a%20b%22c')
    expect(html).not.toContain('pk_a b"c')
  })
})
