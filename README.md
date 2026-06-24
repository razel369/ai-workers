# Paid-Agent Demo (v0.4.0) — Israel-friendly edition

A paid AI agent that works **without a registered business**.

Three ways to get an API key:
1. **Pay via PayPal.me / Bit / Buy Me a Coffee / bank transfer** (oldschool, no business needed in Israel) → owner issues key within 24h
2. **Pay per call with USDC** via x402 (crypto, instant, no signup)
3. **Subscribe via GitHub Sponsors** (after you publish the code)

Zero npm dependencies. Single Node.js process.

## Live demo

A public demo is running on a Cloudflare quick tunnel right now (URL is printed by `npm run tunnel` and changes per restart):

```
Dashboard:    https://individually-threatening-disable-bottom.trycloudflare.com/
Invoice:      https://individually-threatening-disable-bottom.trycloudflare.com/invoice
Agent card:   https://individually-threatening-disable-bottom.trycloudflare.com/.well-known/agent.json
Health:       https://individually-threatening-disable-bottom.trycloudflare.com/health
```

The tunnel is courtesy of [cloudflared](https://github.com/cloudflare/cloudflared) (free, no account needed for `--url` mode). Tunnel URLs are ephemeral; for permanent hosting see "Deploy options" below.

## What's new in v0.4.0 (Israel edition)

- **Stripe removed** (not viable in Israel without a business entity)
- **PayPal.me** as primary fiat channel (Israeli individuals can receive)
- **Bit** (Israeli payment app) link
- **Buy Me a Coffee** + **Ko-fi** (international, pay to Israeli bank)
- **Bank transfer / masheh** with Israeli-friendly fields (bank, branch, account, IBAN, SWIFT)
- **Gumroad** support (sell the source as a one-time template — Gumroad is merchant-of-record and pays out to Israeli bank accounts)
- **GitHub Sponsors** link
- **Auto-generated invoice** at `/invoice` (plain text, ready to email)
- **Admin endpoint** to issue API keys after off-platform payment (with ADMIN_TOKEN)
- **Tip jar endpoint** to log incoming tips
- x402 (crypto) path still works alongside for AI agents
- **`X-Forwarded-*` honored** so the invoice / dashboard always show the public URL behind any reverse proxy

## Quick start (mock mode, zero setup)

```powershell
# Generate an admin token (for issuing API keys later)
$env:ADMIN_TOKEN = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
Write-Host "ADMIN_TOKEN=$env:ADMIN_TOKEN"

npm test    # runs 31 tests against a fresh server
npm start   # starts on :3000
```

Open http://localhost:3000/ for the dashboard.

## Expose it to the internet (one command, zero account)

```powershell
npm run tunnel
```

Prints a public `https://*.trycloudflare.com` URL connected to your local server. Cloudflare's Tel Aviv edge is the closest region. Free. No signup. The URL changes every restart; for a permanent URL, sign up for Cloudflare and bind a named tunnel (instructions in the script output).

## Configure it for Israel (10 minutes)

Edit `.env` (or set env vars) and fill in **only the ones you want to enable**:

```powershell
$env:AGENT_NAME              = "Razel's AI Tools"
$env:AGENT_DESCRIPTION       = "Smart AI agent for Hebrew/English text"
$env:AGENT_OWNER_CONTACT     = "razel@example.com"

# Oldschool channels (any subset)
$env:PAYPAL_ME               = "razel"            # -> paypal.me/razel
$env:BUY_ME_A_COFFEE         = "https://buymeacoffee.com/razel"
$env:KO_FI                   = "https://ko-fi.com/razel"
$env:BIT_PHONE               = "972541234567"     # -> bitpay.co.il link
$env:GITHUB_SPONSORS         = "razel"
$env:GUMROAD_URL             = "https://razel.gumroad.com/l/paid-agent-template"

# Israeli bank invoice
$env:PAYEE_NAME              = "Razel M."
$env:BANK_NAME               = "Bank Hapoalim"
$env:BANK_BRANCH             = "620"
$env:BANK_ACCOUNT            = "123456"
$env:IBAN                    = "IL62 0126 2000 0000 1234 567"
$env:SWIFT                   = "POALILIT"

# x402 (crypto path, optional)
$env:NETWORK                 = "base-sepolia"    # for real money: "base"
$env:WALLET_ADDRESS          = "0xYourAddress"
$env:PRICE_USDC              = "0.05"

# Admin
$env:ADMIN_TOKEN             = "your-secret-token"
```

Then `npm start` (or `npm run tunnel` for public access).

## How the oldschool path actually works

1. Customer opens `https://your-host/invoice`
2. They pick a plan (`credits-100`, `monthly-1k`, `power-10k`)
3. They pay via **any channel listed** (PayPal.me, Bit, bank transfer, etc.)
4. They email you the screenshot + plan id
5. **You issue their key** (one curl):

```powershell
Invoke-WebRequest -Uri "https://your-host/admin/issue-key?token=$env:ADMIN_TOKEN" `
  -Method POST -Headers @{ "content-type" = "application/json" } `
  -Body '{"planId":"monthly-1k","channel":"paypal","reference":"PP-12345","label":"John D."}'
```

Response:
```json
{ "ok": true, "key": "sk_a1b2c3d4...", "plan": "monthly-1k", "callsLimit": 1000 }
```

6. You paste that key into an email to the customer.
7. Customer uses it:

```powershell
curl -X POST https://your-host/entrypoints/summarize/invoke `
  -H "authorization: Bearer sk_a1b2c3d4..." `
  -H "content-type: application/json" `
  -d '{"text":"hello world"}'
```

## Deploy options (permanent hosting)

All configs are committed in the repo:

| Platform | Files | Cost | Time to live |
|---|---|---|---|
| **Cloudflare Tunnel (this machine)** | `bin/cloudflared.exe` + `npm run tunnel` | free | 1 min |
| **Railway** | `railway.toml`, `Dockerfile` | free tier + ~$5/mo | 5 min |
| **Fly.io** | `fly.toml`, `Dockerfile` | free tier (3 VMs) | 5 min |
| **Render** | `render.yaml`, `Dockerfile` | free tier (sleeps) | 5 min |
| **Any VPS** (Hetzner, DigitalOcean) | `Dockerfile` | ~$4/mo | 15 min |

### Railway
```powershell
npm install -g @railway/cli
railway login
railway init
railway up
# Then in dashboard: set env vars (see .env.example)
```

### Fly.io
```powershell
irm https://fly.io/install.ps1 | iex
fly auth signup
fly launch --no-deploy
fly secrets set ADMIN_TOKEN=... WALLET_ADDRESS=0x... PAYPAL_ME=razel BIT_PHONE=...
fly deploy
```

### Render
Push the repo to GitHub, then in Render dashboard: New → Web Service → Connect repo. Render reads `render.yaml` automatically and prompts for the env vars.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | none | dashboard |
| GET | `/health` | none | config |
| GET | `/.well-known/agent.json` | none | A2A agent card |
| GET | `/requirements` | none | x402 requirements |
| GET | `/billing/plans` | none | plans + payment channels |
| GET | `/invoice` | none | plain-text invoice |
| POST | `/tip` | none | log an incoming tip |
| GET | `/earnings` | none | summary + recent calls |
| GET | `/earnings.csv` | none | CSV export |
| POST | `/entrypoints/:key/invoke` | API key OR x402 | paid call |
| POST | `/admin/issue-key` | `ADMIN_TOKEN` | issue an API key |
| GET | `/admin/keys` | `ADMIN_TOKEN` | list issued keys (no secrets) |
| POST | `/admin/revoke` | `ADMIN_TOKEN` | revoke a key |

## Revenue math (Israeli pricing)

| Plan | Calls | ILS | USD |
|---|---|---|---|
| credits-100 | 100 | 18 ₪ | ~$5 |
| monthly-1k | 1,000 | 35 ₪ | ~$9 |
| power-10k | 10,000 | 280 ₪ | ~$75 |

100 monthly-1k customers = 3,500 ₪/month.

## File map

| File | Purpose |
|---|---|
| `server.js` | Paid agent: HTTP, x402, API keys, admin, invoice, dashboard |
| `test.js` | 31 E2E tests |
| `package.json` | zero runtime deps |
| `Dockerfile` | container for Railway/Fly/Render/any VPS |
| `railway.toml` | Railway config |
| `fly.toml` | Fly.io config |
| `render.yaml` | Render config |
| `bin/cloudflared.exe` | Cloudflare Tunnel binary |
| `bin/tunnel.js` | Quick-tunnel launcher |
| `.env.example` | config template |
| `data/earnings.db` | SQLite (auto-created) |

## License

MIT