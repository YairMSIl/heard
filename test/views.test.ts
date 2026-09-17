import { describe, expect, it } from 'vitest'
import { esc, sitePage } from '../src/views'
import type { ReportRow, SiteRow } from '../src/types'

const site: SiteRow = {
  id: 'site_1', owner_id: 'own_local', name: 'Example', public_key: 'pk_abc',
  webhook_url: null, webhook_secret: null, created_at: 0,
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

  it('shows who is signed in and a sign-out control', () => {
    const html = sitePage(site, [], 'https://h.test', { who: '@octocat' })
    expect(html).toContain('@octocat')
    expect(html).toContain('action="/logout"')
  })
})
