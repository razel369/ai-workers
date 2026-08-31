# Revenue operations — the recurring-revenue loop

How money actually recurs, who gets told what, and what to check when it does not.

Before this existed, `paid_until` was written once at activation and never read
again by anything but a boolean at chat time. A customer paid by Bit, got 30
days, and on day 31 their worker went silent — no reminder, no grace period,
nobody told. This document describes the loop that replaced that.

## The lifecycle

```
active ──T-7/T-3/T-1 reminders──► paid_until ──► GRACE_DAYS still answering
                                                 │  dunning 1 → 2 → 3
                                                 ▼
                                             suspended (data kept)
```

A worker inside its grace window **keeps answering customers**. Cutting a
clinic off at midnight on the renewal date, mid-conversation, turns a late
payment into a cancellation. `workers.subscriptionState()` is the single place
that decides this.

Suspension is reversible and non-destructive: knowledge, leads, transcripts and
settings survive, so a late payment restores the worker exactly where it left
off (`adminReactivateWorker`).

## Daily cycle

`billing-lifecycle.js` runs hourly and fires once past `BILLING_RUN_HOUR`. It
checks the hour rather than sleeping 24h so a container restart cannot skip a
day — for a billing job, a skipped day is lost revenue.

Every send is deduplicated on `(worker, event, date)`, so re-running the cycle
is safe. Force one with:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $BASE/api/admin/billing-run
```

| Env | Default | Meaning |
|---|---|---|
| `BILLING_GRACE_DAYS` | `5` | Keep answering this long past `paid_until` |
| `BILLING_REMINDER_DAYS` | `7,3,1` | Renewal reminder horizons |
| `BILLING_RUN_HOUR` | `8` | Local hour for the daily run |
| `BILLING_DISABLED` | — | `1` turns the scheduler off |

## Notifications

`notify.js` is the platform's own channel to its customers — distinct from the
`email_smtp` integration, which is a tool the *worker* calls.

**Without a configured transport, no reminder, receipt or lead alert can be
sent.** The server logs a `[WARN]` at boot when this is the case, and
`/health.notifications.deliverable` reports it.

Providers are auto-detected from whichever credentials are present:

| Env | Provider |
|---|---|
| `RESEND_API_KEY` | Resend |
| `SENDGRID_API_KEY` | SendGrid |
| `POSTMARK_TOKEN` | Postmark |
| `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` | Mailgun |
| `SMTP_HOST` (+ `SMTP_USER`/`SMTP_PASS`) | Raw SMTP (STARTTLS, no dependencies) |
| `MAIL_WEBHOOK_URL` | Generic JSON POST (Zapier/Make) |

Always set `MAIL_FROM` (e.g. `AI Workers <noreply@yourdomain.co.il>`) — a
provider key without a From address cannot send.

Messages go through an outbox with exponential backoff (1, 5, 30, 120, 480 min,
then `failed`). Inspect it:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" $BASE/api/admin/notifications
```

## Owner alerts

A lead captured at 23:00 and filed in SQLite is worth the same as a lead never
captured. `owner-alerts.js` pushes new leads and escalations to the business
owner immediately, on email and/or WhatsApp.

| Env | Default | Meaning |
|---|---|---|
| `OWNER_ALERTS` | on | `0` disables |
| `OWNER_ALERT_MIN_SCORE` | `0` | Only alert on leads at/above this score |
| `OWNER_ALERT_QUIET_HOURS` | — | e.g. `23-7`; **urgent escalations override it** |

## Self-serve card checkout

Manual approval with a 24h SLA is a conversion killer and a founder bottleneck.
Paddle (Merchant of Record) removes it. `/health.payment.paddle` reports
`selfServeReady` plus explicit warnings — most importantly
`PADDLE_ENVIRONMENT=sandbox` in production, which silently means real cards
cannot be charged.

Handled events: `subscription.created/activated/updated`,
`transaction.completed/paid`, `subscription.canceled`,
`transaction.payment_failed`.

A cancellation does **not** revoke service — the customer paid through the end
of the period, and `paid_until` already encodes that. A `past_due` card starts
dunning while the worker keeps serving.

