# תשלומים והפעלה אוטומטית

## תהליך ידני (ברירת מחדל)

1. הלקוח משלם ב-Bit / PayPal / העברה בנקאית.
2. מה-paywall: `POST /api/workers/:id/activation-request` עם אסמכתא ופרטי קשר.
3. האדמין מאשר ב-`#/admin` או `POST /api/admin/mark-worker-paid`.

**SLA:** מוגדר ב-`ACTIVATION_SLA_HOURS` (ברירת מחדל 24). מוצג ב-paywall בעברית.

## ניסיון חינם — opt-in בלבד

ברירת המחדל הבטוחה בפרודקשן היא `TRIAL_DAYS=0`. שינוי הערך מפעיל עובדים חדשים ללא תשלום ולכן דורש אישור מפורש של בעל העסק למשך ולתקציב השימוש. לדוגמה, רק לאחר אישור 14 ימים:

```bash
TRIAL_DAYS=14
```

עובדים חדשים נוצרים כ-`active` עם `paid_until` ל-14 יום — ללא אישור אדמין. אין להעתיק הגדרה זו לפרודקשן לפני האישור.

## אימות אוטומטי (stub)

```bash
PAYMENT_AUTO_VERIFY=1
```

בקשות הפעלה עם אסמכתא שמתחילה ב-`AUTO-`, `PP-VERIFY-`, או `BIT-VERIFY-` מופעלות אוטומטית (לפיילוט/בדיקות).

## Webhook — Bit

`POST /api/webhooks/bit`

כותרת חובה: `X-Webhook-Secret: <BIT_WEBHOOK_SECRET>`

```json
{
  "workerId": "wk_...",
  "tenantId": "ten_...",
  "reference": "BIT-12345",
  "amount": 249
}
```

Bit אינו מספק webhook רשמי לכל עסק — ניתן לחבר מתאם פנימי מהימן או לעדכן ידנית. האנדפוינט מפעיל רק אירוע חתום עם אסמכתה ייחודית וסכום מדויק התואם למחיר החודשי של התבנית.

## Webhook — PayPal

`POST /api/webhooks/paypal`

כותרת: `X-Webhook-Secret: <PAYPAL_WEBHOOK_SECRET>`

```json
{
  "workerId": "wk_...",
  "tenantId": "ten_...",
  "payment_status": "Completed",
  "txn_id": "PP-123",
  "mc_gross": "249.00",
  "mc_currency": "ILS"
}
```

הנתיב תומך גם בגוף `application/x-www-form-urlencoded`, אך זהו מתאם פנימי
המוגן בסוד משותף — לא אימות חתימה רשמי מול PayPal. הפעלה מתבצעת רק עבור
`Completed`, אסמכתה ייחודית, מטבע `ILS` וסכום מדויק התואם למחיר התבנית.
תשלום חדש לעובד פעיל מאריך את `paidUntil`; replay של אותה אסמכתה הוא idempotent.

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
