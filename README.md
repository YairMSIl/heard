# fbwidget

fbwidget is a hosted feedback widget: a site owner pastes one `<script>` tag, and their
visitors get a small "Feedback" button that collects a type (bug / idea / praise), a
message, and an optional email — plus the page URL, user agent, and viewport captured
automatically. Reports land in a dashboard where the owner triages them (new →
in-progress → done) and can point a webhook at any URL to receive each new report as
JSON. It runs entirely on Cloudflare Workers + D1, so a small site costs nothing to host.

## Embed snippet

```html
<script src="https://YOUR-WORKER-HOST/widget.js?key=YOUR_PUBLIC_KEY" defer></script>
```

The public key identifies a site; it grants no read access, so it is safe in page source.
Grab the exact snippet for a site from its dashboard page at `/sites/<id>`.

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

See `CLAUDE.md` for local development.
