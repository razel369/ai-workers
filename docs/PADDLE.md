# Paddle — סליקת אשראי (Merchant of Record)

Paddle משמש כ-**Merchant of Record**: הם מוכרים רשמית, גובים מע"מ/מסות בחו"ל, ומעבירים אליך את הכסף. מתאים לפרטי בישראל **בלי חברה** — עדיין צריך לדווח הכנסה לרשות המיסים.

## משתני סביבה (Railway)

```env
PADDLE_ENVIRONMENT=sandbox          # sandbox | production
PADDLE_CLIENT_TOKEN=test_...        # Client-side token (Paddle Dashboard)
PADDLE_API_KEY=                     # אופציונלי — לפעולות שרת מתקדמות
PADDLE_WEBHOOK_SECRET=pdl_ntfset_... # מ-Notification destination
PADDLE_PRICE_ID=pri_...             # מחיר מנוי חודשי ברירת מחדל
# אופציונלי — מחיר לפי תבנית:
PADDLE_PRICE_MAP={"support-he":"pri_xxx","default":"pri_yyy"}
```

## הגדרה ב-Paddle (פעם אחת)

### 1. חשבון
1. הירשם ב-[paddle.com](https://www.paddle.com)
2. מלא KYC (ת.ז. + פרטים אישיים — לא חייב חברה)

### 2. מוצר ומחיר
1. **Catalog → Products** → צור מוצר "AI Worker Monthly"
2. הוסף **Price** מנוי חודשי (למשל ₪249 / $69)
3. העתק `price_id` (מתחיל ב-`pri_`) → `PADDLE_PRICE_ID`

### 3. Client token
1. **Developer tools → Authentication**
2. העתק **Client-side token** → `PADDLE_CLIENT_TOKEN`

### 4. Webhook
1. **Developer tools → Notifications → New destination**
2. URL: `https://paid-agent-demo-production.up.railway.app/api/webhooks/paddle`
3. Events:
   - `subscription.created`
   - `subscription.activated`
   - `subscription.updated`
   - `transaction.completed`
4. העתק **Endpoint secret key** → `PADDLE_WEBHOOK_SECRET`

### 5. בדיקה (Sandbox)
1. הגדר `PADDLE_ENVIRONMENT=sandbox`
2. פתח מרקטפלייס → עובד → **להפעיל ללקוחות**
3. לחץ **שלמו בכרטיס אשראי**
4. השתמש בכרטיס בדיקה של Paddle
5. אחרי webhook — העובד אמור להיות **פעיל** בלי אדמין

## זרימה באתר

```
לקוח → Paywall → Paddle Checkout (overlay)
       → webhook subscription.created / transaction.completed
       → autoActivateWorker (30 יום)
       → redirect לצ'אט
```

Bit / PayPal / בנק נשארים כ**גיבוי ידני** עם אישור אדמין.

## עלויות Paddle (בערך)

- ~5% + $0.50 לעסקה (בדוק בדשבורד)
- כולל טיפול במע"מ בינלאומי

## דיווח מס בישראל

Paddle מעביר payouts — אתה מדווח כהכנסה אישית (עוסק זעיר / פטור לפי מחזור). התייעץ עם רואה חשבון.
