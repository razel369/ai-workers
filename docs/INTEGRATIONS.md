# חיבורים לעסק — Integration Hub

מודול `integrations/` מאפשר לכל tenant לחבר את המערכות שהעסק כבר משתמש בהן. עובדי AI מקבלים כלים אוטומטית לפי החיבורים הפעילים.

## ארכיטקטורה

```
workers-ui (חיבורים לעסק)
       │
       ▼
POST /api/integrations  →  integrations/store.js (SQLite מוצפן per-tenant)
       │
       ▼
workers.js chatWithWorker  →  integrations/tools.js  →  integrations/runner.js
       │
       ▼
ספק חיצוני (HubSpot, Shopify, webhook, MCP, …)
```

## API

| נתיב | תיאור |
|------|--------|
| `GET /api/integrations/catalog` | קטלוג סוגי חיבור (עברית, שדות נדרשים) |
| `GET /api/integrations` | חיבורים של ה-tenant (סודות מוסווים) |
| `POST /api/integrations` | חיבור / עדכון `{ type, label?, config }` |
| `DELETE /api/integrations/:id` | ניתוק |
| `POST /api/integrations/:id/test` | בדיקת חיבור |

## קטלוג חיבורים

| סוג | קטגוריה | סטטוס | כלים לעובד |
|-----|---------|--------|------------|
| `webhook` | Webhook | **עובד** | `notify_webhook` |
| `mcp` | MCP | **עובד** | כלי MCP מתגלים אוטומטית |
| `google_calendar` | יומן | חלקי (קישור Cal.com) | `check_availability`, `book_appointment` |
| `whatsapp` | הודעות | חלקי (Meta stub) | `send_whatsapp_message` |
| `email_sendgrid` | אימייל | חלקי | `send_email` |
| `email_smtp` | אימייל | scaffold | `send_email` |
| `crm_hubspot` | CRM | **עובד** (sync ליד) | `sync_lead_to_crm` |
| `crm_pipedrive` | CRM | scaffold | `sync_lead_to_crm` |
| `crm_monday` | CRM | scaffold | `sync_lead_to_crm` |
| `shopify` | מסחר | **עובד** (חיפוש הזמנה) | `lookup_order` |
| `woocommerce` | מסחר | scaffold | `lookup_order` |
| `bit_notify` | ישראלי | scaffold | `notify_webhook` |
| `google_sheets` | ישראלי | scaffold (CSV מקומי) | `export_leads_csv` |

## הגדרה לפי ספק

### Webhook (Zapier / Make / n8n)

```json
POST /api/integrations
{ "type": "webhook", "config": { "url": "https://hooks.zapier.com/..." } }
```

### HubSpot CRM

1. צור Private App ב-HubSpot → העתק Access Token
2. `{ "type": "crm_hubspot", "config": { "apiKey": "pat-..." } }`
3. בדיקה: `POST /api/integrations/:id/test`

### Shopify

```json
{ "type": "shopify", "config": { "shopDomain": "mystore.myshopify.com", "accessToken": "shpat_..." } }
```

### Google Calendar / Cal.com

```json
{ "type": "google_calendar", "config": { "bookingLink": "https://cal.com/your-business" } }
```

### WhatsApp Business

ראה גם [WHATSAPP-ROADMAP.md](./WHATSAPP-ROADMAP.md).

```env
WHATSAPP_PROVIDER=meta
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
```

Webhook נכנס: `GET/POST /api/webhooks/whatsapp`

### MCP (Bring Your Own)

```json
{ "type": "mcp", "config": { "url": "https://mcp.example.com/mcp", "name": "My MCP" } }
```

כתובות MCP עוברות בדיקת SSRF (`url-security.js`) — localhost ו-metadata חסומים בפרודקשן.

## אבטחה

- אישורים נשמרים ב-`integrations` table בתוך `workers.db` של כל tenant
- הצפנה: AES-256-GCM, מפתח נגזר מ-`INTEGRATIONS_SECRET` + `tenantId`
- API לעולם לא מחזיר מפתחות גולמיים — רק `••••1234`
- לוגים ב-runner מסננים שדות רגישים
- URLs חיצוניים עוברים `validatePublicHttpUrl` לפני fetch

## משתני סביבה

| משתנה | תיאור |
|--------|--------|
| `INTEGRATIONS_SECRET` | מלח הצפנה לחיבורים (חובה בפרודקשן) |
| `WEBHOOK_NOTIFY_URL` | גיבוי גלובלי ל-webhook |
| `MEETING_BOOKING_URL` | גיבוי לקישור תורים |
| `WHATSAPP_*` | WhatsApp Cloud API |
| `ALLOW_PRIVATE_NETWORK_URLS=1` | רק לבדיקות MCP מקומיות |

## זרימת דמו

1. `npm start` — הגדר `ADMIN_TOKEN`, הנפק מפתח tenant
2. פתח `/builder` → אשף עובד → שלב **חיבורים לעסק**
3. חבר Webhook עם URL של webhook.site
4. לחץ **בדוק** — אמור לקבל `integration_test`
5. צור עובד מכירות — כלי `sync_lead_to_crm` יופעל אוטומטית אחרי חיבור HubSpot
