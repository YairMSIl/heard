# Heard — working notes

Hosted embeddable feedback widget on Cloudflare Workers + D1. See `README.md` for what it is.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars        # local ADMIN_TOKEN, SESSION_SECRET, OAuth placeholders
npm run db:migrate:local              # applies migrations/ to the local D1 file
npm run dev                           # wrangler dev on http://localhost:8787
```

`npm run dev` passes `--test-scheduled`, which exposes the cron handler at
`GET /__scheduled?cron=17+3+*+*+*` so retention can be run on demand.

No Cloudflare account is needed for local work: `wrangler dev` runs a local
SQLite-backed D1 under `.wrangler/state/` and ignores `database_id` in `wrangler.toml`.

Then:

- <http://localhost:8787/demo> — a plain page with the widget embedded against the
  seeded demo site. Use it to exercise the whole loop.
- <http://localhost:8787/login?token=dev-token> — break-glass operator sign-in.
  `/auth/github` is the normal path, but completing it locally needs a real OAuth app
  whose callback is `http://localhost:8787/auth/github/callback`.
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
| `src/webhook.ts` | Outbound payload shape, HMAC signing, delivery |
| `src/auth.ts` | Session cookie signing and the GitHub OAuth calls |
| `src/retention.ts` | What the daily cron deletes |
| `migrations/` | D1 schema; `0002` seeds the demo owner + site |
| `test/` | vitest specs, one per `src/` module, plus the jsdom widget test |

## Deploying

```bash
wrangler d1 create heard                  # once; put database_id in wrangler.toml
wrangler d1 migrations apply heard --remote
wrangler secret put ADMIN_TOKEN           # 32-byte hex
wrangler secret put SESSION_SECRET        # 32-byte hex
wrangler secret put GITHUB_OAUTH_CLIENT_ID
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
wrangler deploy
```

The GitHub OAuth app's callback URL must be `<deployed-origin>/auth/github/callback`.
CI runs tests and typecheck only; deploys are manual on purpose.

## Conventions

- **Nothing reaches HTML without `esc()`.** Report text is attacker-controlled.
- **Validation lives in `src/validation.ts`, not in route handlers.** Routes translate
  results into status codes; the rules stay pure and unit-testable.
- **`ADMIN_TOKEN` never goes in `wrangler.toml`.** Local: `.dev.vars` (gitignored).
  Production: `wrangler secret put ADMIN_TOKEN`.
- **Auth resolves an owner, then gets out of the way.** `requireAuth` accepts either a
  signed session cookie (GitHub OAuth, the normal path) or `ADMIN_TOKEN` (break-glass,
  maps to `own_local`). Handlers read only `c.get('ownerId')` and never care which.
- **Sessions are stateless.** `<ownerId>.<issuedAt>.<hmac>` signed with `SESSION_SECRET`;
  rotating that secret signs everyone out, which is the revocation story.
- **A webhook secret is shown exactly once**, on the response that generates it. Never
  add a route or a render path that prints an existing secret.
- **Owner-scoped queries always filter by `owner_id`** (joining through `sites` when
  starting from a report), so a guessed id is not enough to read or mutate a row.
- Widget source must stay free of backticks and `${` — it is a TS template literal.
  Keep it under 8KB; a test enforces this.
