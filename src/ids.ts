const ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789'

/** URL-safe random id with no lookalike characters. */
export function randomId(length = 16): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

export const newSiteId = () => `site_${randomId(12)}`
export const newReportId = () => `rep_${randomId(16)}`
export const newPublicKey = () => `pk_${randomId(24)}`

/**
 * Webhook signing secret. Longer than the ids above because this one is a
 * shared secret rather than a lookup handle: 40 chars of the 33-symbol alphabet
 * is roughly 200 bits.
 */
export const newWebhookSecret = () => `whsec_${randomId(40)}`
