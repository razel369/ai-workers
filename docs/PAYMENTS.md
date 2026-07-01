# תשלומים והפעלה אוטומטית

## תהליך ידני (ברירת מחדל)

1. הלקוח משלם ב-Bit / PayPal / העברה בנקאית.
2. מה-paywall: `POST /api/workers/:id/activation-request` עם אסמכתא ופרטי קשר.
3. האדמין מאשר ב-`#/admin` או `POST /api/admin/mark-worker-paid`.

**SLA:** מוגדר ב-`ACTIVATION_SLA_HOURS` (ברירת מחדל 24). מוצג ב-paywall בעברית.

## ניסיון חינם

```bash
TRIAL_DAYS=14
```

עובדים חדשים נוצרים כ-`active` עם `paid_until` ל-14 יום — ללא אישור אדמין.

## אימות אוטומטי (stub)

```bash
PAYMENT_AUTO_VERIFY=1
```

בקשות הפעלה עם אסמכתא שמתחילה ב-`AUTO-`, `PP-VERIFY-`, או `BIT-VERIFY-` מופעלות אוטומטית (לפיילוט/בדיקות).

## Webhook — Bit

`POST /api/webhooks/bit`

כותרת (אופציונלי): `X-Webhook-Secret: <BIT_WEBHOOK_SECRET>`

```json
{
  "workerId": "wk_...",
  "tenantId": "ten_...",
  "reference": "BIT-12345",
  "amount": 249
}
```

Bit אינו מספק webhook רשמי לכל עסק — ניתן לחבר Zapier/Make לבנק או לעדכן ידנית. האנדפוינט מיועד לאינטגרציה עתידית ולאימות פנימי.

## Webhook — PayPal

`POST /api/webhooks/paypal`

כותרת: `X-Webhook-Secret: <PAYPAL_WEBHOOK_SECRET>`

```json
{
  "workerId": "wk_...",
  "tenantId": "ten_...",
  "payment_status": "Completed",
  "txn_id": "PP-123"
}
```

תומך גם ב-IPN מסוג `application/x-www-form-urlencoded`.

## עקיפת אדמין

האדמין תמיד יכול לאשר ידנית ב-`#/admin` גם כש-webhook נכשל.

משתני סביבה:

| משתנה | תיאור |
|--------|--------|
| `PAYMENT_AUTO_VERIFY` | `1` = stub אוטומטי על אסמכתאות מסומנות |
| `BIT_WEBHOOK_SECRET` | סוד ל-`/api/webhooks/bit` |
| `PAYPAL_WEBHOOK_SECRET` | סוד ל-`/api/webhooks/paypal` |
| `PAYMENT_WEBHOOK_SECRET` | סוד משותף לשני ה-webhooks |
| `ACTIVATION_SLA_HOURS` | שעות SLA לתצוגה ב-paywall |
