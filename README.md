# AI Workers — AI Employees for Israeli Businesses

**Production status (verified 2026-08-30): offline.** Render (Frankfurt) is the
approved replacement host, but it has not been deployed or verified yet. The old
Railway address is historical/offline: `https://paid-agent-demo-production.up.railway.app`.

**Current production URL:** none yet. A fresh Render deployment starts with an
empty database; it does not recover customers, workers, payments, or conversations
from the Railway volume automatically.

Hire AI employees — pick a template, customize it, deploy it. Your worker handles customers 24/7 on web chat. WhatsApp coming soon.

- **B2B Lead Qualifier** — qualifies Hebrew/English leads, books meetings
- **Hebrew Customer Support** — answers FAQs from your knowledge base, escalates when needed
- **Data Entry Clerk** — extracts structured data from emails/forms/invoices
- **Hebrew Content Writer** — writes blog posts, LinkedIn, ads in natural Hebrew
- **Real Estate Agent** — handles apartment inquiries, schedules viewings
- **Clinic Receptionist** — books appointments, answers FAQs, handles cancellations
- **Restaurant Manager** — takes reservations, answers menu questions, handles takeaway
- **E-Commerce Support** — order tracking, returns, product questions
- **Property Manager** — maintenance requests, rent inquiries, contractor coordination

## Quick start

```bash
npm install
npm test           # starts an isolated server and runs API + browser flow tests
npm start          # starts on :8765
```

Open http://localhost:8765/ for the dashboard, then /marketplace to browse workers.

## How it works

1. **Start from the marketplace** — buyers can create a tenant key without admin help.
2. **Pick a template** from the marketplace (current catalog setup price: ₪0).
3. **Customize** persona, tasks, knowledge, skills, and MCP tools in the Builder.
4. **Pay monthly rental** (₪199-349/mo in the current catalog) via a configured payment channel.
5. **Submit payment proof** from the worker paywall.
6. **Admin approves the activation request** from `#/admin`.
7. **Chat with the worker** — it handles customers using its persona + your knowledge.

Workers use the platform-provided LLM configured on the server. If no `LLM_API_KEY` is set, the app runs in mock mode for demos and local testing.

## Architecture

```
src/
├── server.js        # HTTP server, dashboard, admin routes, payment channels
├── workers.js       # Worker engine: templates, CRUD, chat, LLM runtime, encryption
├── workers-ui.html  # Marketplace + Builder + Chat SPA
├── test.js              # platform/API tests
├── worker-tests.js      # worker lifecycle/API tests
├── browser-flow-test.js # rendered buy -> activate -> chat regression
└── run-tests.js         # isolated test runner used by npm test
```

The core server uses Node 22 built-ins (`node:http`, `node:sqlite`, `node:crypto`)
plus the small `@vercel/analytics` browser package retained for preview analytics.
Playwright is a dev dependency for browser-flow verification.

## Configure

Edit `.env` or set env vars:

```bash
set ADMIN_TOKEN=your-secret-token   # admin panel access
set PAYPAL_ME=your-username          # payment channel
set BIT_PHONE=9725XXXXXXXX           # Israeli Bit payments; replace locally
set BANK_ACCOUNT=123456              # bank transfer details
```

Admin API calls must use bearer auth:

```bash
curl -H "Authorization: Bearer %ADMIN_TOKEN%" http://localhost:8765/earnings
```

Query-string admin tokens are intentionally rejected so secrets do not leak through logs, history, or copied URLs.

## Operator Flow

- New buyers use `/api/signup` through the marketplace UI to create a tenant key.
- Tenant IDs are stable across API key rotation; customers can rotate the browser-stored key from the key bar.
- Admins can replace a lost tenant key from `#/admin`; old active keys for that tenant are revoked.
- Unpaid workers stay in `pending_payment` and cannot chat.
- Buyers submit proof through `/api/workers/:id/activation-request`.
- Admins review pending requests at `/marketplace#/admin` and approve with `/api/admin/mark-worker-paid`.
- Private telemetry endpoints such as `/earnings` and `/earnings.csv` require admin bearer auth.
- MCP discovery and website-learning URLs are restricted to public `http`/`https`
  destinations by default to prevent SSRF. Use `ALLOW_PRIVATE_NETWORK_URLS=1`
  only in isolated local labs.

