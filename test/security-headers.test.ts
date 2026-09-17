import { describe, expect, it } from 'vitest'
import { CSP, PUBLIC_CORS_PATHS, isSameOriginRequest } from '../src/security-headers'

const SELF = 'https://heard.example.com/sites/site_1'

describe('CSP', () => {
  it('denies everything by default and allows only what the app needs', () => {
    expect(CSP).toContain("default-src 'none'")
    expect(CSP).toContain("script-src 'self'")
    expect(CSP).toContain("frame-ancestors 'none'")
    expect(CSP).toContain("base-uri 'none'")
    expect(CSP).toContain("form-action 'self'")
  })

  it("allows inline styles but never inline scripts", () => {
    // The dashboard ships CSS in a <style> block, so styles need unsafe-inline.
    // Scripts must not: that is the difference between a defaced page and an
    // executed payload.
    expect(CSP).toContain("style-src 'unsafe-inline'")
    expect(CSP).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(CSP).not.toMatch(/script-src[^;]*unsafe-eval/)
  })

  it('permits the widget to post back to Heard from Heard-hosted pages', () => {
    expect(CSP).toContain("connect-src 'self'")
  })
})

describe('exempt paths', () => {
  it('exempts exactly the two public endpoints', () => {
    expect(PUBLIC_CORS_PATHS).toEqual(['/widget.js', '/api/report'])
  })
})

describe('isSameOriginRequest', () => {
  it('accepts a matching Origin', () => {
    expect(isSameOriginRequest(SELF, 'https://heard.example.com', undefined)).toBe(true)
  })

  it('refuses a foreign Origin', () => {
    expect(isSameOriginRequest(SELF, 'https://evil.example', undefined)).toBe(false)
  })

  it('refuses lookalike origins', () => {
    for (const origin of [
      'http://heard.example.com',
      'https://heard.example.com:8443',
      'https://heard.example.com.evil.test',
      'https://evilheard.example.com',
    ]) {
      expect(isSameOriginRequest(SELF, origin, undefined)).toBe(false)
    }
  })

  it('falls back to Referer when Origin is absent', () => {
    expect(isSameOriginRequest(SELF, undefined, 'https://heard.example.com/sites')).toBe(true)
    expect(isSameOriginRequest(SELF, undefined, 'https://evil.example/page')).toBe(false)
  })

  it('prefers Origin over Referer when both are present', () => {
    // A forged Referer must not rescue a cross-origin Origin.
    expect(isSameOriginRequest(SELF, 'https://evil.example', 'https://heard.example.com/x')).toBe(false)
  })

  it('refuses when neither header is present', () => {
    // A browser always sends Origin on a cross-site form POST, so a request with
    // neither is a non-browser client and gets no benefit of the doubt.
    expect(isSameOriginRequest(SELF, undefined, undefined)).toBe(false)
  })

  it('refuses garbage rather than throwing', () => {
    expect(isSameOriginRequest(SELF, 'not a url', undefined)).toBe(false)
    expect(isSameOriginRequest(SELF, undefined, 'also not a url')).toBe(false)
  })
})
