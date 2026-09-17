import { describe, expect, it } from 'vitest'
import {
  MAX_MESSAGE_LENGTH,
  truncateUserAgent,
  validateReportInput,
  validateWebhookUrl,
} from '../src/validation'

const valid = { type: 'bug', message: 'The save button does nothing.' }

describe('validateReportInput', () => {
  it('accepts a minimal report', () => {
    const result = validateReportInput(valid)
    expect(result).toMatchObject({ ok: true, value: { type: 'bug', message: valid.message, email: null } })
  })

  it('rejects a non-object body', () => {
    for (const bad of [null, 'hello', 42, undefined]) {
      expect(validateReportInput(bad)).toMatchObject({ ok: false })
    }
  })

  it.each(['bug', 'idea', 'praise'])('accepts type %s', type => {
    expect(validateReportInput({ ...valid, type })).toMatchObject({ ok: true })
  })

  it.each(['spam', '', 'BUG', 1, null])('rejects type %s', type => {
    expect(validateReportInput({ ...valid, type })).toMatchObject({ ok: false })
  })

  it('requires a non-blank message', () => {
    expect(validateReportInput({ ...valid, message: '   ' })).toMatchObject({ ok: false })
    expect(validateReportInput({ type: 'bug' })).toMatchObject({ ok: false })
  })

  it('trims the message', () => {
    const result = validateReportInput({ ...valid, message: '  hi  ' })
    expect(result).toMatchObject({ ok: true, value: { message: 'hi' } })
  })

  it('accepts a message at the limit and rejects one past it', () => {
    expect(validateReportInput({ ...valid, message: 'a'.repeat(MAX_MESSAGE_LENGTH) })).toMatchObject({ ok: true })
    expect(validateReportInput({ ...valid, message: 'a'.repeat(MAX_MESSAGE_LENGTH + 1) })).toMatchObject({ ok: false })
  })

  it('accepts plausible emails and rejects obvious junk', () => {
    for (const email of ['a@b.co', 'first.last+tag@sub.example.com']) {
      expect(validateReportInput({ ...valid, email })).toMatchObject({ ok: true, value: { email } })
    }
    for (const email of ['nope', 'a@b', 'a@@b.co', 'a b@c.co', '@b.co']) {
      expect(validateReportInput({ ...valid, email })).toMatchObject({ ok: false })
    }
  })

  it('treats a blank email as absent', () => {
    expect(validateReportInput({ ...valid, email: '   ' })).toMatchObject({ ok: true, value: { email: null } })
  })

  it('caps page url and viewport instead of rejecting them', () => {
    const result = validateReportInput({
      ...valid,
      pageUrl: 'https://example.com/?q=' + 'x'.repeat(4000),
      viewport: 'v'.repeat(200),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.pageUrl!.length).toBe(2048)
    expect(result.value.viewport!.length).toBe(32)
  })

  it('accepts snake_case page_url from older widget builds', () => {
    const result = validateReportInput({ ...valid, page_url: 'https://example.com/x' })
    expect(result).toMatchObject({ ok: true, value: { pageUrl: 'https://example.com/x' } })
  })
})

describe('truncateUserAgent', () => {
  it('returns null for missing values', () => {
    expect(truncateUserAgent(undefined)).toBeNull()
    expect(truncateUserAgent('')).toBeNull()
  })
  it('caps long values', () => {
    expect(truncateUserAgent('u'.repeat(900))!.length).toBe(512)
  })
})

describe('validateWebhookUrl', () => {
  it('treats blank as clearing the webhook', () => {
    expect(validateWebhookUrl('')).toEqual({ ok: true, value: null })
    expect(validateWebhookUrl(null)).toEqual({ ok: true, value: null })
  })
  it('accepts http and https public endpoints', () => {
    expect(validateWebhookUrl('https://example.com/hook')).toMatchObject({ ok: true })
    expect(validateWebhookUrl('http://example.com:8787/hook')).toMatchObject({ ok: true })
  })

  it('no longer accepts localhost, which used to be allowed (see test/webhook-safety.test.ts)', () => {
    expect(validateWebhookUrl('http://localhost:8787/hook')).toMatchObject({ ok: false })
  })
  it('rejects other schemes and garbage', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.com', 'not a url']) {
      expect(validateWebhookUrl(url)).toMatchObject({ ok: false })
    }
  })
})