## Deploy

Production deployments must persist `/app/data`; it contains the platform SQLite
database (`earnings.db`) and per-tenant worker databases (`tenants/*/workers.db`).
If this directory is ephemeral, customers will lose keys, workers, audit events,
payment status, and chat history on restart.

| Platform | Config | Persistent DB | Status |
|---|---|---|---|
| **Render** (primary target) | `render.yaml` + `Dockerfile` + disk `/app/data` | Yes | Planned; not deployed |
| Fly.io | `fly.toml` + `Dockerfile` | Yes (volume) | 5 min |
| Railway | `railway.toml` + `Dockerfile` | Historical/offline | Not the current target |
| Vercel | `vercel.json` | **No** (`/tmp` only) | Preview only |
| Any VPS | `Dockerfile` | Yes (mount volume) | 15 min |

### Render in Frankfurt (primary target)

The intended baseline is one paid Render web service in **Frankfurt, Germany**
with the smallest paid compute plan and a 1 GB persistent disk mounted at
`/app/data`. Estimated baseline cost: **US$7.25/month before tax and outbound
bandwidth/egress** (US$7 compute + US$0.25 for the 1 GB disk). Confirm the live
amount before creating the service: [Render pricing](https://render.com/pricing),
[persistent disk documentation](https://render.com/docs/disks), and
[available regions](https://render.com/docs/regions).

1. Open the [Render Dashboard](https://dashboard.render.com/) and choose **New → Blueprint**, connect this GitHub repository, and select branch `codex/revive-ai-workers-baseline`. Review the proposed resources and live price, then **stop before `Deploy Blueprint` until the owner explicitly approves that amount**; clicking it provisions the paid service and starts the initial deploy. Do not create a manual Web Service: it does not apply `render.yaml` automatically and can omit the disk, region, and readiness gates.
2. Confirm the region is **Frankfurt**, the Docker service uses `render.yaml`, and the persistent disk is mounted at `/app/data` with at least 1 GB.
3. During Blueprint creation, fill every `sync:false` prompt. As soon as the service resource appears, open **Environment** and add at least one real payment channel. The first deploy can validate the disk through `/infra-ready`, but every customer route intentionally returns `503` until the stricter `/ready` gate passes. Configure:
   - `PUBLIC_BASE_URL` = optional on Render because `RENDER_EXTERNAL_URL` is used automatically; set it only when a verified custom domain should be canonical
   - `ADMIN_TOKEN` = random hex (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`)
   - `INTEGRATIONS_SECRET` = a separate random secret; for recovery, use the exact old encryption secret instead
   - `LLM_API_KEY`, `LLM_MODEL`, and operator-controlled `LLM_BASE_URL` = the real provider configuration (`https://api.openai.com` for OpenAI or `https://openrouter.ai/api` for OpenRouter; the app appends `/v1` routes)
   - `BIT_PHONE`, `PAYPAL_ME`, a complete bank-transfer set, or verified Paddle production settings = at least one real payment channel in the Render dashboard (payment is not hard-coded in `render.yaml`)
   - keep `EMBED_ALLOW_PUBLIC=0` for the safe launch default; when external embeds are approved, change it to `1` and set an explicit HTTPS `EMBED_ALLOWED_ORIGINS` allow-list
4. Keep `DATA_DIR=/app/data`, `DB_PATH=/app/data/earnings.db`,
   `TENANTS_DIR=/app/data/tenants`, and `REQUIRE_PERSISTENT_VOLUME=1`.
5. Deploy, then check all three endpoints:
   - `GET /health` returning `200` proves the process is alive and exposes diagnostics; it is **not** the production gate.
   - `GET /infra-ready` must return `200`; Render uses it to verify SQLite, writable paths, and the mounted disk during bootstrap.
   - `GET /ready` must return `200` with `ok:true`; `503` means Render must keep the service out of production.
6. Run the full buyer smoke flow before publishing a URL: signup → template → activation proof → admin approval → real configured-LLM chat.
7. Immediately after provisioning, set **Blueprint Settings → Auto Sync → No**. This is separate from `autoDeployTrigger: off` and prevents Blueprint changes from redeploying resources automatically.
8. Only after the candidate is verified and Vercel production auto-deploys are disabled, perform one approved cutover: change `branch:` in `render.yaml` to `main` as part of the merge, point both the Blueprint's linked branch and the service branch to `main`, then run one Manual Sync. Keep Blueprint Auto Sync off.

Set variables in the Render dashboard (same as step 3 above):

```bash
ADMIN_TOKEN=<random-hex>          # node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
LLM_API_KEY=sk-...
LLM_MODEL=<provider-model-id>
LLM_BASE_URL=https://api.openai.com # or https://openrouter.ai/api
# Optional on Render; set only for a verified canonical custom domain
PUBLIC_BASE_URL=
TRUST_PROXY_HEADERS=1
DATA_DIR=/app/data
DB_PATH=/app/data/earnings.db
TENANTS_DIR=/app/data/tenants
REQUIRE_PERSISTENT_VOLUME=1
EMBED_ALLOW_PUBLIC=0             # enable later only with an explicit HTTPS allow-list
AGENT_OWNER_CONTACT=you@example.com
BIT_PHONE=9725XXXXXXXX            # or PAYPAL_ME; set the real value only in Render
WEBHOOK_NOTIFY_URL=               # optional: lead/escalation webhook
```

`render.yaml` defines the Render baseline, including Frankfurt, the disk mount,
and the readiness health-check path.

After deploy, verify:

```bash
curl https://your-service.onrender.com/health
# liveness only: expect HTTP 200 and inspect diagnostics
curl -i https://your-service.onrender.com/infra-ready
# Render infrastructure gate: expect HTTP 200 after the persistent disk is mounted
curl -i https://your-service.onrender.com/ready
# production gate: expect HTTP 200 and ok:true (not 503)
```

#### Fresh deployment is not Railway data recovery

Render creates a new, empty `/app/data` disk. Before directing returning
customers to it, separately obtain and verify a Railway backup containing both
`earnings.db` and `tenants/`. Preserve the exact old `INTEGRATIONS_SECRET`; if it
was unset, preserve the old `ADMIN_TOKEN` value that served as the encryption
fallback. Restore the data and matching encryption secret to Render, then
validate tenant counts, decrypt/test every integration, and run a real customer
flow. If the old encryption secret is unavailable, reconnect every integration
and document that limitation. If no verified Railway export is available, label
the Render instance as a **fresh launch**, not a recovered production system.

Deployment checklist:

- Set `ADMIN_TOKEN` from a secret manager, never in source.
- Set `LLM_API_KEY` for real worker replies; without it the app intentionally runs in mock mode.
- Mount persistent storage at `DATA_DIR`; if using a path other than `/app/data`, move the mount and update `DATA_DIR`, `DB_PATH`, and `TENANTS_DIR` together so both database paths remain under that mount.
- Set `TRUST_PROXY_HEADERS=1` only behind a trusted proxy/load balancer that overwrites `X-Forwarded-*` headers.
- Confirm `/health` reports Render's external URL; set `PUBLIC_BASE_URL` only for a verified canonical custom domain.
- Use `/health` for liveness diagnostics, `/infra-ready` for Render's infrastructure health check, and require `/ready` to return `200` before sending customer traffic.
- Run a buyer flow smoke test: signup -> buy template -> submit activation proof -> admin approve -> chat.
- Roll back by redeploying the previous image/revision, then verify `/ready` and the admin audit panel.

**Production URL:** not assigned or verified yet. The previous Railway URL is
historical and offline. Vercel uses ephemeral `/tmp` storage and is allowed only
for disposable previews. **Disable Vercel production auto-deploys from `main`**
before merging; PR previews must never be presented as customer production.

## Why this is worth paying for (2026)

AI models are commodity. The value is in **vertical integration**:
- Pre-built Hebrew-first templates tuned for Israeli business culture
- No-code builder — businesses customize without developers
- Israeli payment methods (PayPal, Bit, bank transfer — no Stripe needed)
- Per-tenant worker isolation with stable tenant IDs, key rotation, recovery, and admin audit events
- WhatsApp integration (coming soon) — the #1 business channel in Israel
