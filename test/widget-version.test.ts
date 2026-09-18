import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WIDGET_JS } from '../src/widget'
import { WIDGET_VERSION, widgetBuildHash, widgetIntegrity } from '../src/widget-version'

describe('widget versioning (S18b)', () => {
  it('pins a major version in the path', () => {
    expect(WIDGET_VERSION).toBe('v1')
  })

  it('computes an SRI hash a browser would accept', async () => {
    const integrity = await widgetIntegrity()
    expect(integrity).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/)
    // Verified against an independent implementation: a wrong hash means every
    // embedder's widget silently stops loading.
    const expected = 'sha384-' + createHash('sha384').update(WIDGET_JS).digest('base64')
    expect(integrity).toBe(expected)
  })

  it('changes when the widget changes, and only then', async () => {
    const a = await widgetIntegrity('one')
    expect(await widgetIntegrity('one')).toBe(a)
    expect(await widgetIntegrity('one ')).not.toBe(a)
  })

  it('has a content-addressed build hash', async () => {
    const hash = await widgetBuildHash()
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(await widgetBuildHash()).toBe(hash)
    expect(await widgetBuildHash('different')).not.toBe(hash)
  })

  it('the build hash matches an independent sha256 prefix', async () => {
    const expected = createHash('sha256').update(WIDGET_JS).digest('hex').slice(0, 16)
    expect(await widgetBuildHash()).toBe(expected)
  })
})
