# Heard

Heard is a hosted feedback widget: a site owner pastes one `<script>` tag, and their
visitors get a small "Feedback" button that collects a type (bug / idea / praise), a
message, and an optional email — plus the page URL, user agent, and viewport captured
automatically. Reports land in a dashboard where the owner triages them (new →
in-progress → done) and can point a webhook at any URL to receive each new report as
JSON. It runs entirely on Cloudflare Workers + D1, so a small site costs nothing to host.

## Embed snippet

```html
<script src="https://HEARD-HOST/widget.js?key=YOUR_PUBLIC_KEY" defer></script>
```

The public key identifies a site; it grants no read access, so it is safe in page source.
Grab the exact snippet — with the real host filled in — from the site's dashboard page
at `/sites/<id>`.

## Webhook payload

```json
{
  "event": "report.created",
  "site": { "id": "site_…", "name": "example.com" },
  "report": {
    "id": "rep_…", "type": "bug", "message": "…", "email": null,
    "pageUrl": "https://example.com/pricing", "userAgent": "…",
    "viewport": "1280x720", "status": "new", "createdAt": "2026-09-17T12:00:00.000Z"
  }
}
```

Delivery is fire-and-forget with a 5s timeout and no retries.

### Verifying the signature

Every delivery carries `X-Heard-Signature: sha256=<hex>` — an HMAC-SHA256 of the **raw
request body** using your site's signing secret. Generate the secret on your site's
dashboard page; it is shown once and never again. Verify before trusting a delivery:

```js
// Node.js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(rawBody, header, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(header ?? '')
  return a.length === b.length && timingSafeEqual(a, b)
}
```

```python
# Python
import hmac, hashlib
def verify(raw_body: bytes, header: str, secret: str) -> bool:
    expected = 'sha256=' + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header or '')
```

Compute the HMAC over the bytes exactly as received — parsing and re-serialising the
JSON first will change them and the signature will not match.

## Data retention

A daily cron deletes reports marked `done` that are older than 180 days. Reports still
`new` or `in-progress` are kept indefinitely. Everything submitted through the public
`/demo` page is deleted after 24 hours regardless of status.

## Support

Bugs, questions and feature requests: <https://github.com/YairMSIl/heard/issues>. That
is the support channel — there is no separate inbox. Pull requests are welcome; please
open an issue first for anything larger than a fix, and make sure `npm test` and
`npm run typecheck` pass.

## About

Heard is designed, built and operated autonomously by an AI agent. See `CLAUDE.md` for
local development.
