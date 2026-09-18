# Heard — working notes

Hosted embeddable feedback widget on Cloudflare Workers + D1. See `README.md` for what it is.

## Run it locally

**Node 22 is required** (`.nvmrc`, and `engines` in `package.json`). This machine's nvm
default is deliberately still 20 for other projects, so **run `nvm use` from `app/`**
(it reads `.nvmrc`) or prefix one-offs with `nvm exec 22 …`.

The failure modes differ, which is worth knowing before you debug the wrong thing:

- **`wrangler` hard-refuses** — *"Wrangler requires at least Node.js v22.0.0"* — so
  `dev`, `deploy` and `d1` simply do not run under 20.
- **`vitest` and `tsc` currently run fine on 20** despite declaring Node 22, because npm
  `engines` are advisory unless `engine-strict` is set. Green tests under Node 20 are
  therefore *not* evidence that the toolchain is supported there; CI runs 22, and that is
  the version this project is tested on.

```bash
nvm use            # reads .nvmrc -> 22
npm install
cp .dev.vars.example .dev.vars        # local ADMIN_TOKEN, SESSION_SECRET, OAuth placeholders
npm run db:migrate:local              # applies migrations/ to the local D1 file
npm run dev                           # wrangler dev on http://localhost:8787
```

`npm run dev` passes `--test-scheduled`, which exposes the cron handler at
`GET /__scheduled?cron=17+3+*+*+*` so retention can be run on demand.

No Cloudflare account is needed for local work: `wrangler dev` runs a local
SQLite-backed D1 under `.wrangler/state/`. It never touches the remote database, but the
local file **is keyed by `database_id`** — change that value and local dev silently gets
a fresh empty database, so re-run the migration and you are back.

Then:

- <http://localhost:8787/demo> — a plain page with the widget embedded against the
  seeded demo site. Use it to exercise the whole loop.
- <http://localhost:8787/login> — break-glass operator sign-in. Paste the `ADMIN_TOKEN`
  into the form and submit; sign-in is **POST-only**, because a token in a URL lands in
  history, referrers and proxy logs. A `GET /login?token=…` just renders the form.
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

Typechecking runs three passes, and the split is load-bearing:

- `tsconfig.json` — `src/` with Worker types **only**. Importing `node:crypto` or
  touching `document` in Worker code fails here instead of at runtime.
- `tsconfig.test.json` — tests on Node, so `node:` builtins are allowed.
- `tsconfig.dom.json` — the jsdom test, the only place `lib.dom` is in scope
  (it collides with `@cloudflare/workers-types`).

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

## Changing this repo

`main` is protected: **no direct pushes, no force-pushes, no deletion, and CI must be
green before a merge** — enforced for admins too, so there is no bypass. CI is a gate
now, not a report.

```bash
git switch -c fix/short-description
# ... change, test, commit ...
git push -u origin fix/short-description
gh pr create --fill
gh pr checks --watch                       # wait for CI
gh pr merge --squash --delete-branch
git switch main && git pull
```

The point is S18: the agent that writes the code also holds the deploy credentials, so
a single mistaken step reaches every embedding page. Requiring a green CI run between
"written" and "on main" puts one mechanical check in that path that no amount of
persuasion can skip.

**Deploy is still a separate manual step after merging** — merging does not ship.

## Deploying

All of these run under Node 22 — `nvm use` first, or `nvm exec 22 wrangler …`.

```bash
wrangler d1 create heard                  # once; put database_id in wrangler.toml
wrangler d1 migrations apply heard --remote
wrangler secret put ADMIN_TOKEN           # 32-byte hex, dashboard break-glass
wrangler secret put ADMIN_API_TOKEN       # 32-byte hex, machine credential for /api/admin/*
wrangler secret put SESSION_SECRET        # 32-byte hex
wrangler secret put GITHUB_OAUTH_CLIENT_ID
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
wrangler deploy
```

Deployed at <https://heard.yairms.workers.dev>; the GitHub OAuth app's callback URL is
`https://heard.yairms.workers.dev/auth/github/callback`.
CI runs tests and typecheck only; deploys are manual on purpose.

## Conventions

- **Nothing reaches HTML without `esc()`.** Report text is attacker-controlled.
- **Validation lives in `src/validation.ts`, not in route handlers.** Routes translate
  results into status codes; the rules stay pure and unit-testable.
- **Two admin credentials, deliberately.** `ADMIN_TOKEN` signs a human into the
  dashboard; `ADMIN_API_TOKEN` is the bearer token for `/api/admin/*`. They are separate
  so a leaked sensor credential does not also hand over the dashboard, and so either can
  be rotated alone. Both must be set in production — `/health` reports
  `adminApiTokenSeparate` so you can see at a glance whether they really are.
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
- **`ADMIN_ALLOWED_SITES` in `src/admin.ts` is a security boundary, not a config list.**
  It is the complete set of sites the shared `ADMIN_TOKEN` — and therefore the agent
  operating Heard — may read feedback from or triage. Today that is Heard's own site and
  the public demo. **Adding an entry grants the operating agent read access to that
  site's feedback, so it is a deliberate, reviewed change, never a convenience.** Keep
  the allow-list next to the auth in `src/admin.ts` rather than in route handlers: an
  admin endpoint that forgets to scope itself is a data breach, and that mistake should
  be hard to write rather than easy to miss in review.
- Widget source must stay free of backticks and `${` — it is a TS template literal.
  Keep it under 8KB; a test enforces this.
