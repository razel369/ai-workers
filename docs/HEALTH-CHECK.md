# בדיקות חיות ומוכנות לפרודקשן

לשירות יש שני endpoints עם תפקידים שונים:

- `GET /health` הוא **liveness**: אם תהליך Node חי, הוא מחזיר `200` ומציג אבחון. גם `ok:true` כאן אינו אישור שהמערכת בטוחה ללקוחות.
- `GET /infra-ready` הוא שער התשתית של Render: הוא בודק SQLite, נתיבים ודיסק קבוע, בלי לדרוש שכבר נבחר ערוץ תשלום.
- `GET /ready` הוא **שער המוכנות ללקוחות**: הוא מחזיר `200` רק כאשר ההגדרות העסקיות והאחסון הנדרשים תקינים; אחרת הוא מחזיר `503`, ובפרודקשן גם שאר נתיבי הלקוחות נשארים סגורים.

Render צריך להשתמש ב־`/infra-ready` כ־Health Check Path. היעד המתוכנן הוא Render באזור Frankfurt עם דיסק קבוע ב־`/app/data`; נכון ל־2026-08-30 עדיין אין פריסה חיה מאומתת.

## Liveness — `GET /health`

```http
GET /health HTTP/1.1
Host: your-service.onrender.com
```

לא נדרש אימות. דוגמת תשובה (`200`):

```json
{
  "ok": true,
  "agent": "AI Workers",
  "channels": ["bit", "paypal"],
  "adminEnabled": true,
  "llmConfigured": true,
  "llmProvider": "openai_compatible",
  "llmModel": "gpt-5.5",
  "publicBaseUrl": "https://your-service.onrender.com",
  "dbPath": "/app/data/earnings.db",
  "tenantsDir": "/app/data/tenants",
  "persistentStorage": true,
  "persistence": {
    "ok": true,
    "required": true,
    "root": "/app/data",
    "pathsAligned": true,
    "writable": true,
    "dbOk": true,
    "mounted": true
  }
}
```

`/health` שימושי לאבחון, אבל הוא תמיד endpoint של חיות בלבד. לדוגמה, הוא יכול להחזיר `200` גם כאשר חסר `LLM_API_KEY` או ערוץ תשלום ולכן `/ready` מחזיר `503`.

## Infrastructure readiness — `GET /infra-ready`

Render משתמש בנתיב הזה כדי לאשר שהגרסה החדשה יכולה לפתוח את SQLite, לכתוב לנתיבי הנתונים ולראות mount אמיתי כאשר `REQUIRE_PERSISTENT_VOLUME=1`. הוא אינו אישור לפרסם את המוצר; כאשר `/infra-ready` הוא `200` אבל `/ready` הוא `503`, הפריסה קיימת לצורכי bootstrap בלבד וכל נתיבי הלקוחות בפרודקשן מחזירים `503`.

## Readiness — `GET /ready`

```http
GET /ready HTTP/1.1
Host: your-service.onrender.com
```

דוגמת תשובה מוכנה (`200`):

```json
{
  "ok": true,
  "configurationOk": true,
  "configuration": {
    "adminEnabled": true,
    "integrationsEncryptionConfigured": true,
    "llmConfigured": true,
    "paymentChannelConfigured": true,
    "ownerContactConfigured": true,
    "publicBaseUrlConfigured": true,
    "embedOriginsConfigured": true,
    "privateNetworkFetchDisabled": true,
    "paymentAutoVerifyDisabled": true
  },
  "channels": ["bit"],
  "persistence": {
    "ok": true,
    "required": true,
    "root": "/app/data",
    "dbPath": "/app/data/earnings.db",
    "tenantsDir": "/app/data/tenants",
    "pathsAligned": true,
    "writable": true,
    "dbOk": true,
    "mountCheckSupported": true,
    "mounted": true
  },
  "agent": "AI Workers",
  "publicBaseUrl": "https://your-service.onrender.com"
}
```

כאשר תנאי כלשהו נכשל, המבנה נשאר אבחוני אך התשובה היא `503` ו־`ok:false`. אין לפרסם את השירות או להפנות אליו לקוחות עד ש־`/ready` מחזיר `200`.

### תנאי המוכנות

