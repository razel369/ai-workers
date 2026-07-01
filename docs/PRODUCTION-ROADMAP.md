# Production roadmap

Track deployment and feature phases for AI Workers production launch.

## Phase 1 — Railway production

- [ ] Dockerfile copies bootstrap-env, integrations, google-media, docs/legal
- [ ] `scripts/railway-deploy.ps1` guides deploy + health check
- [ ] README documents Railway dashboard steps (no CLI login required)
- [ ] `railway.toml` + `.env.production.example` ready to paste

## Phase 2 — Auto payment activation

- [ ] PayPal IPN/webhook stub + payment proof auto-verify
- [ ] `POST /api/webhooks/bit` documented
- [ ] Auto-activate on verified webhook or trial mode
- [ ] Paywall Hebrew copy includes activation SLA

## Phase 3 — WhatsApp outbound

- [ ] `whatsapp-webhook.js` mounted in `server.js`
- [ ] Meta Cloud API send stub (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`)
- [ ] `send_whatsapp_message` tool when integration connected
- [ ] `docs/WHATSAPP-ROADMAP.md` updated

## Phase 4 — Integrations polish

- [ ] Catalog API + builder "חיבורים לעסק"
- [ ] Encrypted credential store
- [ ] Webhook + MCP + HubSpot CRM scaffold working

## Phase 5 — Chat widget embed

- [ ] `GET /embed.js` floating widget
- [ ] Copy-paste snippet docs
- [ ] CORS-safe public worker chat

## Phase 6 — Trial + onboarding

- [ ] `TRIAL_DAYS=14` auto-activates new workers
- [ ] First-run onboarding modal (3 Hebrew steps) in marketplace

## Phase 7 — Invoices + case studies

- [ ] `GET /invoice/:workerId` HTML receipt with מע"מ placeholder
- [ ] Landing page: 3 case study cards (Hebrew pilot copy)
