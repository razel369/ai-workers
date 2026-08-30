# WhatsApp integration roadmap

Status: **verified inbound routing + configured outbound** — webhook mounted; every provider route is provisioned by an admin and uniquely owned. Meta send requires `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID`; Twilio requires its provider credentials.

## Goals

1. Let tenants route customer WhatsApp messages to their AI worker (same brain as web chat).
2. Support Israeli businesses where WhatsApp is the primary channel.
3. Reuse existing worker memory, leads, escalations, and business-hours tools.

## Provider options

| Provider | Pros | Cons | Env vars |
|----------|------|------|----------|
| **Meta Cloud API** | Official, scalable, template messages | Business verification, webhook HTTPS | `WHATSAPP_PROVIDER=meta`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN` or `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` or `WHATSAPP_PHONE_ID` |
| **Twilio** | Fast sandbox, good docs | Per-message cost, Meta policy still applies | `WHATSAPP_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` |

Per-tenant credentials can also be stored via **חיבורים לעסק → WhatsApp Business** (`send_whatsapp_message` tool).

## Architecture

```
Customer WhatsApp
       │
       ▼
Meta / Twilio webhook  →  POST /api/webhooks/whatsapp
       │
       ▼
whatsapp-webhook.js (parse + signature verification + durable dedupe)
       │
       ▼
whatsapp-router.js — exact provider/phone route to one tenant and worker
       │
       ▼
workers.js — payment/readiness/quota gates, then worker chat
       │
       ▼
integrations/runner.js — Meta Graph API send (or stub)
```

## Phases

### Phase 1 — Scaffold

- [x] `whatsapp-webhook.js` (verify + parse inbound)
- [x] Env vars in `.env.production.example`

### Phase 2 — Wire webhook

- [x] `handleWhatsAppWebhook` mounted in `server.js`
- [x] `/health` includes `whatsapp: whatsappConfigStatus()`
- [ ] Register webhook URL in Meta/Twilio: `https://<PUBLIC_BASE_URL>/api/webhooks/whatsapp`

### Phase 3 — Tenant mapping

- [x] DB table: `whatsapp_routes` on platform DB (phone_key → tenant_id, worker_id)
- [x] Admin-only provisioning: `POST /api/admin/whatsapp-route`
- [x] Tenant endpoint is fail-closed (`403 admin_provisioning_required`); connecting credentials never claims a route
- [x] A provider/phone tuple cannot be reassigned across tenants; identical provisioning is idempotent
- [x] Inbound → `workers.chatWithWorker()` → outbound Meta/Twilio send
- [ ] Admin UI for multi-number routing
- [ ] 24h session window handling (Meta policy)

### Phase 4 — Outbound

- [x] `send_whatsapp_message` tool via integrations
- [x] Meta Cloud API send when `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID` set
- [ ] Hebrew template messages for outbound-initiated chats
- [x] Auto-reply inbound to worker chat when the verified provider route and outbound credentials are configured

## Local testing

1. Use ngrok or `npm run tunnel` to expose localhost.
2. Meta: set verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`.
3. Twilio sandbox: join sandbox from your phone, point webhook to `/api/webhooks/whatsapp`.

## Security checklist

- Verify Meta `hub.verify_token` on GET (implemented).
- Verify Meta SHA-256 and Twilio SHA-1 request signatures before trusting POST bodies (implemented).
- Never log full access tokens or customer PII in production logs.
- Per-tenant isolation: one phone number must map to exactly one worker.
- Never fall back to a global/default worker when an inbound route is missing.

## Links

- [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api)
- [Twilio WhatsApp](https://www.twilio.com/docs/whatsapp)
