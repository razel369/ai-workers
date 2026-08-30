# Production roadmap

Track deployment and feature phases for AI Workers production launch.

## Phase 1 — Render production migration

- [x] Dockerfile copies bootstrap-env, integrations, google-media, docs/legal
- [x] `render.yaml` targets Frankfurt, one 512 MB service, service auto-deploys off, `/infra-ready`, and a 1 GB disk at `/app/data`
- [x] README and `.env.production.example` document the Render configuration
- [ ] Stop before `Deploy Blueprint` until the owner explicitly approves the live price; after creation set Blueprint Auto Sync to No separately
- [ ] Create the paid Render service through **New → Blueprint** from `codex/revive-ai-workers-baseline` and verify it; no live production URL exists yet
- [ ] Decide between a fresh launch and a verified Railway data recovery
- [ ] Disable Vercel production auto-deploys from `main` before merging the migration
- [ ] Cut over durably: update `render.yaml`, the Blueprint linked branch, and the service branch to `main`, then run one Manual Sync with Auto Sync left off

## Phase 2 — Auto payment activation

- [x] Internal shared-secret PayPal form/JSON adapter + payment proof auto-verify
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

## Phase 6 — Optional trial + onboarding

- [x] `TRIAL_DAYS>0` can auto-activate new workers (`buyTemplate`)
- [x] Safe production default remains `TRIAL_DAYS=0` until the owner approves a trial offer and usage budget
- [x] First-run onboarding modal (3 Hebrew steps) in marketplace

## Phase 7 — Invoices + case studies

- [x] `GET /invoice/:workerId` HTML order summary with a clear non-tax-document notice
- [x] Landing page: 3 case study cards (Hebrew pilot copy)
