# בדיקות חיות ומוכנות לפרודקשן

לשירות יש שני endpoints עם תפקידים שונים:

- `GET /health` הוא **liveness**: אם תהליך Node חי, הוא מחזיר `200` ומציג אבחון. גם `ok:true` כאן אינו אישור שהמערכת בטוחה ללקוחות.
- `GET /infra-ready` הוא שער התשתית: הוא בודק SQLite, נתיבים ו־Docker bind mount, בלי לדרוש שכבר נבחר ערוץ תשלום. הוא אינו מוכיח retention של Oracle או קיום גיבוי מחוץ ל־VM.
- `GET /ready` הוא **שער המוכנות ללקוחות**: הוא מחזיר `200` רק כאשר ההגדרות העסקיות והאחסון הנדרשים תקינים; אחרת הוא מחזיר `503`, ובפרודקשן גם שאר נתיבי הלקוחות נשארים סגורים.

במסלול Oracle Always Free, ה־healthcheck של קונטיינר app משתמש ב־`/infra-ready`, ו־Caddy מתחיל רק לאחר שהוא עובר. `compose.oci.yaml` מחבר את `./data` הקבוע ב־VM אל `/app/data`; נכון ל־2026-08-30 עדיין אין פריסה חיה מאומתת.

## Liveness — `GET /health`

```http
GET /health HTTP/1.1
Host: YOUR_DOMAIN
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
  "publicBaseUrl": "https://YOUR_DOMAIN",
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

Docker משתמש בנתיב הזה כדי לאשר שהגרסה החדשה יכולה לפתוח את SQLite, לכתוב לנתיבי הנתונים ולראות mount אמיתי כאשר `REQUIRE_PERSISTENT_VOLUME=1`. הוא אינו אישור לפרסם את המוצר; כאשר `/infra-ready` הוא `200` אבל `/ready` הוא `503`, הפריסה קיימת לצורכי bootstrap בלבד וכל נתיבי הלקוחות בפרודקשן מחזירים `503`.

## Readiness — `GET /ready`

```http
GET /ready HTTP/1.1
Host: YOUR_DOMAIN
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
  "publicBaseUrl": "https://YOUR_DOMAIN"
}
```

כאשר תנאי כלשהו נכשל, המבנה נשאר אבחוני אך התשובה היא `503` ו־`ok:false`. אין לפרסם את השירות או להפנות אליו לקוחות עד ש־`/ready` מחזיר `200`.

### תנאי המוכנות

| בדיקה | ערך נדרש בפרודקשן | פעולה אם נכשל |
|-------|----------------------|----------------|
| `adminEnabled` | `true` | להגדיר `ADMIN_TOKEN` אקראי באורך 24 תווים לפחות |
| `integrationsEncryptionConfigured` | `true` | להגדיר `INTEGRATIONS_SECRET` אקראי; ב־recovery להשתמש בערך הישן המדויק |
| `llmConfigured` | `true` | להגדיר מפתח ומודל אמיתיים; placeholder או mock אינם פרודקשן. אם מגדירים `LLM_BASE_URL`, הוא חייב להיות יעד HTTPS ציבורי ומאומת של המפעיל |
| `paymentChannelConfigured` | `true` | להגדיר ערוץ אמיתי; מספר/חשבון placeholder או Paddle sandbox אינם עוברים |
| `ownerContactConfigured` | `true` | להגדיר אימייל, מספר ישראלי או URL תמיכה אמיתי ב־`AGENT_OWNER_CONTACT` |
| `publicBaseUrlConfigured` | `true` | ב־OCI להגדיר `AI_WORKERS_DOMAIN`; Compose קובע `PUBLIC_BASE_URL=https://...` |
| `embedOriginsConfigured` | `true` | ב־safe launch להגדיר `EMBED_ALLOW_PUBLIC=0`; אם מפעילים embed חיצוני, להגדיר HTTPS origins אמיתיים (`*` רק בהחלטה מודעת) |
| `privateNetworkFetchDisabled` | `true` | להשאיר `ALLOW_PRIVATE_NETWORK_URLS=0`; הערך `1` מיועד רק למעבדה מקומית מבודדת ולעולם לא לפרודקשן |
| `paymentAutoVerifyDisabled` | `true` | להשאיר `PAYMENT_AUTO_VERIFY=0`; מצב ה־stub מיועד לבדיקות בלבד ואסור בפרודקשן |
| `persistence.pathsAligned` | `true` | `DATA_DIR`, `DB_PATH` ו־`TENANTS_DIR` חייבים להיות תחת `/app/data` |
| `persistence.writable` | `true` | לבדוק הרשאות כתיבה לדיסק |
| `persistence.dbOk` | `true` | לבדוק פתיחת SQLite ושגיאות אתחול |
| `persistence.mounted` | `true` כאשר `REQUIRE_PERSISTENT_VOLUME=1` | לוודא ש־`./data:/app/data` מחובר דרך Compose ולא רק קיימת ספרייה בקונטיינר |

## בדיקות ידניות אחרי פריסה

```bash
# Liveness — אמור להחזיר 200, אך אינו שער השקה
curl -i https://YOUR_HOST/health

# Infrastructure readiness — חובה 200 לאחר חיבור האחסון
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
.\scripts\smoke-production.ps1 -BaseUrl "https://YOUR_DOMAIN"
```

Exit code `0` מעיד רק שהבדיקות שהסקריפט מריץ עברו. יש לבדוק בנפרד ש־`/ready` הוא `200` ושבוצע buyer flow אמיתי.

## תצורת Oracle + Docker

`compose.oci.yaml` מגדיר את app+Caddy ואת החיבור `./data:/app/data`; ה־Dockerfile מגדיר את `/infra-ready` כ־healthcheck. אם הפריסה לא עוברת את בדיקת התשתית:

1. ודאו שהדיסק מחובר ל־`/app/data`, לא רק שהספרייה קיימת בתוך ה־container.
2. ודאו: `DATA_DIR=/app/data`, `DB_PATH=/app/data/earnings.db`, `TENANTS_DIR=/app/data/tenants`, `REQUIRE_PERSISTENT_VOLUME=1`, `ALLOW_PRIVATE_NETWORK_URLS=0`.
3. ודאו שכל הסודות וה־URL הוגדרו. ב־safe launch השאירו `EMBED_ALLOW_PUBLIC=0`; אם הוא `1`, חובה להגדיר `EMBED_ALLOWED_ORIGINS` מפורש.
4. בדקו את לוגי הפריסה לשגיאות SQLite או startup.

הפעלת ה־VM נשארת שלב בשליטת בעל החשבון. יש לבחור רק `VM.Standard.A1.Flex` שמסומן Always Free Eligible ולעצור אם מוצג מחיר שאינו `$0`: [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## גבול שחזור הנתונים

תיקיית data חדשה ב־Oracle היא ריקה. תשובת `/ready` תקינה מוכיחה שהתשתית החדשה מוכנה — היא **אינה** מוכיחה שנתוני Railway שוחזרו. שחזור לקוחות קיימים דורש export מאומת ונפרד של `earnings.db` ושל `tenants/`, וגם את הערך המדויק של `INTEGRATIONS_SECRET` הישן. אם המשתנה לא היה מוגדר, `ADMIN_TOKEN` הישן שימש כמפתח החלופי. לאחר ההעתקה יש לבדוק ספירות, פענוח של כל integration וזרימה של לקוח קיים; ללא המפתח הישן חייבים לחבר מחדש את החיבורים.

## Related

- [LAUNCH-CHECKLIST.md](./LAUNCH-CHECKLIST.md)
- [GTM-PILOT.md](./GTM-PILOT.md)
