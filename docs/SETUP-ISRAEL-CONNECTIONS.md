# חיבורים להשקה בישראל

**סטטוס:** אין כרגע אתר פרודקשן חי ומאומת. יעד הפריסה הוא Oracle Always Free A1 עם `./data` קבוע שמחובר ל־`/app/data`; הדומיין ייקבע רק אחרי יצירה ואימות.
**כתובת Railway הישנה:** `https://paid-agent-demo-production.up.railway.app` — היסטורית/offline, אין להשתמש בה ב־webhooks או בפרסום.

מדריך זה מרכז את החיבורים הנדרשים להשקה. יצירת VM חדש אינה מעבירה secrets או נתוני לקוחות מ־Railway, ולכן כל חיבור חייב להיות מוגדר ונבדק מחדש.

## 0. תשתית Oracle Always Free

- Region: ה־**home region** של חשבון Oracle; Always Free Compute זמין רק שם.
- Compute: ‏`VM.Standard.A1.Flex`, ‏1 OCPU / ‏4 GB, ‏Ubuntu ARM64, ורק אם מסומן **Always Free Eligible**.
- Storage: ‏boot volume של 50 GB; `compose.oci.yaml` מחבר `./data` אל `/app/data`.
- Cost gate: לא לשדרג ל־Pay As You Go ולעצור לפני Create אם מוצג estimate שאינו `$0`.
- Runbook: [`deploy/oci/README.md`](../deploy/oci/README.md).
- Health Check Path: `/infra-ready`. `/health` הוא liveness/אבחון בלבד, ו־`/ready` הוא שער ההשקה המחמיר ללקוחות.

```env
AI_WORKERS_DOMAIN=YOUR_DOMAIN
# שאר ערכי הבטיחות למטה נכפים גם ב-compose.oci.yaml
TRIAL_DAYS=0
PAYMENT_AUTO_VERIFY=0
ALLOW_PRIVATE_NETWORK_URLS=0
EMBED_ALLOW_PUBLIC=0
# בעת הפעלה חיצונית בלבד: EMBED_ALLOWED_ORIGINS=https://customer.example
```

אחרי הפריסה:

```bash
curl -i https://YOUR_DOMAIN/health        # מצופה 200; liveness בלבד
curl -i https://YOUR_DOMAIN/infra-ready   # חובה 200 לאחסון/SQLite
curl -i https://YOUR_DOMAIN/ready         # חובה 200 ו-ok:true לפני לקוחות
```

## 1. תשלומים

### Paddle (כרטיס אשראי) — ראו `docs/PADDLE.md`

| משתנה | הערה |
|--------|------|
| `PADDLE_API_KEY` | secret של Paddle ליצירת/אימות פעולות שרת |
| `PADDLE_CLIENT_TOKEN` | מ־Paddle Dashboard |
| `PADDLE_PRICE_MAP` | JSON של template id אל Paddle price id; נדרש לכל תבנית שנמכרת |
| `PADDLE_WEBHOOK_SECRET` | מ־Notifications |
| `PADDLE_ENVIRONMENT` | `sandbox` עד שכל הזרימה נבדקה |

Webhook מתוכנן:

```text
https://YOUR_DOMAIN/api/webhooks/paddle
```

### Bit / PayPal / העברה בנקאית

| ערוץ | רישום נדרש | איך זה עובד אצלנו |
|------|------------|-------------------|
| **Bit** | חשבון Bit מתאים למפעיל | לקוח משלם, שולח אסמכתה, והמפעיל מאשר ב־`#/admin` |
| **PayPal.me** | חשבון PayPal | אותו תהליך ידני |
| **העברה בנקאית** | חשבון מתאים | פרטים ב־`/invoice` ובמסך הפעלה |

יש לבדוק עצמאית חובות רישום, חשבוניות ומס לפני גבייה אמיתית.

### משתני תשלום ב־`.env` המוגן

```env
BIT_PHONE=9725XXXXXXXX           # להגדיר רק ב-.env המוגן; לא לשמור מספר אמיתי ב-Git
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
3. המפעיל נכנס ל־`https://YOUR_DOMAIN/marketplace#/admin`.
4. המפעיל מאשר את הבקשה; העובד נהיה פעיל.

התהליך אינו מאומת לפרודקשן עד שבוצע פעם אחת מקצה לקצה על Oracle מול האחסון הקבוע.

