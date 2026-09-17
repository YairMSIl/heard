import { isPrivateHostname } from './validation'

const DOH_URL = 'https://cloudflare-dns.com/dns-query'
const TIMEOUT_MS = 5000

/**
 * Resolves a webhook hostname and refuses non-public answers.
 *
 * This closes the "textual guard only" hole: `127.0.0.1.nip.io` looks like an
 * ordinary name but resolves to loopback. It does **not** close DNS rebinding —
 * an attacker can answer with a public address here and repoint the name
 * afterwards. The periodic re-challenge from the cron is what limits that
 * window, and the residual is accepted deliberately rather than papered over:
 * a Worker cannot pin the address it later connects to.
 */
export async function resolvesToPublicAddress(
  hostname: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // A literal address never needed resolving; the textual guard already ruled.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return { ok: true }

  const answers: string[] = []
  for (const type of ['A', 'AAAA']) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
        signal: abort.signal,
      })
      if (!res.ok) return { ok: false, error: `could not resolve ${hostname}` }
      const body = (await res.json()) as { Answer?: { type: number; data: string }[] }
      // type 1 = A, 28 = AAAA. CNAME answers are followed by the resolver, so
      // only the address records matter here.
      for (const a of body.Answer ?? []) {
        if (a.type === 1 || a.type === 28) answers.push(a.data)
      }
    } catch {
      return { ok: false, error: `could not resolve ${hostname}` }
    } finally {
      clearTimeout(timer)
    }
  }

  if (answers.length === 0) {
    return { ok: false, error: `${hostname} does not resolve to any address` }
  }
  const bad = answers.find(addr => isPrivateHostname(addr))
  if (bad) {
    return { ok: false, error: `${hostname} resolves to a private address (${bad})` }
  }
  return { ok: true }
}
