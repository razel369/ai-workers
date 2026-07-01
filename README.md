# AI Workers — AI Employees for Israeli Businesses

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
2. **Pick a template** from the marketplace (one-time buy: 99-199 ₪).
3. **Customize** persona, tasks, knowledge, skills, and MCP tools in the Builder.
4. **Pay monthly rental** (149-299 ₪/mo) via PayPal, Bit, or bank transfer.
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

Zero runtime npm dependencies. Uses Node 22 built-ins: `node:http`, `node:sqlite`, `node:crypto`. Playwright is a dev dependency for browser-flow verification.

## Configure

Edit `.env` or set env vars:

```bash
set ADMIN_TOKEN=your-secret-token   # admin panel access
set PAYPAL_ME=your-username          # payment channel
set BIT_PHONE=972541234567           # Israeli Bit payments
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

| Platform | Config | Persistent DB | Time |
|---|---|---|---|
| **Railway** (recommended) | `railway.toml` + `Dockerfile` + volume `/app/data` | Yes | 5 min |
| Fly.io | `fly.toml` + `Dockerfile` | Yes (volume) | 5 min |
| Render | `render.yaml` + `Dockerfile` | Yes (disk) | 5 min |
| Vercel | `vercel.json` | **No** (`/tmp` only) | demos |
| Any VPS | `Dockerfile` | Yes (mount volume) | 15 min |

### Railway (recommended)

1. Connect GitHub repo `razel369/ai-workers` in [Railway](https://railway.app).
2. Add a **persistent volume** at mount path `/app/data`.
3. Set variables in the dashboard:

```bash
ADMIN_TOKEN=<random-hex>          # node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
LLM_API_KEY=sk-...
PUBLIC_BASE_URL=https://your-app.up.railway.app
TRUST_PROXY_HEADERS=1
AGENT_OWNER_CONTACT=you@example.com
BIT_PHONE=972541234567            # or PAYPAL_ME
WEBHOOK_NOTIFY_URL=               # optional: lead/escalation webhook
```

`DB_PATH` and `TENANTS_DIR` are preset in `railway.toml` to `/app/data/...`.

4. After deploy, verify:

```bash
curl https://your-app.up.railway.app/health
# expect: ok:true, persistentStorage:true, adminEnabled:true
```

Deployment checklist:

- Set `ADMIN_TOKEN` from a secret manager, never in source.
- Set `LLM_API_KEY` for real worker replies; without it the app intentionally runs in mock mode.
- Mount persistent storage at `/app/data` or set `DB_PATH` and `TENANTS_DIR` to another persistent path.
- Set `TRUST_PROXY_HEADERS=1` only behind a trusted proxy/load balancer that overwrites `X-Forwarded-*` headers.
- Set `PUBLIC_BASE_URL` to your public URL (Railway domain or custom domain).
- Verify `/health` after deploy and run a buyer flow smoke test: signup -> buy template -> submit activation proof -> admin approve -> chat.
- Roll back by redeploying the previous image/revision, then verify `/health` and the admin audit panel.

**Vercel** (`paid-agent-demo.vercel.app`) is fine for UI demos; SQLite lives on ephemeral `/tmp` and resets on cold deploy. Use Railway (or Fly/Render) for production data.

## Why this is worth paying for (2026)

AI models are commodity. The value is in **vertical integration**:
- Pre-built Hebrew-first templates tuned for Israeli business culture
- No-code builder — businesses customize without developers
- Israeli payment methods (PayPal, Bit, bank transfer — no Stripe needed)
- Per-tenant worker isolation with stable tenant IDs, key rotation, recovery, and admin audit events
- WhatsApp integration (coming soon) — the #1 business channel in Israel
