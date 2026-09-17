# fbwidget — working notes

Hosted embeddable feedback widget on Cloudflare Workers + D1. See `README.md` for what it is.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars        # sets ADMIN_TOKEN=dev-token
npm run db:migrate:local              # applies migrations/ to the local D1 file
npm run dev                           # wrangler dev on http://localhost:8787
```

No Cloudflare account is needed for local work: `wrangler dev` runs a local
SQLite-backed D1 under `.wrangler/state/` and ignores `database_id` in `wrangler.toml`.

Then:

- <http://localhost:8787/demo> — a plain page with the widget embedded against the
  seeded demo site. Use it to exercise the whole loop.
- <http://localhost:8787/login?token=dev-token> — sign in to the dashboard.
- <http://localhost:8787/sites/site_demo> — where demo reports land.
- <http://localhost:8787/health> — JSON, includes a D1 round-trip check.

## Tests

```bash
npm test          # vitest, pure modules
npm run typecheck # tsc --noEmit
```

The suite covers the pure logic: input validation, rate limiting, webhook payload
shaping and failure-swallowing, and HTML escaping. `test/widget-dom.test.ts` runs the
real widget source inside jsdom — it embeds it the way a host page does and drives the
UI — so widget regressions fail the build rather than the demo.

Route behaviour is verified by hand against `wrangler dev` with curl. If route tests
become worth automating, add `@cloudflare/vitest-pool-workers` rather than mocking D1.

Typechecking runs twice: `tsconfig.json` for Worker code (no `lib.dom`, which would
collide with `@cloudflare/workers-types`) and `tsconfig.dom.json` for the jsdom test.

## Layout

| Path | What lives there |
| --- | --- |
| `src/index.ts` | Hono app: every route, auth middleware, D1 queries |
| `src/widget.ts` | The embeddable widget, as a served-verbatim JS string |
| `src/views.ts` | Server-rendered dashboard HTML + the `esc()` helper |
| `src/validation.ts` | Untrusted-input parsing for reports and webhook URLs |
| `src/ratelimit.ts` | In-memory fixed-window limiter |
| `src/webhook.ts` | Outbound payload shape and delivery |
| `migrations/` | D1 schema; `0002` seeds the demo owner + site |
| `test/` | vitest specs, one per `src/` module, plus the jsdom widget test |

## Conventions

- **Nothing reaches HTML without `esc()`.** Report text is attacker-controlled.
- **Validation lives in `src/validation.ts`, not in route handlers.** Routes translate
  results into status codes; the rules stay pure and unit-testable.
- **`ADMIN_TOKEN` never goes in `wrangler.toml`.** Local: `.dev.vars` (gitignored).
  Production: `wrangler secret put ADMIN_TOKEN`.
- **Auth is deliberately one seam.** `requireAuth` in `src/index.ts` and the hardcoded
  `LOCAL_OWNER_ID` are the only things GitHub OAuth has to replace; `owners` and
  `sites.owner_id` already exist, and owner-scoped queries already filter on them.
- **Owner-scoped queries always filter by `owner_id`** (joining through `sites` when
  starting from a report), so a guessed id is not enough to read or mutate a row.
- Widget source must stay free of backticks and `${` — it is a TS template literal.
  Keep it under 8KB; a test enforces this.
