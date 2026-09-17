import { describe, expect, it } from 'vitest'
import { allowedOriginList, isOriginAllowed, parseAllowedOrigins, parseCap } from '../src/validation'

describe('parseAllowedOrigins', () => {
  it('treats empty as "any origin", the documented default', () => {
    for (const input of ['', '   ', null, undefined, 42]) {
      expect(parseAllowedOrigins(input)).toEqual({ ok: true, value: null })
    }
  })

  it('canonicalises to scheme://host[:port] and drops paths', () => {
    expect(parseAllowedOrigins('https://example.com/some/page?q=1'))
      .toEqual({ ok: true, value: 'https://example.com' })
  })

  it('assumes https when no scheme is given', () => {
    expect(parseAllowedOrigins('example.com')).toEqual({ ok: true, value: 'https://example.com' })
  })

  it('keeps an explicit port, because an origin includes it', () => {
    expect(parseAllowedOrigins('http://localhost:3000')).toEqual({ ok: true, value: 'http://localhost:3000' })
  })

  it('accepts newline or comma separated lists and de-duplicates', () => {
    expect(parseAllowedOrigins('https://a.com\nhttps://b.com, https://a.com'))
      .toEqual({ ok: true, value: 'https://a.com\nhttps://b.com' })
  })

  it('rejects non-http schemes', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.com']) {
      expect(parseAllowedOrigins(bad)).toMatchObject({ ok: false })
    }
  })

  it('rejects an unreasonably long list', () => {
    const many = Array.from({ length: 21 }, (_, i) => `https://s${i}.com`).join('\n')
    expect(parseAllowedOrigins(many)).toMatchObject({ ok: false })
  })
})

describe('isOriginAllowed', () => {
  it('allows anything when no list is configured', () => {
    for (const stored of [null, undefined, '', '   ']) {
      expect(isOriginAllowed('https://anywhere.example', stored)).toBe(true)
      expect(isOriginAllowed(undefined, stored)).toBe(true)
    }
  })

  it('allows a listed origin and refuses others', () => {
    const list = 'https://example.com\nhttps://www.example.com'
    expect(isOriginAllowed('https://example.com', list)).toBe(true)
    expect(isOriginAllowed('https://www.example.com', list)).toBe(true)
    expect(isOriginAllowed('https://evil.example', list)).toBe(false)
  })

  it('refuses a missing Origin once a list exists', () => {
    // A plain curl sends no Origin; with a lock configured that is a refusal,
    // not a pass.
    expect(isOriginAllowed(undefined, 'https://example.com')).toBe(false)
    expect(isOriginAllowed(null, 'https://example.com')).toBe(false)
    expect(isOriginAllowed('', 'https://example.com')).toBe(false)
  })

  it('does not fall for lookalike origins', () => {
    const list = 'https://example.com'
    for (const origin of [
      'http://example.com',            // scheme differs
      'https://example.com:8443',      // port differs
      'https://example.com.evil.test', // suffix attack
      'https://evilexample.com',
      'https://sub.example.com',
    ]) {
      expect(isOriginAllowed(origin, list)).toBe(false)
    }
  })

  it('ignores a path or garbage in the Origin header', () => {
    expect(isOriginAllowed('https://example.com/evil', 'https://example.com')).toBe(true)
    expect(isOriginAllowed('not a url', 'https://example.com')).toBe(false)
  })
})

describe('allowedOriginList', () => {
  it('splits and trims, tolerating blank lines', () => {
    expect(allowedOriginList('https://a.com\n\n  https://b.com  \n')).toEqual(['https://a.com', 'https://b.com'])
    expect(allowedOriginList(null)).toEqual([])
  })
})

describe('parseCap', () => {
  it('treats blank as "restore the default"', () => {
    expect(parseCap('')).toEqual({ ok: true, value: null })
    expect(parseCap('   ')).toEqual({ ok: true, value: null })
  })
  it('accepts positive integers', () => {
    expect(parseCap('50')).toEqual({ ok: true, value: 50 })
  })
  it('rejects zero, negatives and non-integers rather than disabling protection', () => {
    for (const bad of ['0', '-5', '1.5', 'lots', '1e3']) {
      expect(parseCap(bad)).toMatchObject({ ok: false })
    }
  })
  it('rejects absurd values', () => {
    expect(parseCap('99999999')).toMatchObject({ ok: false })
  })
})
