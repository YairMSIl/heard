import { describe, expect, it } from 'vitest'
import { WIDGET_JS } from '../src/widget'

describe('WIDGET_JS', () => {
  it('stays under the 8KB embed budget', () => {
    expect(new TextEncoder().encode(WIDGET_JS).length).toBeLessThan(8192)
  })

  it('is syntactically valid JavaScript', () => {
    expect(() => new Function(WIDGET_JS)).not.toThrow()
  })

  it('isolates itself in a shadow root and guards against double-loading', () => {
    expect(WIDGET_JS).toContain("attachShadow({ mode: 'open' })")
    expect(WIDGET_JS).toContain('window.__heard')
  })

  it('derives the API origin from its own script src', () => {
    expect(WIDGET_JS).toContain("src.origin + '/api/report'")
  })

  it('enforces the same 2000-character cap the server does', () => {
    expect(WIDGET_JS).toContain('maxlength="2000"')
  })
})
