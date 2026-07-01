# Production roadmap

Track deployment and feature phases for AI Workers production launch.

## Phase 1 — Railway production

- [x] Dockerfile copies bootstrap-env, integrations, google-media, docs/legal
- [x] `scripts/railway-deploy.ps1` guides deploy + health check
- [x] README documents Railway dashboard steps (no CLI login required)
- [x] `railway.toml` + `.env.production.example` ready to paste

## Phase 2 — Auto payment activation

- [x] PayPal IPN/webhook stub + payment proof auto-verify
- [x] `POST /api/webhooks/bit` documented (`docs/PAYMENTS.md`)
- [x] Auto-activate on verified webhook or trial mode (`TRIAL_DAYS`, `PAYMENT_AUTO_VERIFY`)
- [x] Paywall Hebrew copy includes activation SLA (`ACTIVATION_SLA_HE`)

## Phase 3 — WhatsApp outbound

- [x] `whatsapp-webhook.js` mounted in `server.js`
- [x] Meta Cloud API send stub (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`)
- [x] `send_whatsapp_message` tool when integration connected
- [x] `docs/WHATSAPP-ROADMAP.md` updated

## Phase 4 — Integrations polish

- [x] Catalog API + builder "חיבורים לעסק"
- [x] Encrypted credential store
- [x] Webhook + MCP + HubSpot CRM scaffold working

## Phase 5 — Chat widget embed

- [x] `GET /embed.js` floating widget (`embed-widget.js`)
- [x] Copy-paste snippet docs (`docs/EMBED-WIDGET.md`)
- [x] CORS-safe public worker chat (`/api/embed/*` reflects `Origin` when `EMBED_ALLOW_PUBLIC=1`)

## Phase 6 — Trial + onboarding

- [x] `TRIAL_DAYS=14` auto-activates new workers (`buyTemplate` + `.env.production.example`)
- [x] First-run onboarding modal (3 Hebrew steps) in marketplace

## Phase 7 — Invoices + case studies

- [x] `GET /invoice/:workerId` HTML receipt with מע"מ placeholder
- [x] Landing page: 3 case study cards (Hebrew pilot copy)
