# WhatsApp integration roadmap

Status: **scaffold only** — `whatsapp-webhook.js` exists but is **not mounted** in `server.js` until Phase 2.

## Goals

1. Let tenants route customer WhatsApp messages to their AI worker (same brain as web chat).
2. Support Israeli businesses where WhatsApp is the primary channel.
3. Reuse existing worker memory, leads, escalations, and business-hours tools.

## Provider options

| Provider | Pros | Cons | Env vars |
|----------|------|------|----------|
| **Meta Cloud API** | Official, scalable, template messages | Business verification, webhook HTTPS | `WHATSAPP_PROVIDER=meta`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` |
| **Twilio** | Fast sandbox, good docs | Per-message cost, Meta policy still applies | `WHATSAPP_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` |

See `.env.production.example` for the full list.

## Architecture (target)

```
Customer WhatsApp
       │
       ▼
Meta / Twilio webhook  →  POST /api/webhooks/whatsapp
       │
       ▼
whatsapp-webhook.js (parse + verify)
       │
       ▼
workers.js — resolve tenant by phone mapping, workers.chat()
       │
       ▼
Outbound reply API (Meta messages API or Twilio Messages)
```

## Phases

### Phase 1 — Scaffold (this repo)

- [x] `whatsapp-webhook.js` stub (verify + parse inbound)
- [x] Env vars documented in `.env.production.example`
- [x] This roadmap

### Phase 2 — Wire webhook

- [ ] Import `handleWhatsAppWebhook` in `server.js` (single route block, no landing changes)
- [ ] Extend `/health` with `whatsapp: whatsappConfigStatus()` (optional)
- [ ] Register webhook URL in Meta/Twilio: `https://<PUBLIC_BASE_URL>/api/webhooks/whatsapp`

### Phase 3 — Tenant mapping

- [ ] DB table: `whatsapp_routes (phone_e164, tenant_id, worker_id)`
- [ ] Admin UI or env fallback: `WORKER_<id>_WHATSAPP_PHONE`
- [ ] 24h session window handling (Meta policy)

### Phase 4 — Outbound + templates

- [ ] Send text replies via provider API
- [ ] Hebrew template messages for outbound-initiated chats (appointment reminders, etc.)
- [ ] Rate limits + opt-out keyword (הסר)

## Local testing

1. Use ngrok or `npm run tunnel` to expose localhost.
2. Meta: set verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`.
3. Twilio sandbox: join sandbox from your phone, point webhook to `/api/webhooks/whatsapp`.

## Security checklist

- Verify Meta `hub.verify_token` on GET (implemented in stub).
- Validate Twilio request signature before trusting POST body (TODO Phase 2).
- Never log full access tokens or customer PII in production logs.
- Per-tenant isolation: one phone number must map to exactly one worker.

## Links

- [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api)
- [Twilio WhatsApp](https://www.twilio.com/docs/whatsapp)