Map Paddle prices to plans with `PADDLE_PRICE_MAP={"bundle3":"pri_xxx"}` so
quotas match what was actually sold.

## Plans

Defined in `tenant-registry.js`, served from `GET /api/plans`.

| Plan | ₪/mo | Workers | Customer messages/mo |
|---|---|---|---|
| `trial` | 0 | 1 | 500 |
| `starter` | 249 | 1 | 4,000 |
| `bundle3` | 499 | 3 | 12,000 |
| `agency` | 1,290 | 10 | 40,000 |
| `starter_annual` | 2,490/yr | 1 | 4,000 |
| `bundle3_annual` | 4,990/yr | 3 | 12,000 |

Annual is 10x monthly — two months free — which pulls cash forward and removes
eleven monthly cancellation decisions.

### What "messages" means

`monthlyMessages` counts **customer messages**, not LLM calls. One customer
message can take up to `MAX_AGENT_STEPS` (5) LLM calls to answer, because the
agent loop re-sends the system prompt and the whole conversation on every step.

This distinction is not cosmetic: an earlier version of these limits counted LLM
calls, which meant a clinic handling ten conversations a day would have been cut
off around **day 13** of the month while using under 4% of its plan's economic
headroom. `usage_counters` tracks both — `chat_turns` for the quota,
`messages` for cost — and `/api/admin/margin` reports `callsPerMessage` so you
can see which tenants run expensive agent loops.

## Unit economics

Measured from the code, not estimated: system prompts run 647–1,727 tokens
depending on template (`social-strategist-he` is the heaviest, at 14 tools),
plus whatever knowledge the tenant pastes in. A typical 6-message conversation
with a 1,500-token knowledge base and a 2-step agent loop is about **40,000
input and 1,600 output tokens**.

**96% of those input tokens are a repeated prefix** — the same system prompt and
conversation history re-sent on every agent step. Only ~1,560 tokens per
conversation are genuinely new. That makes prompt caching, not model choice, the
dominant cost lever.

Per conversation, at Aug 2026 list prices:

| Model | no cache | with cache |
|---|---|---|
| `deepseek-v4-flash` (default) | 0.037 ₪ | **0.006 ₪** |
| `gemini-2.5-flash-lite` | 0.017 ₪ | 0.004 ₪ |
| `gpt-5.6-luna` | 0.037 ₪ | 0.011 ₪ |
| `gpt-4o-mini` | 0.026 ₪ | 0.015 ₪ |
| `gpt-4o` | 0.43 ₪ | — |

A 249 ₪/mo tenant running 300 conversations a month costs roughly **2-11 ₪** to
serve depending on cache hit rate — a 96-99% gross margin. DeepSeek caches
repeated prefixes automatically and bills hits at about 3% of the miss rate, so
the effective cost sits near the bottom of that range once a worker is warm.

`estimateCostUsd` credits cached tokens when the provider reports them
(`prompt_cache_hit_tokens` on DeepSeek, `prompt_tokens_details.cached_tokens` on
OpenAI). Before that credit existed the margin report overstated cost.

**Input tokens dominate.** Output is capped at `LLM_MAX_TOKENS` (1024) and real
replies are ~200 tokens, but every agent step re-sends the system prompt plus up
to `CHAT_HISTORY_LIMIT` (40) messages of history. The levers that matter, in
order: cache hit rate, `MAX_AGENT_STEPS`, knowledge-base size, the model, and
`CHAT_HISTORY_LIMIT`.

The system prompt is always the first message in the request, which is what
makes the prefix cacheable — do not reorder it.

## Vendors

| Concern | Vendor | Key | Notes |
|---|---|---|---|
| Chat | DeepSeek V4 Flash | `LLM_API_KEY` | OpenAI-wire-compatible; peak/off-peak pricing since 16 Aug 2026 |
| Images | OpenAI GPT Image 2 | `OPENAI_API_KEY` | Billed per image (~$0.03/$0.05/$0.08 by quality), not per token |
| Video | Google Veo | `GOOGLE_AI_API_KEY` | Unchanged |

