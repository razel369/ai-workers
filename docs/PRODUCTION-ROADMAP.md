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

## Phase 8 — Recurring revenue loop

- [x] Platform transactional email/WhatsApp with retrying outbox (`notify.js`)
- [x] Daily billing cycle: T-7/T-3/T-1 reminders, trial expiry (`billing-lifecycle.js`)
- [x] Grace period instead of a hard cutoff — a lapsed worker keeps serving
- [x] Dunning stages 1-3, then reversible suspension (data preserved)
- [x] Payment receipts on successful charge
- [x] Paddle `subscription.canceled` / `past_due` / `payment_failed` handled
- [x] Plan tiers incl. bundles and annual prepay (`GET /api/plans`)
- [ ] Move `PADDLE_ENVIRONMENT` to `production` and verify a live card
- [ ] Configure a mail provider + `MAIL_FROM` in Railway

## Phase 9 — Unit economics

- [x] Per-tenant token + cost attribution on every LLM call (`usage-metering.js`)
- [x] Real monthly message quotas enforced from the plan
- [x] Cost-appropriate default model (`gpt-4o-mini`) instead of a frontier default
- [x] Margin report per tenant (`GET /api/admin/margin`)
- [x] First-party funnel analytics — the old client only ran on `*.vercel.app`
- [ ] Verify `MODEL_PRICING_JSON` against the live provider's price list

## Phase 10 — Reliability

- [x] Daily encrypted hot backups (`VACUUM INTO`) with off-site S3 upload
- [x] Restore path + automated archive round-trip test
- [x] Cross-tenant aggregate scans cached (were O(tenants) per request)
- [x] CI green — `business-tests.js` covers every new subsystem
- [ ] Configure `BACKUP_S3_*` and store `BACKUP_ENCRYPTION_KEY` off-box
- [ ] Rehearse a production restore into staging

## Phase 11 — WhatsApp production readiness

- [x] Meta `X-Hub-Signature-256` + Twilio `X-Twilio-Signature` verification
- [x] 24-hour customer service window tracked per (number, customer)
- [x] Approved Hebrew template messages outside the window
- [ ] Get Hebrew templates approved in Meta Business Manager
- [ ] Set `WHATSAPP_APP_SECRET` and `WHATSAPP_TEMPLATE_REENGAGE`
- [ ] Admin UI for multi-number routing

## Phase 12 — Privacy compliance

- [x] Configurable retention with automatic purge (leads deliberately exempt)
- [x] Data subject access + erasure endpoints by phone/email/conversation id
- [x] AI disclosure appended after the tenant's persona so it cannot be removed
- [x] DPA template (`docs/legal/dpa-he.md`)
- [ ] Sign a DPA with each tenant and with the LLM provider
- [ ] Publish a data-protection contact and an incident procedure
