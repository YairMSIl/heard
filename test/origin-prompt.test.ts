import { describe, expect, it } from 'vitest'
import { observedOrigins } from '../src/validation'
import { sitePage } from '../src/views'
import type { SiteRow } from '../src/types'

const site: SiteRow = {
  id: 'site_1', owner_id: 'own_local', name: 'Example', public_key: 'pk_abc',
  webhook_url: null, webhook_secret: null, hourly_cap: null, daily_cap: null,
  allowed_origins: null, webhook_failures: 0, webhook_disabled_at: null,
  webhook_verified_at: null, created_at: 0,
}
const three = ['https://a.example', 'https://b.example', 'https://c.example']

describe('observedOrigins', () => {
  it('reduces page URLs to distinct origins, newest first', () => {
    expect(observedOrigins([
      'https://a.example/one', 'https://a.example/two', 'https://b.example/x',
    ])).toEqual(['https://a.example', 'https://b.example'])
  })

  it('treats scheme, host and port as part of the identity', () => {
    expect(observedOrigins(['https://a.example', 'http://a.example', 'https://a.example:8443']))
      .toHaveLength(3)
  })

  it('drops nulls and anything unparseable rather than guessing', () => {
    expect(observedOrigins([null, '', 'not a url', 'https://ok.example']))
      .toEqual(['https://ok.example'])
  })

  it('ignores non-http schemes a visitor could have supplied', () => {
    // page_url is visitor-controlled, so it can contain anything.
    expect(observedOrigins(['javascript:alert(1)', 'file:///etc/passwd', 'https://ok.example']))
      .toEqual(['https://ok.example'])
  })
})

describe('the origin-lock prompt (S4)', () => {
  it('appears at three distinct origins with no lock set', () => {
    const html = sitePage(site, [], 'https://h.test', { observedOrigins: three })
    expect(html).toMatch(/Reports are arriving from 3 different sites/)
  })

  it('stays hidden below three', () => {
    for (const origins of [[], three.slice(0, 1), three.slice(0, 2)]) {
      expect(sitePage(site, [], 'https://h.test', { observedOrigins: origins }))
        .not.toMatch(/Reports are arriving from/)
    }
  })

  it('stays hidden once a lock exists, however many origins are seen', () => {
    // An owner who already decided does not need to be nagged.
    const locked = { ...site, allowed_origins: 'https://a.example' }
    expect(sitePage(locked, [], 'https://h.test', { observedOrigins: [...three, 'https://d.example'] }))
      .not.toMatch(/Reports are arriving from/)
  })

  it('prefills the textarea with the observed origins', () => {
    const html = sitePage(site, [], 'https://h.test', { observedOrigins: three })
    for (const o of three) expect(html).toContain(o)
    expect(html).toMatch(/<textarea[^>]*name="allowed_origins"[^>]*>https:\/\/a\.example/)
  })

  it('never overwrites an existing lock with observed values', () => {
    const locked = { ...site, allowed_origins: 'https://only-this.example' }
    const html = sitePage(locked, [], 'https://h.test', { observedOrigins: three })
    expect(html).toMatch(/<textarea[^>]*name="allowed_origins"[^>]*>https:\/\/only-this\.example/)
    expect(html).not.toMatch(/<textarea[^>]*>https:\/\/a\.example/)
  })

  it('tells the owner to review rather than trust the list', () => {
    const html = sitePage(site, [], 'https://h.test', { observedOrigins: three })
    // Whitespace-tolerant: the source wraps these sentences across lines, and
    // HTML collapses that anyway — asserting exact spacing would be brittle.
    expect(html.replace(/\s+/g, ' ')).toMatch(/Review it before saving/)
    expect(html.replace(/\s+/g, ' ')).toMatch(/an origin you do not recognise/i)
  })

  it('escapes origins, which come from visitor-supplied page URLs', () => {
    const hostile = ['https://a.example', 'https://b.example', 'https://c.example']
    const html = sitePage(site, [], 'https://h.test', {
      observedOrigins: [...hostile, 'https://x.example/"><script>alert(1)</script>'],
    })
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
