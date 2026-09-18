import { WIDGET_JS } from './widget'

/**
 * The pinned widget major. `/widget/v1.js` is immutable and cached for a year;
 * `/widget.js` stays the moving alias for embedders who want automatic updates.
 *
 * "Immutable" is a promise about *behaviour*, not bytes: a bug fix may change the
 * file, which is why the integrity hash is computed at runtime and shown on the
 * dashboard rather than baked into a snippet we cannot update. A breaking change
 * goes to `/widget/v2.js` instead of mutating v1 — that is the whole point of
 * S18b, since v1 is what limits the blast radius of a bad deploy.
 */
export const WIDGET_VERSION = 'v1'

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** `sha384-…`, the form an embedder pastes into `integrity=`. */
export async function widgetIntegrity(source: string = WIDGET_JS): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-384', new TextEncoder().encode(source))
  return `sha384-${toBase64(new Uint8Array(digest))}`
}

/** Short content hash, for cache-busting the alias and for tests to pin. */
export async function widgetBuildHash(source: string = WIDGET_JS): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
}