| בדיקה | ערך נדרש ב־Render | פעולה אם נכשל |
|-------|----------------------|----------------|
| `adminEnabled` | `true` | להגדיר `ADMIN_TOKEN` אקראי באורך 24 תווים לפחות |
| `integrationsEncryptionConfigured` | `true` | להגדיר `INTEGRATIONS_SECRET` אקראי; ב־recovery להשתמש בערך הישן המדויק |
| `llmConfigured` | `true` | להגדיר מפתח ומודל אמיתיים; placeholder או mock אינם פרודקשן. אם מגדירים `LLM_BASE_URL`, הוא חייב להיות יעד HTTPS ציבורי ומאומת של המפעיל |
| `paymentChannelConfigured` | `true` | להגדיר ערוץ אמיתי; מספר/חשבון placeholder או Paddle sandbox אינם עוברים |
| `ownerContactConfigured` | `true` | להגדיר אימייל, מספר ישראלי או URL תמיכה אמיתי ב־`AGENT_OWNER_CONTACT` |
| `publicBaseUrlConfigured` | `true` | Render מספק `RENDER_EXTERNAL_URL`; לדומיין מותאם להגדיר `PUBLIC_BASE_URL` מאומת |
| `embedOriginsConfigured` | `true` | ב־safe launch להגדיר `EMBED_ALLOW_PUBLIC=0`; אם מפעילים embed חיצוני, להגדיר HTTPS origins אמיתיים (`*` רק בהחלטה מודעת) |
| `privateNetworkFetchDisabled` | `true` | להשאיר `ALLOW_PRIVATE_NETWORK_URLS=0`; הערך `1` מיועד רק למעבדה מקומית מבודדת ולעולם לא לפרודקשן |
| `paymentAutoVerifyDisabled` | `true` | להשאיר `PAYMENT_AUTO_VERIFY=0`; מצב ה־stub מיועד לבדיקות בלבד ואסור בפרודקשן |
| `persistence.pathsAligned` | `true` | `DATA_DIR`, `DB_PATH` ו־`TENANTS_DIR` חייבים להיות תחת `/app/data` |
| `persistence.writable` | `true` | לבדוק הרשאות כתיבה לדיסק |
| `persistence.dbOk` | `true` | לבדוק פתיחת SQLite ושגיאות אתחול |
| `persistence.mounted` | `true` ב־Render או כאשר `REQUIRE_PERSISTENT_VOLUME=1` | לחבר Render Persistent Disk ל־`/app/data` |

## בדיקות ידניות אחרי פריסה

```bash
# Liveness — אמור להחזיר 200, אך אינו שער השקה
curl -i https://YOUR_HOST/health

# Render infrastructure readiness — חובה 200 לאחר חיבור הדיסק
curl -i https://YOUR_HOST/infra-ready

# Customer readiness — חובה 200 ו-ok:true לפני פרסום
curl -i https://YOUR_HOST/ready

# Marketplace HTML
curl -s -o /dev/null -w "%{http_code}" https://YOUR_HOST/marketplace

# Templates API (ללא auth)
curl -s https://YOUR_HOST/api/workers/templates | head -c 200

# דפים משפטיים
curl -s -o /dev/null -w "%{http_code}" https://YOUR_HOST/privacy
curl -s -o /dev/null -w "%{http_code}" https://YOUR_HOST/terms
```

אחרי הבדיקות הטכניות יש להריץ buyer flow מלא עם LLM אמיתי: הרשמה → בחירת תבנית → אסמכתת הפעלה → אישור אדמין → צ'אט.

## סקריפט Smoke

```powershell
.\scripts\smoke-production.ps1 -BaseUrl "https://your-service.onrender.com"
```

Exit code `0` מעיד רק שהבדיקות שהסקריפט מריץ עברו. יש לבדוק בנפרד ש־`/ready` הוא `200` ושבוצע buyer flow אמיתי.

## תצורת Render

`render.yaml` מגדיר את `/infra-ready` כ־health check ואת הדיסק ב־`/app/data`. אם הפריסה לא עוברת את בדיקת התשתית:

1. ודאו שהדיסק מחובר ל־`/app/data`, לא רק שהספרייה קיימת בתוך ה־container.
2. ודאו: `DATA_DIR=/app/data`, `DB_PATH=/app/data/earnings.db`, `TENANTS_DIR=/app/data/tenants`, `REQUIRE_PERSISTENT_VOLUME=1`, `ALLOW_PRIVATE_NETWORK_URLS=0`.
3. ודאו שכל הסודות וה־URL הוגדרו. ב־safe launch השאירו `EMBED_ALLOW_PUBLIC=0`; אם הוא `1`, חובה להגדיר `EMBED_ALLOWED_ORIGINS` מפורש.
4. בדקו את לוגי הפריסה לשגיאות SQLite או startup.

Render מתכנן להפעיל את השירות ב־Frankfurt. לפי המסמכים הרשמיים, שירות עם דיסק חייב להיות בתוכנית compute בתשלום, ורק תוכן תחת נתיב ה־mount נשמר: [Persistent Disks](https://render.com/docs/disks), [Regions](https://render.com/docs/regions).

## גבול שחזור הנתונים

דיסק Render חדש הוא ריק. תשובת `/ready` תקינה מוכיחה שהתשתית החדשה מוכנה — היא **אינה** מוכיחה שנתוני Railway שוחזרו. שחזור לקוחות קיימים דורש export מאומת ונפרד של `earnings.db` ושל `tenants/`, וגם את הערך המדויק של `INTEGRATIONS_SECRET` הישן. אם המשתנה לא היה מוגדר, `ADMIN_TOKEN` הישן שימש כמפתח החלופי. לאחר ההעתקה יש לבדוק ספירות, פענוח של כל integration וזרימה של לקוח קיים; ללא המפתח הישן חייבים לחבר מחדש את החיבורים.

## Related

- [LAUNCH-CHECKLIST.md](./LAUNCH-CHECKLIST.md)
- [GTM-PILOT.md](./GTM-PILOT.md)