Chat and media are separate vendors with **separate credentials**. A missing
`OPENAI_API_KEY` is its own failure mode: workers keep answering normally but
silently return mock placeholder images. The server logs a `[WARN]` at boot and
`/health.media.live` reports it.

Image cost is metered per image (`kind: 'image'` in `usage_events`) and rolls
into the same tenant cost counter, so `/api/admin/margin` covers the full cost
of serving a tenant rather than tokens alone.

> **Data residency.** DeepSeek processes conversation content on servers in
> China, and offers no enterprise DPA, no EU/US residency option, and no
> standard contractual clauses. This is disclosed in `docs/legal/dpa-he.md`,
> which tenants sign. It is a live consideration for clinics and law firms —
> switching provider needs only `LLM_PROVIDER` and `LLM_BASE_URL`, no code
> change, so it can be reversed per deployment if a customer requires it.

### Two ceilings, not one

The message quota is a fair-use limit sold to the customer. It cannot see cost:
a tenant with a 5,000-token knowledge base running the full 5-step loop costs
about 10x a typical tenant for the same message count.

So `PLAN_COST_CEILING_PCT` (default 35) caps estimated LLM spend as a share of
plan revenue, and that is the actual margin guard. Free trials have no revenue
to take a share of, so `trial` carries an absolute `costCeilingIls`
(`TRIAL_COST_CEILING_ILS`, default 20 ₪).

Worst case at full quota, with both ceilings applied:

| Plan | Typical cost | Worst case | Ceiling | Worst-case margin |
|---|---|---|---|---|
| `starter` | 17 ₪ | 83 ₪ | 87 ₪ | 67% |
| `bundle3` | 52 ₪ | 250 ₪ | 175 ₪ | 65% |
| `agency` | 173 ₪ | 832 ₪ | 451 ₪ | 65% |

Reproduce any of this against your own provider's prices by setting
`MODEL_PRICING_JSON` and reading `/api/admin/margin`.

## Margin

`usage-metering.js` attributes every LLM round-trip to the tenant paying for it.
Without it there is no way to answer whether a 249 ₪/mo tenant costs 40 ₪ or
900 ₪ to serve.

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" $BASE/api/admin/margin
```

Returns revenue, estimated cost and margin per tenant, and counts unprofitable
tenants. Gateways that omit a `usage` block fall back to a character-based
estimate, flagged `estimated` so reports stay honest.

| Env | Default | Meaning |
|---|---|---|
| `MODEL_PRICING_JSON` | — | `{"model":{"in":0.15,"out":0.6}}` USD per 1M tokens |
| `USD_TO_ILS` | `3.7` | FX rate for reporting |
| `QUOTA_ENFORCE` | `1` | `0` measures without blocking (safe rollout) |
| `PLAN_COST_CEILING_PCT` | `35` | Cap LLM spend at this share of plan revenue |
| `TRIAL_COST_CEILING_ILS` | `20` | Absolute cap for free trials |
| `LLM_DEFAULT_MODEL` | `gpt-4o-mini` | Default chat model |

**The default model is the single biggest lever on gross margin.** Hebrew FAQ
answering and lead capture do not need a frontier model; at a flat monthly
price a frontier default can cost more per tenant than the tenant pays.

## Funnel

Third-party analytics was enabled only on `*.vercel.app` while production runs
on Railway, so nothing was ever recorded. `funnel-analytics.js` replaces it with
first-party events (no cookies, no personal data, session keys hashed at rest):

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/funnel?days=30"
```

Reports unique sessions per step, step-to-step conversion, and the biggest
drop-off — which is where the next sprint should go.

## Troubleshooting

| Symptom | Check |
|---|---|
| No reminders going out | `/health.notifications.deliverable`; then `/api/admin/notifications` for `failed` rows and `lastError` |
| Customers not reachable | `/api/admin/tenants` → `unreachable` count |
| Paid customers still suspended | `/api/admin/billing` → `lastRun.errors` |
| Card payments never activate | `/health.payment.paddle.warnings` |
| Margin looks wrong | `/api/admin/margin` — check `estimated` rows and `MODEL_PRICING_JSON` |
