/**
 * Two ways in:
 *
 *  - GitHub OAuth, the normal path. Produces a signed, stateless session cookie
 *    naming an `owners` row.
 *  - The shared ADMIN_TOKEN, kept as break-glass: it is how the operator gets
 *    in if the OAuth app is misconfigured, and it maps to the local owner that
 *    already owns the demo site.
 *
 * Sessions are stateless on purpose. A session table would mean a D1 read on
 * every dashboard request to save no real work: revocation for a single-digit
 * number of owners is "rotate SESSION_SECRET", which this design supports for
 * free.
 */

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Constant-time compare that does not leak length either. The earlier version
 * returned immediately on a length mismatch, so timing revealed how long the
 * secret was; here both sides are padded to a fixed width first and the length
 * difference is folded into the result.
 */
const COMPARE_WIDTH = 128

export function timingSafeEqual(a: string, b: string): boolean {
  // The loop must cover *both* strings in full — an earlier version wrapped the
  // index modulo each length and so never compared anything past COMPARE_WIDTH,
  // which made two long tokens differing only in their tail compare equal. It
  // also runs a minimum number of rounds so a short guess does not finish
  // measurably faster than a full-length one.
  const width = Math.max(a.length, b.length, COMPARE_WIDTH)
  let diff = a.length ^ b.length
  for (let i = 0; i < width; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))
}

/** `<ownerId>.<issuedAt>.<hmac>` — no secrets in the cookie, only a name and a proof. */
export async function createSession(secret: string, ownerId: string, now: number = Date.now()): Promise<string> {
  const body = `${ownerId}.${now}`
  return `${body}.${await hmacHex(secret, body)}`
}

export async function verifySession(
  secret: string,
  cookie: string | undefined,
  now: number = Date.now(),
): Promise<string | null> {
  if (!cookie) return null
  const parts = cookie.split('.')
  if (parts.length !== 3) return null
  const [ownerId, issuedAtRaw, signature] = parts

  const issuedAt = Number(issuedAtRaw)
  if (!Number.isFinite(issuedAt)) return null
  // Reject the future too: a clock-skewed or hand-crafted timestamp must not
  // buy an attacker a session that outlives the max age.
  if (issuedAt > now + 60_000) return null
  if (now - issuedAt > SESSION_MAX_AGE_MS) return null

  const expected = await hmacHex(secret, `${ownerId}.${issuedAt}`)
  return timingSafeEqual(expected, signature) ? ownerId : null
}

/* ----------------------------------------------------------------- github */

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_USER_URL = 'https://api.github.com/user'

export function githubAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(GITHUB_AUTHORIZE_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  // Only the public profile: Heard never needs repo or email scopes, and asking
  // for less is the difference between a one-click and a hesitant install.
  url.searchParams.set('scope', 'read:user')
  url.searchParams.set('state', state)
  return url.toString()
}

export interface GithubUser {
  id: number
  login: string
}

export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Heard/1.0' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  })
  const body = (await res.json()) as { access_token?: string; error_description?: string; error?: string }
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `token exchange failed (${res.status})`)
  }
  return body.access_token
}

export async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  const res = await fetch(GITHUB_USER_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'Heard/1.0',
    },
  })
  if (!res.ok) throw new Error(`could not read GitHub profile (${res.status})`)
  const body = (await res.json()) as { id?: number; login?: string }
  if (typeof body.id !== 'number' || typeof body.login !== 'string') {
    throw new Error('unexpected GitHub profile shape')
  }
  return { id: body.id, login: body.login }
}
