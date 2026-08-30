# AI Workers — Product Readiness

**Snapshot:** 2026-08-30

**Decision:** **NO-GO for public production, paid customers, or marketing claims of a live service.**

**Allowed now:** local development and demonstrations with synthetic data only.

There is no verified production URL. The historical Railway URL is offline, no
Oracle resource has been created, and a Vercel preview is not durable production.

## Proof tiers

| Tier | What it proves | Current state |
|---|---|---|
| 1. Source/static | The intended control exists in the reviewed code or configuration | Substantial coverage; not runtime proof |
| 2. Local automated | A deterministic process exercised code on one local machine | Complete local suite passed; see exact results below |
| 3. Local rendered/runtime | The final candidate launched and a browser/user flow worked locally | Passed for the bounded local mock flow described below |
| 4. Live provider integration | A real provider accepted and completed an end-to-end operation | **Unproven** |
| 5. Deployed production | Oracle, DNS, TLS, persistent storage, monitoring and restore work on the live target | **Unproven** |
| 6. Customer/business proof | Real businesses obtain value, pay, renew, and legal/tax operations are approved | **Unproven** |

A higher tier cannot be inferred from a lower one. Source code is not runtime;
mock runtime is not a real model; a sandbox webhook is not live money; a local
archive is not disaster recovery; and a demo is not a customer pilot.

## Exact local evidence

### Deterministic worker evaluation — passed

Observed on 2026-08-30:

```text
Scenarios: 31 · Passed: 31 · Failed: 0
Templates: 13
Mandatory gates: intent 31/31 · language 31/31 · tools 31/31 · safety 31/31
Average: intent 82 · language 99 · length 100 · tools 100 · safety 100 · total 96
```

These are **local, deterministic, planning-only mock scenarios**. The harness
calls `chatWithWorker` with `testMode:true` and `demoMode:true`; it requires
`dryRun:true`, inspects planned tool calls, and must not execute tool handlers.
It does not call an external LLM, Meta, Paddle, CRM, calendar, webhook or media
provider. It does not measure real-model hallucination, latency, rate limits,
provider outages, prompt drift, cost, or customer satisfaction. Because the mock
behavior and evaluator live in the same repository, 31/31 is a regression signal,
not independent proof of AI quality.

### Focused data-lifecycle checks — passed

Focused local checks observed worker-scoped deletion, a 404 for deleted media,
sibling-worker preservation, cached/inactive-tenant retention catch-up, signed
encrypted-manifest tamper rejection, and rejection of eight unsafe archive-member
classes. These checks do not prove an actual Oracle backup, off-VM upload, remote
rotation, or recovery of a live customer database.

### Complete local suite — passed

The current worktree completed `npm test` with `ALL SUITES PASSED`. The command
covered Docker/OCI and readiness smoke checks, API and tenant-isolation tests,
browser-flow tests, engine hardening, data lifecycle and safe restore, CSV
injection, Paddle production boundaries, WhatsApp route ownership, harness
integrity tests, and the 31 deterministic scenarios above.

### Bounded local browser acceptance — passed

A fresh local account and `social-strategist-he` worker were created through the
rendered marketplace. Mandatory placeholder-free knowledge approval, one-time
recovery-code disclosure, demo chat, activation/payment gating, account reload,
and the Hebrew name containing em dashes were exercised. At a 390×844 viewport,
the worker list, chat and account surfaces had no horizontal overflow; the
captured browser console contained no warning or error entries. The demo reply
was customer-facing and did not expose mock traces or planned agent actions.

This remains a local mock flow. It does not prove a real LLM, real payment,
WhatsApp delivery, external embed, public TLS, persistence across an Oracle
reboot, off-VM recovery, uptime, or customer value.

## External gates that remain unproven

| Area | What exists now | Required evidence before claiming readiness |
|---|---|---|
| Oracle Always Free | Runbook, Compose and bootstrap source | Owner creates an **Always Free Eligible** A1 VM at a `$0` estimate; reboot and persistence are observed |
| DNS and TLS | Caddy configuration | Public hostname resolves; a trusted certificate is served; external HTTPS monitoring observes `/ready` |
| Real LLM | Provider adapters, timeout and quota controls | Approved provider/model returns real answers through the paid worker flow; quality, latency, cost cap and failure behavior are recorded |
| Paddle | Sandbox/configuration and webhook validation code | Live account, exact production price map, completed real transaction, signed webhook, entitlement, refund/cancel and reconciliation are exercised |
| Meta WhatsApp | Signature parsing, routing and retry/idempotency code | Verified Meta Business number receives a real inbound message and sends exactly one outbound reply; retry and permanent-failure behavior are observed |
| Embed on customer domain | Origin-scoped session and abuse-budget code | Real HTTPS customer origin passes CORS/session/chat, mobile UI, expiration, abuse limits and disclosure/privacy review |
| Off-VM backup | Local encryption, signed manifest, rclone-crypt path and strict restore code | A generation reaches `offsite_verified`, is downloaded on a separate recovery path, restored, and passes SQLite plus application smoke |
| Monitoring | Local monitor script | External monitor detects DNS/TLS/timeout/503 while the VM is unavailable and successfully alerts the owner |
| Customer pilot | Draft GTM material | At least one explicitly consented pilot uses real data under agreed scope; support incidents, outcomes and costs are measured |
| Legal and tax | Draft privacy/terms and non-tax order summary | Israeli lawyer/privacy review, accountant decision, invoicing/VAT process, provider agreements and data-transfer disclosures are approved |

PayPal, Bit and bank-transfer values in configuration are also not proof of a
working payment or bookkeeping flow. Never describe an order summary as a tax
invoice or receipt.

## Release gates

All items are required for a public paid launch:

- [x] Obtain one clean, complete local `npm test` run on the final worktree.
- [ ] Review the final diff and obtain green CI for that exact commit.
- [ ] Create only the owner-approved `$0` Oracle resource and verify persistence
  across container and VM restarts.
- [ ] Verify DNS, trusted TLS, `/health`, `/infra-ready`, `/ready`, monitoring and
  alert delivery from outside the VM.
- [ ] Run signup → reviewed knowledge → real checkout/payment → entitlement →
  real LLM chat on the persistent disk.
- [ ] Complete one real Meta WhatsApp end-to-end test before advertising
  WhatsApp; otherwise market only the verified web channel.
- [ ] Produce and restore a verified off-VM encrypted backup.
- [ ] Perform compact and desktop browser acceptance on the deployed URL,
  including embed on an allowed external origin.
- [ ] Complete privacy, terms, data-processing, invoicing/VAT and refund-process
  review with qualified Israeli professionals.
- [ ] Run a bounded pilot with explicit success, cost, safety and support gates.

Until every relevant gate is evidenced, use wording such as “development
candidate”, “local demo”, or “planned integration”; do not use “live”,
“production-ready”, “verified payment”, “active WhatsApp”, “24/7”, or “proven
for Israeli businesses”.
