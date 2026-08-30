# AI Workers — AI Employees for Israeli Businesses

**Production status (verified 2026-08-30): offline.** The recommended zero-cost
hosting path is an Oracle Cloud **Always Free** A1 VM; no Oracle resource has been created
or verified yet. The empty Render project has zero services, and its paid
deployment path was rejected. The old Railway address is historical/offline:
`https://paid-agent-demo-production.up.railway.app`.

**Current production URL:** none yet. A fresh Oracle deployment starts with an
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

| Platform | Config | Persistent DB/files | Status |
|---|---|---|---|
| **Oracle Cloud Always Free A1** | `compose.oci.yaml` + `deploy/oci/` | Yes, on VM boot volume | Recommended free path; not deployed |
| Render Free | No deploy config | **No** durable local disk | Incompatible; paid Blueprint removed |
| Railway | `railway.toml` + `Dockerfile` | Historical/offline | Not the current target |
| Vercel | `vercel.json` | **No** (`/tmp` only) | Preview only |

### Oracle Cloud Always Free (primary target)

The intended baseline is one `VM.Standard.A1.Flex` Ubuntu ARM64 VM in the
account's home region, sized at 1 OCPU / 4 GB RAM with a 50 GB boot volume. Every
resource must display **Always Free Eligible** and a zero estimate before it is
created. Do not upgrade the account or substitute a paid shape when A1 capacity
is unavailable.

The repository provides:

- `compose.oci.yaml`: app + Caddy, with no public app port and `/app/data` bound
  to persistent host storage
- `.env.oci.example`: fail-closed production settings with no committed secrets
- `deploy/oci/bootstrap.sh`: installs Docker/Compose but deliberately does not
  start the application
- `deploy/oci/deploy.sh`: refuses placeholders, validates Compose, then starts
  the stack
- `deploy/oci/backup.sh`: briefly stops the app and creates a checksum-protected
  staging archive that must be encrypted/copied off the VM and verified there

Follow the complete [Oracle deployment runbook](deploy/oci/README.md). Account
creation, login, identity/card checks, home-region choice, and the final Oracle
**Create** action remain owner-controlled steps.

After DNS and `.env` are configured:

```bash
sudo bash ./deploy/oci/deploy.sh
curl -i https://YOUR_DUCKDNS_HOST/health
curl -i https://YOUR_DUCKDNS_HOST/infra-ready
curl -i https://YOUR_DUCKDNS_HOST/ready
```

`/health` is liveness only. `/infra-ready` must prove SQLite, writable paths,
and the Docker bind mount; it does not prove Oracle retention or off-VM backup.
`/ready` must return HTTP 200 with `ok:true` before
customer traffic; it also requires real secrets, owner contact, an LLM and a
payment channel. Free hosting does not make a paid LLM API free, so use a real
free provider quota/model if the whole stack must remain at $0.

Oracle's current Always Free allowance and reclamation policy are documented in
[Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
There is no SLA, A1 capacity may be unavailable, and an instance classified as
idle may be reclaimed. Keep off-VM backups and a tested restore path.

#### Fresh deployment is not Railway data recovery

A new VM starts with an empty `data/` directory. Before directing returning
customers to it, separately obtain and verify a Railway backup containing both
`earnings.db` and `tenants/`. Preserve the exact old `INTEGRATIONS_SECRET`; if it
was unset, preserve the old `ADMIN_TOKEN` that served as the encryption fallback.
If no verified export exists, label the instance as a **fresh launch**, not a
recovered production system.

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
