# Paid-Agent Demo (v0.4.0) — Israel-friendly edition

A paid AI agent that works **without a registered business**.

Three ways to get an API key:
1. **Pay via PayPal.me / Bit / Buy Me a Coffee / bank transfer** (oldschool, no business needed in Israel) → owner issues key within 24h
2. **Pay per call with USDC** via x402 (crypto, instant, no signup)
3. **Subscribe via GitHub Sponsors** (after you publish the code)

Zero npm dependencies. Single Node.js process.

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

## Quick start (mock mode, zero setup)

```powershell
# Generate an admin token (for issuing API keys later)
$env:ADMIN_TOKEN = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
Write-Host "ADMIN_TOKEN=$env:ADMIN_TOKEN"

npm test    # runs 31 tests against a fresh server
npm start   # starts on :3000
```

Open http://localhost:3000/ for the dashboard.

## Configure it for Israel (10 minutes)

Edit `.env` (or set env vars) and fill in **only the ones you want to enable**:

```powershell
# Who you are
$env:AGENT_NAME              = "Razel's AI Tools"
$env:AGENT_DESCRIPTION       = "Smart AI agent for Hebrew/English text"
$env:AGENT_OWNER_CONTACT     = "razel@example.com"
$env:PUBLIC_BASE_URL         = "https://your-host.example.com"

# Oldschool channels (any subset)
$env:PAYPAL_ME               = "razel"            # -> paypal.me/razel
$env:BUY_ME_A_COFFEE         = "https://buymeacoffee.com/razel"
$env:KO_FI                   = "https://ko-fi.com/razel"
$env:BIT_PHONE               = "972541234567"     # -> bitpay.co.il link
$env:GITHUB_SPONSORS         = "razel"            # -> github.com/sponsors/razel
$env:GUMROAD_URL             = "https://razel.gumroad.com/l/paid-agent-template"

# Israeli bank invoice
$env:PAYEE_NAME              = "Razel M."
$env:BANK_NAME               = "Bank Hapoalim"
$env:BANK_BRANCH             = "620"
$env:BANK_ACCOUNT            = "123456"
$env:IBAN                    = "IL62 0126 2000 0000 1234 567"   # optional
$env:SWIFT                   = "POALILIT"                       # optional

# x402 (crypto path, optional)
$env:NETWORK                 = "base-sepolia"    # for real money: "base"
$env:WALLET_ADDRESS          = "0xYourAddress"
$env:PRICE_USDC              = "0.05"

# Admin (REQUIRED for manual key issuance)
$env:ADMIN_TOKEN             = "your-secret-token-from-above"
```

Then `npm start` and open the dashboard.

## How the oldschool path actually works

1. Customer opens `https://your-host/invoice`
2. They pick a plan (`credits-100`, `monthly-1k`, `power-10k`)
3. They pay via **any channel listed** (PayPal.me, Bit, bank transfer, etc.)
4. They email you the screenshot + plan id
5. **You issue their key** (one curl command):

```powershell
$env:ADMIN_TOKEN = "your-secret"
Invoke-WebRequest -Uri "https://your-host/admin/issue-key?token=$env:ADMIN_TOKEN" `
  -Method POST -Headers @{ "content-type" = "application/json" } `
  -Body '{"planId":"monthly-1k","channel":"paypal","reference":"PP-12345","label":"John D."}'
```

Response:
```json
{
  "ok": true,
  "key": "sk_a1b2c3d4...",
  "plan": "monthly-1k",
  "callsLimit": 1000,
  "note": "Send this key to the customer once..."
}
```

6. You paste that key into an email to the customer.
7. Customer uses it:

```powershell
curl -X POST https://your-host/entrypoints/summarize/invoke `
  -H "authorization: Bearer sk_a1b2c3d4..." `
  -H "content-type: application/json" `
  -d '{"text":"hello world"}'
```

That's it. No Stripe. No business registration.

## Why this works for Israeli individuals

| Channel | Why it's legal/easy in Israel |
|---|---|
| **PayPal.me** | Personal accounts can receive in Israel; no business needed up to moderate volume |
| **Bit** | Israeli peer-to-peer app, designed for individuals |
| **Buy Me a Coffee / Ko-fi** | International platforms; payout to Israeli bank |
| **Bank transfer (masheh)** | Universal; just invoice + IBAN |
| **Gumroad** | "Merchant of record" — they collect + remit VAT; you get paid to your bank |
| **GitHub Sponsors** | Available in Israel; works once you have a public repo |
| **Crypto (x402)** | No bank/KYC at all for the receiver |

## Revenue math (Israeli pricing)

| Plan | Calls | ILS | USD | Use case |
|---|---|---|---|---|
| credits-100 | 100 | 18 | ~$5 | one-off use |
| monthly-1k | 1,000 | 35 | ~$9 | solo developer, monthly |
| power-10k | 10,000 | 280 | ~$75 | small team / heavy use |

100 monthly-1k customers = 3,500 ILS/month (~$900).

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

## What the agent does (5 entrypoints)

| key | description | x402 price |
|---|---|---|
| `summarize` | condense text | $0.05 |
| `translate` | stub | $0.05 |
| `sentiment` | score -1..1 | $0.05 |
| `extract-entities` | pull capitalized phrases | $0.05 |
| `word-count` | chars/words/sentences | $0.001 |

Drop in a real LLM call in the handler (look for `handler: async ({ text }) =>` in `server.js`).

## How to scale this beyond manual key issuance

When volume grows past "I can email each customer":

1. **Buy Me a Coffee webhooks** → auto-issue API key on payment
2. **Gumroad webhooks** → same
3. **Wise personal account** + invoice automation
4. **Register a business** (osek patur / osek murshe) — then you can add Stripe Israel via their partner program

For now: zero business, zero Stripe, fully working.

## File map

| File | Purpose |
|---|---|
| `server.js` | Paid agent: HTTP, x402, API keys, admin, invoice, dashboard |
| `test.js` | 31 E2E tests |
| `package.json` | zero runtime deps |
| `.env.example` | config template |
| `data/earnings.db` | SQLite (auto-created) |

## License

MIT
