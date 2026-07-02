# דגמת כלים מלאה — AI Workers

## מסלול פשוט (60 שניות)

1. פתח **http://localhost:8765/marketplace#/magic**
2. הזן שם עסק → בחר תבנית → **דבר איתו עכשיו**
3. כתוב שלום בצ'אט — אחרי התשובה לחץ **מעולה! שתף עם לקוחות**
4. התראות וואטסאפ? **הגדרות** בצ'אט (לא באשף)
5. `curl http://localhost:8765/health` → `מוכן לעבודה` או `צריך הגדרה`

---

מדריך מפורט למטה — להפעלת עובד AI עם **כל הכלים המובנים** (save_lead, book_meeting, search_knowledge, escalate, generate_image ועוד) — מקומית, ב-Vercel (mock), או ב-Railway (LLM אמיתי + DB קבוע).

---

## לפני שמתחילים

### הכנה מהירה (Windows)

```powershell
cd C:\Users\rmalk\paid-agent-demo
Copy-Item .env.demo.example .env
# ערוך .env — מלא ADMIN_TOKEN, LLM_API_KEY (אופציונלי), WEBHOOK_NOTIFY_URL
.\scripts\prepare-demo.ps1
```

בדיקות בלבד (בלי להפעיל שרת):

```powershell
.\scripts\prepare-demo.ps1 -CheckOnly
```

### משתני סביבה מינימליים

| משתנה | חובה? | תפקיד |
|--------|--------|--------|
| `LLM_API_KEY` | לסוכן AI אמיתי | לולאת plan→act→observe; בלי — **mock_agent** |
| `ADMIN_TOKEN` | לניהול | `#/admin`, `mark-worker-paid` |
| `WEBHOOK_NOTIFY_URL` | מומלץ | JSON ל-webhook.site על save_lead / escalate |
| `MEETING_BOOKING_URL` | מומלץ | קישור ל-`book_meeting_link` |
| `GOOGLE_AI_API_KEY` | אופציונלי | `generate_image` אמיתי (בלי — SVG mock) |
| `TRIAL_DAYS=14` | מומלץ | עובד חדש **פעיל מיד** 14 יום |

דוגמה מלאה: [`.env.demo.example`](../.env.demo.example)

---

## אופציה A — מקומי (`npm start`) — הכי מהיר

**מתאים ל:** בדיקת כלים, Builder, webhook, LLM אמיתי מהמחשב שלך.

| שלב | פעולה |
|-----|--------|
| 1 | `npm install` (פעם אחת) |
| 2 | העתק `.env.demo.example` → `.env` ומלא ערכים |
| 3 | `.\scripts\prepare-demo.ps1` או `npm start` |
| 4 | פתח **http://localhost:8765/marketplace** |

**URLs מקומיים:**

| מסך | URL |
|-----|-----|
| דף בית | http://localhost:8765/ |
| שוק עובדים | http://localhost:8765/marketplace |
| אשף Magic (3 צעדים) | http://localhost:8765/marketplace#/magic |
| העובדים שלי | http://localhost:8765/marketplace#/workers |
| ניהול אדמין | http://localhost:8765/marketplace#/admin |
| בדיקת בריאות | http://localhost:8765/health |

---

## אופציה B — Vercel (mock LLM) vs Railway (LLM + DB)

