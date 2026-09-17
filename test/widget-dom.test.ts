// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WIDGET_JS } from '../src/widget'

/**
 * Runs the real widget source inside a jsdom page that embeds it exactly the
 * way a host site does, then drives the UI. This is the automated half of "does
 * /widget.js actually render"; the manual half is loading /demo in a browser.
 */
const SRC = 'https://fb.test/widget.js?key=pk_test'

function loadWidget(): ShadowRoot {
  const script = document.createElement('script')
  script.src = SRC
  document.head.appendChild(script)
  // jsdom does not execute src'd scripts, so stand in for the browser: point
  // document.currentScript at our tag and evaluate the source.
  Object.defineProperty(document, 'currentScript', { value: script, configurable: true })
  new Function(WIDGET_JS)()
  const host = document.querySelector('[data-heard]')
  expect(host).not.toBeNull()
  return (host as HTMLElement).shadowRoot!
}

describe('widget in a page', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    // @ts-expect-error resetting the load guard between tests
    delete window.__heard
  })

  it('renders a launcher button into a shadow root, panel closed', () => {
    const root = loadWidget()
    expect(root.querySelector('.btn')!.textContent).toBe('Feedback')
    expect(root.querySelector('.panel')!.classList.contains('open')).toBe(false)
    // Nothing leaks into the host document beyond the single host element.
    expect(document.body.children).toHaveLength(1)
  })

  it('opens the panel and offers all three report types', () => {
    const root = loadWidget()
    ;(root.querySelector('.btn') as HTMLButtonElement).click()
    expect(root.querySelector('.panel')!.classList.contains('open')).toBe(true)
    expect([...root.querySelectorAll('.chip')].map(c => c.getAttribute('data-type')))
      .toEqual(['bug', 'idea', 'praise'])
  })

  it('refuses to send an empty message without calling the API', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const root = loadWidget()
    ;(root.querySelector('.send') as HTMLButtonElement).click()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(root.querySelector('.msg')!.textContent).toMatch(/write a message/i)
    vi.unstubAllGlobals()
  })

  it('POSTs the selected type, message, key and page context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const root = loadWidget()
    ;(root.querySelector('textarea') as HTMLTextAreaElement).value = 'dark mode please'
    ;(root.querySelector('[data-type="idea"]') as HTMLButtonElement).click()
    ;(root.querySelector('.send') as HTMLButtonElement).click()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://fb.test/api/report')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ key: 'pk_test', type: 'idea', message: 'dark mode please', email: null })
    expect(body.pageUrl).toBe(location.href)
    expect(body.viewport).toMatch(/^\d+x\d+$/)

    await vi.waitFor(() => expect(root.querySelector('.msg')!.textContent).toMatch(/thanks/i))
    vi.unstubAllGlobals()
  })

  it('surfaces the server error message to the visitor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Too many reports, please slow down.' }), { status: 429 }),
    ))
    const root = loadWidget()
    ;(root.querySelector('textarea') as HTMLTextAreaElement).value = 'hello'
    ;(root.querySelector('.send') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(root.querySelector('.msg')!.textContent).toMatch(/slow down/))
    vi.unstubAllGlobals()
  })

  it('does not install itself twice', () => {
    loadWidget()
    new Function(WIDGET_JS)()
    expect(document.querySelectorAll('[data-heard]')).toHaveLength(1)
  })
})
