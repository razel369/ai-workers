# Paddle — סליקת אשראי (Merchant of Record)

Paddle משמש כ-**Merchant of Record**: הם מוכרים רשמית, גובים מע"מ/מסות בחו"ל, ומעבירים אליך את הכסף. מתאים לפרטי בישראל **בלי חברה** — עדיין צריך לדווח הכנסה לרשות המיסים.

## משתני סביבה (קובץ `.env` המוגן בשרת)

```env
PADDLE_ENVIRONMENT=sandbox          # sandbox | production
PADDLE_CLIENT_TOKEN=test_...        # Client-side token (Paddle Dashboard)
PADDLE_API_KEY=                     # חובה; הרשאת transaction.write מינימלית
PADDLE_WEBHOOK_SECRET=pdl_ntfset_... # מ-Notification destination
# חובה: price id מפורש לכל תבנית שמוצעת לרכישה. אין fallback משותף.
PADDLE_PRICE_MAP={"sales-leads-il":"pri_sales","support-he":"pri_support"}
```

## הגדרה ב-Paddle (פעם אחת)

### 1. חשבון
1. הירשם ב-[paddle.com](https://www.paddle.com)
2. מלא KYC (ת.ז. + פרטים אישיים — לא חייב חברה)

### 2. מוצר ומחיר
1. **Catalog → Products** → צור מוצר "AI Worker Monthly"
2. הוסף **Price** מנוי חודשי לכל מחיר שמופיע במוצר.
3. העתק כל `price_id` (מתחיל ב-`pri_`) ל-`PADDLE_PRICE_MAP` תחת ה-template המתאים.
4. production readiness נכשל אם אפילו תבנית מוצעת אחת חסרה במפה. כך ה-checkout
   וה-webhook לא יכולים להשתמש בשני מחירים שונים.

### 3. Client token
1. **Developer tools → Authentication**
2. העתק **Client-side token** → `PADDLE_CLIENT_TOKEN`

### 4. Webhook
1. **Developer tools → Notifications → New destination**
2. URL: `https://YOUR_DOMAIN/api/webhooks/paddle`
3. Events:
   - `transaction.completed`
   - `subscription.created`
   - `adjustment.created`
   - `adjustment.updated`
   - `subscription.canceled`
   - `subscription.paused`
4. העתק **Endpoint secret key** → `PADDLE_WEBHOOK_SECRET`

### 5. בדיקה (Sandbox)
1. הגדר `PADDLE_ENVIRONMENT=sandbox`
2. פתח מרקטפלייס → עובד → **להפעיל ללקוחות**
3. לחץ **שלמו בכרטיס אשראי**
4. השתמש בכרטיס בדיקה של Paddle
5. אחרי webhook מאומת — יש לבצע polling לסטטוס העובד. רק תשובת שרת שבה
   `isActive=true` מאפשרת להציג הצלחה.

## זרימה באתר

```
לקוח → Paywall → Paddle Checkout (overlay)
       → השרת יוצר transaction ב-Paddle ושומר transaction_id → tenant/worker
       → הדפדפן מקבל רק transactionId, בלי tenant/worker ב-customData
       → webhook transaction.completed
       → אימות חתימה + transaction ממופה + מחיר/כמות/סכום מדויקים בשקלים
       → autoActivateWorker (30 יום)
       → redirect לצ'אט
```

אירוע webhook שאינו ממופה ל-transaction/subscription שנוצרו או נקשרו בשרת
נכשל סגור ואינו משנה עובד. `custom_data` נשמר ב-Paddle לצורכי התאמה בלבד ואינו
מקור סמכות. מיפויי הסליקה נשמרים ב-`DATA_DIR/paddle-authority.db`, ולכן יש לכלול
את כל `DATA_DIR` בגיבוי.

Bit / PayPal / בנק נשארים כ**גיבוי ידני** עם אישור אדמין.

## עלויות Paddle (בערך)

- ~5% + $0.50 לעסקה (בדוק בדשבורד)
- כולל טיפול במע"מ בינלאומי

## דיווח מס בישראל

Paddle מעביר payouts — אתה מדווח כהכנסה אישית (עוסק זעיר / פטור לפי מחזור). התייעץ עם רואה חשבון.
