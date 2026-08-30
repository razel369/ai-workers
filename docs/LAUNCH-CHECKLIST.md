# AI Workers — צ'קליסט השקה לישראל

**פרודקשן נוכחי:** אין URL חי ומאומת.
**יעד מאושר:** Render, אזור Frankfurt, עם Persistent Disk ב־`/app/data`.
**Railway הישן:** היסטורי/offline; `https://paid-agent-demo-production.up.railway.app` אינו אתר פעיל.

## מצב שחזור — 2026-08-30

- [x] `npm test` עובר מקומית, כולל buyer flow ב־Chromium ו־28 תרחישי הערכה במצב mock.
- [x] בדיקות ה־CI של PR השחזור עברו; זהו proof לקוד, לא לפרודקשן.
- [x] נוצר פרויקט Render ריק בשם `AI Workers`; אין בו עדיין שירות או חיוב.
- [ ] לא למזג ל־`main` לפני שנחסמה פריסת Production אוטומטית ב־Vercel.
- [ ] לא נוצר ולא אומת עדיין שירות Render חי.
- [ ] להריץ quality smoke עם LLM אמיתי לאחר הפריסה; הערכת mock אינה הוכחת מודל בפרודקשן.

## שער 0 — תשתית Render

- [ ] לקבל מבעל העסק אישור מפורש לעלות החיה שמוצגת ב־Render **לפני** לחיצה על `Deploy Blueprint`; הלחיצה יוצרת את השירות בתשלום ומתחילה deploy ראשוני.
  - baseline מוערך: **US$7.25 לחודש לפני מס ו־egress** — US$7 compute ועוד US$0.25 לדיסק 1 GB.
  - לאמת מול [Render Pricing](https://render.com/pricing) ו־[Persistent Disks](https://render.com/docs/disks) לפני יצירת השירות.
- [ ] לבחור ב־Render **New → Blueprint**, לחבר את ה־GitHub repo ולבחור בענף `codex/revive-ai-workers-baseline`; מותר לבדוק את ה־preview והמחיר, אך עוצרים לפני `Deploy Blueprint` עד לקבלת האישור. אין ליצור Web Service ידני: הוא אינו מחיל את `render.yaml` אוטומטית ועלול לדלג על הדיסק, האזור ושערי המוכנות.
- [ ] לוודא `/infra-ready` = `200` לתשתית, ואז `/ready` = `200` לפני פתיחת נתיבי הלקוחות.
- [ ] לבחור **Frankfurt, Germany** בעת היצירה; לא ניתן להעביר region לשירות קיים בלי ליצור שירות חדש ([Regions](https://render.com/docs/regions)).
- [ ] לוודא שהשירות משתמש ב־`Dockerfile` וב־`render.yaml`.
- [ ] לצרף Persistent Disk בגודל 1 GB לפחות, mount path: `/app/data`.
- [ ] בזמן יצירת ה־Blueprint להזין את כל שדות `sync:false`; מיד לאחר יצירת משאב השירות, לפתוח **Environment** ולהוסיף לפחות ערוץ תשלום אמיתי אחד. ערוץ תשלום אינו מקובע ב־`render.yaml`, ו־`/ready` יישאר `503` עד להשלמת השלב.
- [ ] מיד לאחר היצירה להגדיר **Blueprint Settings → Auto Sync → No**. זה מנגנון נפרד מ־`autoDeployTrigger: off` שבשירות.
- [ ] לוודא ש־`RENDER_EXTERNAL_URL` מופיע ב־`/health`; להגדיר `PUBLIC_BASE_URL` רק אם דומיין מותאם ומאומת צריך להיות הכתובת הקנונית.
- [ ] לוודא ש־`GET /health` מחזיר `200` — liveness ואבחון בלבד.
- [ ] לוודא ש־`GET /ready` מחזיר `200` ו־`ok:true` — זה שער המוכנות לפרודקשן.
- [ ] להריץ smoke מלא: signup → תבנית → אסמכתת הפעלה → אישור אדמין → צ'אט עם LLM אמיתי.
- [ ] רק לאחר אימות המועמד וניתוק Vercel Production: ב־cutover מאושר לעדכן את `branch:` ב־`render.yaml` ל־`main`, למזג, להעביר ל־`main` גם את הענף המקושר של ה־Blueprint וגם את ענף השירות, ואז לבצע Manual Sync יחיד. להשאיר Auto Sync כבוי.
- [ ] לפרסם URL רק אחרי שכל הסעיפים למעלה עברו.

## מסלול נתונים — נפרד מפריסה חדשה

Render יוצר דיסק ריק. פריסה ירוקה אינה משחזרת נתוני Railway.

- [ ] להחליט ולתעד: **fresh launch** ריק, או **recovery** של הלקוחות הקיימים.
- [ ] אם recovery: להשיג export מאומת מ־Railway לפני אובדן ה־volume.
- [ ] לכלול בגיבוי את `/app/data/earnings.db` ואת כל `/app/data/tenants/`.
- [ ] לשמר בנפרד את הערך המדויק של `INTEGRATIONS_SECRET`. אם הוא לא היה מוגדר, לשמר את `ADMIN_TOKEN` הישן ששימש כמפתח ההצפנה החלופי.
- [ ] לשמור checksum/גודל/תאריך של הגיבוי לפני העברה.
- [ ] לשחזר לדיסק Render רק כשהשירות עצור או לפני תעבורת לקוחות.
- [ ] לאמת ספירת tenants/workers, לפענח ולבדוק כל integration, ולבדוק לקוח קיים לאחר השחזור.
- [ ] אם מפתח ההצפנה הישן אינו זמין, לתעד זאת ולחבר מחדש כל OAuth/webhook; שחזור הקבצים לבדו אינו משחזר את החיבורים.
- [ ] אם אין export מאומת, להשיק כ־fresh launch ולא לטעון שהנתונים שוחזרו.

## משתני סביבה לפרודקשן

| Variable | חובה | ערך/הערה ל־Render |
|----------|------|--------------------|
| `NODE_ENV` | כן | `production` |
| `ADMIN_TOKEN` | כן | סוד אקראי ארוך; Bearer auth ל־admin API |
| `INTEGRATIONS_SECRET` | כן | סוד הצפנת חיבורים; ב־recovery חייב להיות זהה לערך הישן |
| `LLM_API_KEY` | כן לתשובות אמיתיות | בלי מפתח מתקבל mock בלבד ו־`/ready` נכשל |
| `LLM_BASE_URL` | כן ב־Blueprint | endpoint ציבורי HTTPS בשליטת המפעיל; `https://api.openai.com` או `https://openrouter.ai/api` |
| `PUBLIC_BASE_URL` | לפי צורך | ב־Render נעשה fallback אוטומטי ל־`RENDER_EXTERNAL_URL`; חובה רק לדומיין קנוני מותאם |
| `TRUST_PROXY_HEADERS` | כן | `1`, מאחורי ה־proxy של Render |
| `DATA_DIR` | כן | `/app/data` |
| `DB_PATH` | כן | `/app/data/earnings.db` |
| `TENANTS_DIR` | כן | `/app/data/tenants` |
| `REQUIRE_PERSISTENT_VOLUME` | כן | `1`; גורם ל־`/ready` להיכשל בלי mount אמיתי |
| `PAYMENT_AUTO_VERIFY` | כן | `0`; מצב ה־stub לבדיקות בלבד ונחסם על ידי `/ready` בפרודקשן |
| `EMBED_ALLOW_PUBLIC` | כן | `0` ב־safe launch; לשנות ל־`1` רק כשמאשרים embed חיצוני |
| `EMBED_ALLOWED_ORIGINS` | אם embed ציבורי פעיל | allow-list מפורש של HTTPS origins; `*` רק בהחלטה מודעת |
| `BIT_PHONE` או `PAYPAL_ME` | לפחות אחד | נשמר כסוד; אין לשמור מספר אמיתי ב־Git |
| `AGENT_OWNER_CONTACT` | כן | כתובת תמיכה שמוצגת למשתמשים |
| `WEBHOOK_NOTIFY_URL` | אופציונלי | JSON webhook ללידים/escalations |
| `TRIAL_DAYS` | החלטת בעלים | `0` לביטול; כל מספר אחר משנה את הצעת הניסיון ודורש החלטה עסקית מפורשת |
| `BUSINESS_HOURS` | אופציונלי | שעות ברירת מחדל ל־`check_business_hours` |

## שער 1 — מוכנות מוצר

- [ ] Hebrew-first landing copy ואמון B2B.
- [ ] self-serve signup נבדק מקצה לקצה בפרודקשן Render.
- [ ] paywall, אסמכתה ואישור אדמין נבדקו מול דיסק קבוע.
- [ ] SLA לאישור תשלום מוצג בבירור.
- [ ] nav אדמין אינו חשוף כפעולה ציבורית.
- [ ] WhatsApp channel (Meta Business API או Twilio) — עדיפות גבוהה לשוק הישראלי.

## שער 2 — Go-to-market בישראל

- [ ] **ICP:** קליניקות, תיווך, מסעדות ו־e-commerce עם 5–50 עובדים.
- [ ] **ערוצים:** LinkedIn IL, קבוצות עסקים בפייסבוק, WhatsApp Status ופנייה ל־50 פיילוטים.
- [ ] **הצעה:** להחליט אם להציע 14 ימי ניסיון לעובד אחד + שיחת הקמה; ברירת המחדל הבטוחה היא `TRIAL_DAYS=0`.
- [ ] **הוכחה:** שלושה case studies שעברו מ־demo לפיילוט אמיתי.
- [ ] **משפטי:** פרטיות, תנאים וחשבונית/מע"מ בהתאם לסטטוס העסק.

## שער 3 — תפעול לפני לקוח ראשון

- [ ] לאמת בעלות על מספר Bit/PayPal; לא לשמור פרטים אמיתיים ב־Git.
- [ ] לחבר custom domain ולתקן `PUBLIC_BASE_URL`, OAuth callbacks ו־webhooks.
- [ ] להפעיל גיבוי קבוע של `/app/data` ולבדוק restore בפועל.
- [ ] להגדיר תקציב LLM ומגבלות שימוש לפני קמפיין.
- [ ] להגדיר ניטור ל־`/ready`; `503` צריך לעצור תעבורה ולהתריע.

## Vercel — Preview בלבד

- Vercel משתמש ב־`/tmp` אקראי/זמני; הנתונים מתאפסים בין cold starts ופריסות.
- מותר להשתמש ב־PR previews לבדיקות UI זמניות בלבד.
- **אסור ש־`main` יבצע Vercel Production auto-deploy.** יש לנתק את חיבור ה־production או לשנות את הגדרות Git לפני merge.
- אין להציג URL של Vercel כפרודקשן ואין לבצע בו buyer/data migration validation.