## 2. AI דרך OpenRouter או ספק OpenAI-compatible

מפתחות שהיו ב־Railway אינם מועברים ל־Oracle. יש להזין מחדש secret ולבצע תשובת LLM אמיתית:

```env
LLM_API_KEY=<provider-secret>
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
3. מגדירים ב־`.env` המוגן בשרת:

```env
WHATSAPP_PROVIDER=meta
WHATSAPP_VERIFY_TOKEN=מחרוזת-אקראית-ארוכה
WHATSAPP_ACCESS_TOKEN=טוקן-ממטא
WHATSAPP_PHONE_NUMBER_ID=מזהה-מספר
# Compose בונה PUBLIC_BASE_URL מתוך AI_WORKERS_DOMAIN
AI_WORKERS_DOMAIN=YOUR_DOMAIN
```

4. Webhook URL ב־Meta:
   `https://YOUR_DOMAIN/api/webhooks/whatsapp`
5. ה־Verify token חייב להיות זהה ל־`WHATSAPP_VERIFY_TOKEN`.

Meta עשויה לדרוש אימות עסקי. עד להשלמתו אפשר להריץ פיילוט מוגבל בצ'אט האתר, בלי לטעון ש־WhatsApp פעיל.

## 5. דומיין משלך

1. קונים דומיין, למשל `ai-workers.co.il`.
2. מפנים את רשומת ה־DNS ל־public IPv4 של ה־VM.
3. מעדכנים `AI_WORKERS_DOMAIN=הדומיין-שלך` ב־`.env` ומריצים שוב את deploy script.
4. מעדכנים callbacks של OAuth, כתובות webhook ו־GitHub homepage.
5. מריצים שוב `/ready` ואת ה־buyer flow אחרי שינוי הדומיין.

## 6. אבטחה ותפעול

| משימה | סטטוס נדרש לפני השקה |
|--------|-----------------------|
| `ADMIN_TOKEN` סודי ב־`.env` ובמנהל הסיסמאות | [ ] |
| `INTEGRATIONS_SECRET` סודי ב־`.env` ובמנהל הסיסמאות | [ ] |
| דיסק אמיתי ב־`/app/data` | [ ] |
| `/ready` מחזיר `200` | [ ] |
| Vercel Production auto-deploy מ־`main` חסום | [ ] |
| גיבוי + restore test ל־`/app/data` | [ ] |
| סיבוב מפתחות שנחשפו | [ ] לפי צורך |

Vercel הוא preview בלבד: `/tmp` אקראי וזמני, ללא נתוני לקוחות. PR previews יכולים לשמש ל־UI, אך `main` לא צריך לבצע שם Production auto-deploy.

## 7. שחזור Railway מול fresh launch

תיקיית data חדשה ב־Oracle מתחילה ריקה. יש לבחור במפורש:

- **Fresh launch:** אין לקוחות ישנים; מתחילים מאפס ומצהירים כך.
- **Recovery:** משיגים export מאומת של `/app/data/earnings.db` ושל `/app/data/tenants/`, ומשמרים את `INTEGRATIONS_SECRET` הישן המדויק. אם הוא לא היה מוגדר, משמרים את `ADMIN_TOKEN` הישן ששימש fallback. משחזרים ל־`data/` ב־VM, מגדירים את מפתח ההצפנה התואם, ובודקים tenant/worker וכל integration קיים לפני פתיחת תעבורה.

פריסה שעוברת `/ready` אינה לבדה הוכחת recovery. בלי export מאומת ומפתח הצפנה תואם אין לטעון שהלקוחות, העובדים, התשלומים, השיחות או החיבורים מ־Railway נשמרו. אם המפתח הישן אינו זמין, יש לחבר מחדש כל OAuth/webhook ולתעד זאת.

## 8. צ'קליסט קצר

- [ ] Oracle A1 נוצר רק כ־Always Free Eligible עם estimate של `$0`.
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
| יעד שירות | `https://YOUR_DOMAIN` — עדיין לא הוקצה/אומת |
| מרקטפלייס | `/marketplace` |
| אדמין | `/marketplace#/admin` |
| Liveness | `/health` |
| Production readiness | `/ready` |
| Oracle Console | https://cloud.oracle.com/ |
| GitHub | https://github.com/razel369/ai-workers |
