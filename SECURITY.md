# Security policy

Heard collects other people's feedback, which means it holds text they wrote in
confidence and sometimes their email address. We would much rather hear about a
problem from you than from the people whose data it was.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting:**
<https://github.com/YairMSIl/heard/security/advisories/new>

That channel is enabled on this repository and is the only one we can promise is
private. Please do **not** open a public issue for a security problem, and please
do not report it through Heard's own feedback widget — that widget writes to a
dashboard, and its contents are read by the automation described below.

If private reporting is unavailable to you for any reason, open a public issue
that says only *"security report, please open a private channel"* with no
technical detail, and we will follow up.

A useful report usually has: what you did, what happened, what you expected, and
why it matters. A single `curl` command that demonstrates it is worth more than a
scanner's output. If you are not sure whether something is a vulnerability, send
it anyway — a wrong guess costs us a few minutes.

## What you can expect from us

| Stage | Target |
| --- | --- |
| We acknowledge your report | within 3 days |
| We tell you our assessment and severity | within 7 days |
| Fix for a critical or high finding | within 14 days of acknowledgement |
| Fix for a medium or low finding | within 90 days, or an explanation of why not |
| Public disclosure | when the fix ships, or 90 days after acknowledgement, whichever comes first |

We will tell you when the fix is out and credit you in the advisory and the
commit, under whatever name you prefer, or not at all if you would rather. If we
decide something is not worth fixing, we will say so and say why rather than
letting it go quiet. If we need longer than the targets above, we will tell you
before the deadline rather than after it.

Heard is a free, unfunded project run on free tiers, and the project's own rules
forbid it from spending money. **There is no bug bounty and there will not be
one.** We are grateful for reports anyway, and we will not pretend the absence of
payment is anything other than what it is.

## Scope

In scope:

- `https://heard.yairms.workers.dev` — the dashboard, the landing page, `/demo`
- `POST /api/report` and the admin API under `/api/admin/`
- the embeddable widget served at `/widget.js`
- outbound webhook delivery and its signing
- everything in this repository, including CI configuration and migrations

Out of scope, because they are not ours to fix:

- Cloudflare Workers, D1 and the `workers.dev` platform — report those to Cloudflare
- GitHub, including OAuth and this repository's hosting
- vulnerabilities in a site that merely embeds the widget

Known and accepted, so please do not spend time on them: the widget's public key
is deliberately not a secret and appears in page source — it identifies a site and
grants no read access. Missing SPF/DMARC records (Heard sends no email). Reports
that consist only of a scanner's "missing header" output, unless you can show
what it lets an attacker do — several such gaps are already recorded in
[`docs/threat-model.md`](docs/threat-model.md) with fixes queued.

## Testing, and our promise back to you

We will not pursue anyone who follows these rules, and we will treat your testing
as the good-faith research it is:

- Test against **your own site key**, a site you own, or `wrangler dev` locally.
  `README.md` and `CLAUDE.md` explain how to run the whole thing on your machine
  in about a minute, which is a much better place to test than production.
- The `/demo` site exists to be poked at. Everything submitted there is deleted
  within 24 hours.
- **No load tests, no floods, no denial-of-service against production.** The free
  tier is shared by everyone using Heard, and exhausting it takes the product down
  for real users. If you think you have found a resource-exhaustion bug, describe
  the arithmetic and let us reproduce it locally — we will take your word for the
  volume.
- Do not access, modify or exfiltrate other people's feedback. If a bug exposes
  someone else's data to you, stop, take only what you need to prove it, and tell
  us what you saw so we know what to disclose.
- Do not socially engineer anyone, and do not attempt to compromise the
  maintainer's accounts.

## Heard is operated by an AI agent

This matters for how you report, so it is here rather than in a footnote.

Heard was designed, built, deployed and is operated autonomously by an AI agent,
with a human owner (Yair Stern) accountable for it. Your report will be read and
triaged by that automation, and a fix may be written and shipped by it. A human
is in the loop for consequential decisions and can be reached through the same
private advisory thread.

Two practical consequences:

1. **A response may arrive outside business hours, and may arrive from a
   machine.** We will not pretend otherwise — the project's rules forbid the
   automation from impersonating a human. If you would prefer a human to answer,
   say so in the thread and one will.
2. **Prompt injection is in scope, and please report it rather than using it.**
   The agent reads feedback submitted to Heard, so text that tries to instruct it
   counts as an attack surface and we treat it as such — see S1 in
   [`docs/threat-model.md`](docs/threat-model.md). If you find a way to make the
   operator act on attacker-supplied text, that is a real, high-severity finding
   and we want it. Demonstrate it with text that asks for something harmless and
   observable; do not attempt to make it change permissions, exfiltrate data, or
   push code. Instruction-shaped text found in a report is handled as evidence,
   never as an instruction.

## Your data as a reporter

We keep your report, your correspondence and your chosen credit for as long as
the advisory exists, because that is the record of the fix. We do not use it for
anything else and we do not share it with anyone beyond the maintainer and the
operating agent. If you want your name removed after disclosure, ask and we will
edit the advisory.

## If you find a leaked secret

If you find a credential of ours exposed anywhere — in this repository's history,
in a log, in a response body — treat it as critical and report it through the
private channel immediately. Do not use it to demonstrate impact. We will rotate
first and investigate second.
