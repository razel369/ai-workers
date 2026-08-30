# Production roadmap

Track deployment and feature phases for AI Workers production launch.

## Phase 1 — Oracle Always Free production migration

- [x] Dockerfile copies bootstrap-env, integrations, google-media, docs/legal and defaults `INSTALL_TUNNEL=0` for ARM64
- [x] `compose.oci.yaml` keeps port 8765 private, binds persistent `./data` to `/app/data`, and terminates HTTPS with Caddy
- [x] `.env.oci.example` and `deploy/oci/` document safe bootstrap, deployment, health gates, and off-VM backup
- [x] The paid Render route was rejected; its project remains empty with zero services and the actionable `render.yaml` Blueprint was removed
- [ ] Owner creates/logs into an Oracle Free Tier account and chooses the home region
- [ ] Create only a `VM.Standard.A1.Flex` resource labelled **Always Free Eligible**, 1 OCPU / 4 GB, with a 50 GB boot volume and a zero estimate
- [ ] Configure a free hostname, restrict SSH to the owner IP, and expose only 80/443
- [ ] Decide between a fresh launch and a verified Railway data recovery
- [ ] Configure real owner contact, two distinct secrets, a free-quota or otherwise approved LLM, and a real payment channel
- [ ] Verify `/health`, `/infra-ready`, `/ready`, an off-VM backup/restore, and a real buyer flow
- [ ] Disable Vercel production auto-deploys from `main` before merging the migration
- [ ] Merge and cut over only after the deployed candidate passes every gate

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
