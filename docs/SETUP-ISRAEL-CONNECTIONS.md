# חיבורים להשקה בישראל

**סטטוס:** אין כרגע אתר פרודקשן חי ומאומת. יעד הפריסה הוא Render באזור Frankfurt עם Persistent Disk ב־`/app/data`; כתובת ה־`onrender.com` תיקבע רק אחרי יצירה ואימות.
**כתובת Railway הישנה:** `https://paid-agent-demo-production.up.railway.app` — היסטורית/offline, אין להשתמש בה ב־webhooks או בפרסום.

מדריך זה מרכז את החיבורים הנדרשים להשקה. יצירת שירות Render חדש אינה מעבירה secrets או נתוני לקוחות מ־Railway, ולכן כל חיבור חייב להיות מוגדר ונבדק מחדש.

## 0. תשתית Render

- Region: **Frankfurt, Germany** ([Render Regions](https://render.com/docs/regions)).
- Web Service: בודקים דרך **New → Blueprint** מהענף `codex/revive-ai-workers-baseline`, אך עוצרים לפני `Deploy Blueprint` עד לאישור מפורש של המחיר החי. אחרי יצירה מגדירים Blueprint Auto Sync ל־No בנפרד מ־`autoDeployTrigger: off`. מעבר ל־`main` מתבצע רק אחרי אימות המועמד וניתוק Vercel Production, ומעדכן יחד את `render.yaml`, הענף המקושר של ה־Blueprint וענף השירות לפני Manual Sync יחיד.
- Storage: דיסק קבוע של 1 GB לפחות, mount path: `/app/data` ([Persistent Disks](https://render.com/docs/disks)).
- עלות baseline משוערת: **US$7.25 לחודש לפני מס ו־egress** — US$7 compute ועוד US$0.25 לדיסק 1 GB. יש לאמת את הסכום במסך החי לפני חיוב: [Render Pricing](https://render.com/pricing).
- Health Check Path: `/infra-ready`. `/health` הוא liveness/אבחון בלבד, ו־`/ready` הוא שער ההשקה המחמיר ללקוחות.

```env
NODE_ENV=production
# Render מספק RENDER_EXTERNAL_URL; מלא PUBLIC_BASE_URL רק לדומיין מותאם
PUBLIC_BASE_URL=
TRUST_PROXY_HEADERS=1
DATA_DIR=/app/data
DB_PATH=/app/data/earnings.db
TENANTS_DIR=/app/data/tenants
REQUIRE_PERSISTENT_VOLUME=1
EMBED_ALLOW_PUBLIC=0
# בעת הפעלה חיצונית בלבד: EMBED_ALLOWED_ORIGINS=https://customer.example
```

אחרי הפריסה:

```bash
curl -i https://YOUR_SERVICE.onrender.com/health  # מצופה 200; liveness בלבד
curl -i https://YOUR_SERVICE.onrender.com/ready   # חובה 200 ו-ok:true לפני לקוחות
```

## 1. תשלומים

### Paddle (כרטיס אשראי) — ראו `docs/PADDLE.md`

| משתנה | הערה |
|--------|------|
| `PADDLE_API_KEY` | secret של Paddle ליצירת/אימות פעולות שרת |
| `PADDLE_CLIENT_TOKEN` | מ־Paddle Dashboard |
| `PADDLE_PRICE_ID` | מחיר מנוי חודשי |
| `PADDLE_WEBHOOK_SECRET` | מ־Notifications |
| `PADDLE_ENVIRONMENT` | `sandbox` עד שכל הזרימה נבדקה |

Webhook מתוכנן:

```text
https://YOUR_SERVICE.onrender.com/api/webhooks/paddle
```

### Bit / PayPal / העברה בנקאית

| ערוץ | רישום נדרש | איך זה עובד אצלנו |
|------|------------|-------------------|
| **Bit** | חשבון Bit מתאים למפעיל | לקוח משלם, שולח אסמכתה, והמפעיל מאשר ב־`#/admin` |
| **PayPal.me** | חשבון PayPal | אותו תהליך ידני |
| **העברה בנקאית** | חשבון מתאים | פרטים ב־`/invoice` ובמסך הפעלה |

יש לבדוק עצמאית חובות רישום, חשבוניות ומס לפני גבייה אמיתית.

### משתני Render לתשלום

```env
BIT_PHONE=9725XXXXXXXX           # להגדיר רק כ-secret ב-Render; לא לשמור מספר אמיתי ב-Git
PAYPAL_ME=שם-המשתמש-שלך
PAYEE_NAME=שם מלא בעברית
BANK_NAME=שם הבנק
BANK_BRANCH=מספר סניף
BANK_ACCOUNT=מספר חשבון
TRIAL_DAYS=0                    # לשנות רק לאחר החלטה עסקית מפורשת
ACTIVATION_SLA_HOURS=24
```

### תהליך יומיומי

1. לקוח מסיים ניסיון → `#/workers/activate/:id`.
2. הלקוח משלם ושולח אסמכתה + פרטי קשר.
3. המפעיל נכנס ל־`https://YOUR_SERVICE.onrender.com/marketplace#/admin`.
4. המפעיל מאשר את הבקשה; העובד נהיה פעיל.

התהליך אינו מאומת לפרודקשן עד שבוצע פעם אחת מקצה לקצה על Render עם דיסק קבוע.

## 2. AI דרך OpenRouter או ספק OpenAI-compatible

מפתחות שהיו ב־Railway אינם מועברים ל־Render. יש להזין מחדש secret ולבצע תשובת LLM אמיתית:

```env
LLM_API_KEY=<render-secret>
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=https://openrouter.ai/api
LLM_MODEL=<model-id>
```

ללא `LLM_API_KEY`, המערכת פועלת ב־mock ו־`/ready` נכשל בכוונה. לפני שיווק יש להגדיר תקציב, rate limits ומודל שאינו תלוי במכסה חינמית לא יציבה.

## 3. מסמכים משפטיים

| דף | כתובת יחסית |
|----|-------------|
| פרטיות | `/privacy` |
| תנאים | `/terms` |
| תשלום | `/invoice` |

אחרי הפריסה יש לוודא שכל דף מחזיר `200`, שהקישורים מופיעים בדף הבית ובמרקטפלייס, ושהתוכן מתאים לסטטוס העסק בפועל.

## 4. WhatsApp

### שלב א — התראות לבעל העסק

באשף ההקמה או בהגדרות העובד מזינים מספר מאומת לקבלת התראות על לידים.

### שלב ב — לקוחות כותבים ב־WhatsApp (Meta Business)

1. יוצרים אפליקציה ב־[developers.facebook.com](https://developers.facebook.com).
2. מוסיפים את מוצר WhatsApp.
3. מגדירים ב־Render:

```env
WHATSAPP_PROVIDER=meta
WHATSAPP_VERIFY_TOKEN=מחרוזת-אקראית-ארוכה
WHATSAPP_ACCESS_TOKEN=טוקן-ממטא
WHATSAPP_PHONE_NUMBER_ID=מזהה-מספר
# אופציונלי עד לחיבור דומיין מותאם; Render משתמש ב-RENDER_EXTERNAL_URL
PUBLIC_BASE_URL=
```

4. Webhook URL ב־Meta:
   `https://YOUR_SERVICE.onrender.com/api/webhooks/whatsapp`
5. ה־Verify token חייב להיות זהה ל־`WHATSAPP_VERIFY_TOKEN`.

Meta עשויה לדרוש אימות עסקי. עד להשלמתו אפשר להריץ פיילוט מוגבל בצ'אט האתר, בלי לטעון ש־WhatsApp פעיל.

## 5. דומיין משלך

1. קונים דומיין, למשל `ai-workers.co.il`.
2. ב־Render: Service → Settings → Custom Domains.
3. מעדכנים `PUBLIC_BASE_URL=https://הדומיין-שלך`.
4. מעדכנים callbacks של OAuth, כתובות webhook ו־GitHub homepage.
5. מריצים שוב `/ready` ואת ה־buyer flow אחרי שינוי הדומיין.

## 6. אבטחה ותפעול

| משימה | סטטוס נדרש לפני השקה |
|--------|-----------------------|
| `ADMIN_TOKEN` סודי ב־Render | [ ] |
| `INTEGRATIONS_SECRET` סודי ב־Render | [ ] |
| דיסק אמיתי ב־`/app/data` | [ ] |
| `/ready` מחזיר `200` | [ ] |
| Vercel Production auto-deploy מ־`main` חסום | [ ] |
| גיבוי + restore test ל־`/app/data` | [ ] |
| סיבוב מפתחות שנחשפו | [ ] לפי צורך |

Vercel הוא preview בלבד: `/tmp` אקראי וזמני, ללא נתוני לקוחות. PR previews יכולים לשמש ל־UI, אך `main` לא צריך לבצע שם Production auto-deploy.

## 7. שחזור Railway מול fresh launch

דיסק Render חדש מתחיל ריק. יש לבחור במפורש:

- **Fresh launch:** אין לקוחות ישנים; מתחילים מאפס ומצהירים כך.
- **Recovery:** משיגים export מאומת של `/app/data/earnings.db` ושל `/app/data/tenants/`, ומשמרים את `INTEGRATIONS_SECRET` הישן המדויק. אם הוא לא היה מוגדר, משמרים את `ADMIN_TOKEN` הישן ששימש fallback. משחזרים לדיסק Render, מגדירים את מפתח ההצפנה התואם, ובודקים tenant/worker וכל integration קיים לפני פתיחת תעבורה.

פריסה שעוברת `/ready` אינה לבדה הוכחת recovery. בלי export מאומת ומפתח הצפנה תואם אין לטעון שהלקוחות, העובדים, התשלומים, השיחות או החיבורים מ־Railway נשמרו. אם המפתח הישן אינו זמין, יש לחבר מחדש כל OAuth/webhook ולתעד זאת.

## 8. צ'קליסט קצר

- [ ] Render Frankfurt נוצר ושולם רק לאחר אישור הסכום במסך החי.
- [ ] דיסק `/app/data` מחובר ו־`/ready` ירוק.
- [ ] הוחלט fresh launch או recovery, וההחלטה מתועדת.
- [ ] AI אמיתי נבדק.
- [ ] Bit/PayPal/בנק אומתו בלי סודות ב־Git.
- [ ] דפים משפטיים זמינים.
- [ ] Vercel מוגבל ל־preview בלבד.
- [ ] buyer flow מלא עבר.
- [ ] שלושה עסקים לפיילוט זוהו.
- [ ] WhatsApp ודומיין יתווספו לפי שערי הפיילוט.

## 9. קישורים מהירים

| מה | איפה |
|----|------|
| יעד שירות | `https://YOUR_SERVICE.onrender.com` — עדיין לא הוקצה/אומת |
| מרקטפלייס | `/marketplace` |
| אדמין | `/marketplace#/admin` |
| Liveness | `/health` |
| Production readiness | `/ready` |
| Render Dashboard | https://dashboard.render.com/ |
| GitHub | https://github.com/razel369/ai-workers |