| | **Vercel** | **Railway** |
|---|------------|-------------|
| URL לדוגמה | `https://paid-agent-demo-production.up.railway.app` |
| LLM | Mock (אין persistence ל-API key ב-/tmp) | `LLM_API_KEY` ב-Variables |
| SQLite | אфמרלי — `/tmp`, מתאפס | Volume ב-`/app/data` |
| מתאים ל | UI, Magic flow, mock tools | דמו production, webhooks, היסטוריה |
| Deploy | push ל-main → Vercel auto | [railway.app/new](https://railway.app/new) + `railway.toml` |

**Vercel — מה לצפות:** כלים יופעלו ב-**mock_agent** (זיהוי מילות מפתח בעברית). tool trace מלא ב-Builder test panel; בצ'אט — סיכום בתוך התשובה.

**Railway — checklist:**

1. Deploy from GitHub → Volume `/app/data`
2. Variables מ-`.env.production.example` + `LLM_API_KEY`, `ADMIN_TOKEN`, `TRIAL_DAYS=14`
3. `PUBLIC_BASE_URL=https://<domain>.up.railway.app`
4. `curl https://<domain>/health` → `persistentStorage: true`

---

## מסלול 1 — Magic flow (3 צעדים, "Rule #1")

**מטרה:** עובד חי תוך דקה — בלי תשלום, בלי Builder.

### קליקים מדויקים

1. פתח **http://localhost:8765/marketplace#/magic** (או לחץ **«נסה עכשיו בחינם»** בגיבור)
2. **שלב 1/3** — הזן שם עסק (למשל: «קפה השכונה») → **המשך**
3. **שלב 2/3** — בחר תבנית:
   - **מוקדן לידים B2B** (`sales-leads-il`) — מומלץ לכלים save_lead + book_meeting
   - **מזכיר/ת רפואי/ת** (`clinic-receptionist-he`) — תורים + escalate
4. לחץ **«דבר איתו עכשיו!»**
5. נפתח **צ'אט** ב-`#/workers/chat/wk_...` עם באנר «מצב ניסיון»

> עם `TRIAL_DAYS=14` העובד **פעיל** — אין paywall בצ'אט. בלי trial — צ'אט demoMode עדיין עובד; להפעלה מלאה → אדמין.

### URL אחרי Magic

```
http://localhost:8765/marketplace#/workers/chat/<workerId>
```

---

## מסלול 2 — Pro flow (שוק → Builder → הפעלה)

**מטרה:** התאמה מלאה, אינטגרציות, בדיקת סוכן לפני go-live.

### קליקים מדויקים

1. **http://localhost:8765/marketplace**
2. בכרטיס תבנית → **«צור לעסק שלי»** (או **«נסה דוגמה»** → **«צור כזה לעסק שלי»**)
3. אחרי Magic/קנייה → **«העובדים שלי»** → **ערוך** (או ישירות):
   ```
   http://localhost:8765/marketplace#/workers/edit/<workerId>
   ```
4. **Wizard 4 שלבים:**
   - **מה העובד יעשה** — שם, משימות, מצב סוכן (לא «צ'אט בלבד»)
   - **מה הוא צריך לדעת** — ידע + כלים (save_lead, book_meeting_link, …)
   - **חיבורים** — webhook / Cal.com / HubSpot (אופציונלי)
   - **בדיקה והפעלה** — **«הרץ בדיקה»** (פאנל סימולציה)
5. **שמור עובד**
6. להפעלה מול לקוחות אמיתיים:
   - צ'אט → **«להפעיל ללקוחות»** → `#/workers/activate/<workerId>`
   - מלא אסמכתא → **«שלח לאישור»**
7. אדמין: **http://localhost:8765/marketplace#/admin** → אשר בקשה / **סמן כשולם**

### URL Builder (עריכה)

```
http://localhost:8765/marketplace#/workers/edit/<workerId>
```

---

## תרחיש דמו מומלץ — `sales-leads-il`

### הכנה

1. `TRIAL_DAYS=14`, `WEBHOOK_NOTIFY_URL` מ-[webhook.site](https://webhook.site)
2. `MEETING_BOOKING_URL=https://cal.com/demo` (או Cal.com שלך)
3. קנה/צור עובד `sales-leads-il` (Magic או Pro)
4. Builder → שלב 4 → ודא **מצב סוכן** + כלים: `save_lead`, `book_meeting_link`, `notify_webhook`

### הודעות בדיקה (עברית)

| # | הודעה | כלי צפוי |
|---|--------|----------|
| 1 | `שלום, אני דני מחברת Acme, 50 עובדים, מעוניין בפגישה השבוע, טלפון 050-1234567` | `save_lead`, `book_meeting_link`, `search_knowledge` |
| 2 | `מה המחיר שלכם?` | `search_knowledge` |
| 3 | `אני כועס, רוצה לדבר עם מנהל` | `escalate_to_human` |
| 4 | `תכין לי תמונה לפוסט אינסטגרם על המוצר` | `generate_image` (דורש GOOGLE_AI_API_KEY או mock SVG) |

### איך לראות tool trace

| מקום | מה רואים |
|------|-----------|
| **Builder → שלב «בדיקה והפעלה»** | לוח **«בדיקת סוכן (סימולציה)»** → הזן הודעה → **«הרץ בדיקה»** — phases (plan/act/observe), רשימת `toolCalls`, מנוע (`mock_agent` / `openai_compatible`) |
| **צ'אט חי** | בתשובת mock — בלוק **«פעולות סוכן (הדגמה)»** בסוף ההודעה; עם LLM אמיתי — כלים משולבים בתשובה |
| **API** | `POST /api/workers/<id>/test-agent` — לא שומר היסטוריה; מחזיר `toolCalls[]`, `agentSteps[]` |
| **Webhook** | לוח webhook.site — אירועי lead/escalation בזמן אמת |
| **לידים** | `GET /api/workers/<id>/leads` (Bearer tenant key) |

---

## תרחיש חלופי — `clinic-receptionist-he`

| הודעה | כלי צפוי |
|--------|----------|
| `אני רוצה לקבוע תור לרופא בשבוע הבא, שמי יael, 052-1112233` | `get_appointment_slots`, `save_lead` |
| `יש לי כאב בחזה וקוצר נשימה` | `escalate_to_human` (priority high) |
| `מה שעות הפעילות?` | `search_knowledge`, `check_business_hours` |

---

## Admin — סימון עובד כשולם (דילוג על trial / paywall)

### דרך UI

1. **http://localhost:8765/marketplace#/admin**
2. הדבק `ADMIN_TOKEN` → שמור
3. לחץ **«אשר»** ליד בקשת הפעלה, או **«סמן כשולם»** ליד העובד

### One-liner — PowerShell

החלף `wk_...`, `ten_...`, ו-`$ADMIN_TOKEN`:

```powershell
$ADMIN_TOKEN = "your-admin-token-here"
$body = @{
  workerId = "wk_XXXXXXXXXXXX"
  tenantId = "ten_XXXXXXXXXXXX"
  days = 30
  paymentChannel = "demo"
  paymentReference = "manual-demo"
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:8765/api/admin/mark-worker-paid" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $ADMIN_TOKEN"; "Content-Type" = "application/json" } `
  -Body $body
```

**איך למצוא `tenantId`:** אחרי signup — `GET /api/account` עם Bearer `sk_...` → `tenantId`.

### One-liner — curl (Git Bash / WSL)

```bash
curl -X POST http://localhost:8765/api/admin/mark-worker-paid \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workerId":"wk_XXX","tenantId":"ten_XXX","days":30,"paymentChannel":"demo","paymentReference":"manual"}'
```

> Bearer בלבד — **לא** `?token=` ב-URL (נדחה מסיבות אבטחה).

---

## mock vs LLM אמיתי

| מצב | `runtime` בתשובה | התנהגות |
|-----|------------------|----------|
| בלי `LLM_API_KEY` | `mock_agent` | כלים לפי regex עברית/אנגלית — מצוין לדמו |
| עם `LLM_API_KEY` | `openai_compatible` / `anthropic` | function calling + לולאה עד 5 צעדים |

---

## בדיקות אוטומטיות

```powershell
npm test
```

מריץ API + worker lifecycle + browser Magic flow (Playwright). כל הסוויטות חייבות לעבור לפני deploy.

---

## READY AT — סיכום URLs

| סביבה | כתובת |
|--------|--------|
| **Local** | http://localhost:8765/marketplace |
| **Magic** | http://localhost:8765/marketplace#/magic |
| **Admin** | http://localhost:8765/marketplace#/admin |
| **Production** | https://paid-agent-demo-production.up.railway.app/marketplace |
| **Railway** | https://\<your-app\>.up.railway.app/marketplace |

---

## USER MUST DO — רשימה קצרה

1. **העתק `.env.demo.example` → `.env`** ומלא לפחות `ADMIN_TOKEN` (+ `LLM_API_KEY` ל-AI אמיתי).
2. **צור webhook** ב-[webhook.site](https://webhook.site) והדבק ב-`WEBHOOK_NOTIFY_URL`.
3. **הרץ** `.\scripts\prepare-demo.ps1` — וודא Node ≥ 22.5.
4. **עבור Magic או Pro flow** עם הודעות העברית מהטבלה למעלה.
5. **בדוק tool trace** ב-Builder שלב 4 («הרץ בדיקה») + webhook.site.
