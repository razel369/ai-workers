# חיבורים להשקה — ישראל (מפעיל פרטי, בלי עוסק)

**אתר פרודקשן:** https://paid-agent-demo-production.up.railway.app

מדריך זה מרכז את כל מה שצריך לחבר כדי להשיק ברמה גבוהה — בלי סליקת כרטיסי אשראי (שדורשת עוסק/חברה).

---

## 1. תשלומים

### Paddle (כרטיס אשראי — מומלץ) — ראה `docs/PADDLE.md`

| משתנה | הערה |
|--------|------|
| `PADDLE_CLIENT_TOKEN` | מ-Paddle Dashboard |
| `PADDLE_PRICE_ID` | מחיר מנוי חודשי |
| `PADDLE_WEBHOOK_SECRET` | מ-Notifications |
| `PADDLE_ENVIRONMENT` | `sandbox` עד שמוכנים |

Webhook: `https://paid-agent-demo-production.up.railway.app/api/webhooks/paddle`

### Bit / PayPal (גיבוי ידני — כבר מוגדר)

| ערוץ | רישום נדרש | איך זה עובד אצלנו |
|------|------------|-------------------|
| **Bit** | חשבון Bit אישי | לקוח לוחץ קישור → משלם → שולח אסמכתא → אתה מאשר ב-`#/admin` |
| **PayPal.me** | חשבון PayPal אישי | אותו תהליך |
| **העברה בנקאית** | חשבון בנק אישי | פרטים ב-`/invoice` ובמסך הפעלה |

**לא בשימוש כרגע:** Stripe / כרטיס אשראי / סליקה ישראלית — דורשים עוסק או חברה.

### משתני Railway (תשלום)

```env
BIT_PHONE=972546406061
PAYPAL_ME=שם-המשתמש-שלך          # אחרי שתשלח לנו
PAYEE_NAME=שם מלא בעברית
BANK_NAME=שם הבנק
BANK_BRANCH=מספר סניף
BANK_ACCOUNT=מספר חשבון
TRIAL_DAYS=14
ACTIVATION_SLA_HOURS=24
```

### תהליך יומיומי

1. לקוח מסיים ניסיון → `#/workers/activate/:id`
2. לוחץ **Bit** או **PayPal** → משלם
3. ממלא אסמכתא + פרטי קשר
4. אתה נכנס ל-**https://paid-agent-demo-production.up.railway.app/marketplace#/admin**
5. מאשר בקשה → העובד פעיל ללקוחות

---

## 2. AI (OpenRouter) — כבר מחובר ✓

| משתנה | ערך נוכחי |
|--------|-----------|
| `LLM_API_KEY` | OpenRouter (מוגדר) |
| `LLM_BASE_URL` | `https://openrouter.ai/api` |
| `LLM_MODEL` | `meta-llama/llama-3.3-70b-instruct:free` |

**שדרוג מומלץ לפני שיווק:** הוסף $5–10 קרדיט ב-[openrouter.ai/settings/credits](https://openrouter.ai/settings/credits) ועבור למודל בתשלום (פחות מגבלות).

---

## 3. מסמכים משפטיים — מקושרים ✓

| דף | כתובת |
|----|--------|
| פרטיות | `/privacy` |
| תנאים | `/terms` |
| תשלום | `/invoice` |

קישורים בדף הבית ובתחתית המרקטפלייס.

---

## 4. WhatsApp (הכי חשוב לשוק ישראלי — עדיין ידני)

### שלב א — התראות לבעל העסק (קל)

באשף הקמה או בהגדרות עובד: הזן **מספר לקבלת התראות** על לידים.

### שלב ב — לקוחות כותבים ב-WhatsApp (Meta Business)

1. צור אפליקציה ב-[developers.facebook.com](https://developers.facebook.com)
2. הוסף מוצר **WhatsApp**
3. ב-Railway הגדר:

```env
WHATSAPP_PROVIDER=meta
WHATSAPP_VERIFY_TOKEN=מחרוזת-אקראית-ארוכה
WHATSAPP_ACCESS_TOKEN=טוקן-ממטא
WHATSAPP_PHONE_NUMBER_ID=מזהה-מספר
PUBLIC_BASE_URL=https://paid-agent-demo-production.up.railway.app
```

4. Webhook URL ב-Meta:
   `https://paid-agent-demo-production.up.railway.app/api/webhooks/whatsapp`
5. Verify token = אותו `WHATSAPP_VERIFY_TOKEN`

> **פרטי:** Meta עשויה לדרוש אימות עסקי. עד אז — צ'אט באתר + Bit מספיקים לפיילוט.

---

## 5. דומיין משלך (מומלץ)

1. קנה דומיין (למשל `ai-workers.co.il`)
2. Railway → Service → **Settings → Networking → Custom Domain**
3. עדכן `PUBLIC_BASE_URL=https://הדומיין-שלך`
4. עדכן GitHub homepage

---

## 6. אבטחה ותפעול

| משימה | סטטוס |
|--------|--------|
| `ADMIN_TOKEN` ב-Railway | ✓ |
| `INTEGRATIONS_SECRET` | ✓ |
| Volume `/app/data` | ✓ |
| נתק Vercel (אופציונלי) | מומלץ |
| גיבוי שבועי ל-volume | לעשות |
| סובב מפתח OpenRouter אם נחשף | לפי צורך |

---

## 7. צ'קליסט השקה (סדר מומלץ)

- [x] Railway + DB קבוע
- [x] AI (OpenRouter)
- [x] Bit (`054-6406061`)
- [ ] PayPal.me — שלח שם משתמש
- [ ] פרטי בנק (אופציונלי) ב-Railway
- [x] דפים משפטיים מקושרים
- [ ] פיילוט 3 עסקים
- [ ] WhatsApp Meta (אחרי פיילוט)
- [ ] דומיין משלך
- [ ] שדרוג LLM מתשלום

---

## 8. קישורים מהירים

| מה | איפה |
|----|------|
| אתר | https://paid-agent-demo-production.up.railway.app |
| מרקטפלייס | /marketplace |
| אדמין | /marketplace#/admin |
| בריאות | /health |
| Railway Variables | railway.app → paid-agent-demo → Variables |
| GitHub | https://github.com/razel369/ai-workers |
