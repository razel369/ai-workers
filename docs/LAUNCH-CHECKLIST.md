# AI Workers — צ'קליסט השקה לישראל

**פרודקשן נוכחי:** אין URL חי ומאומת.

**יעד חינמי מומלץ:** Oracle Cloud Always Free, ‏A1 ARM64, בלי משאב בתשלום.

**Render:** המסלול בתשלום נדחה; הפרויקט הקיים ריק, עם אפס שירותים ואפס עלות.

**Railway הישן:** היסטורי/offline; `https://paid-agent-demo-production.up.railway.app` אינו אתר פעיל.

**החלטת מוכנות:** NO-GO לפרודקשן וללקוחות משלמים. מטריצת הראיות המלאה:
[`docs/PRODUCT-READINESS.md`](PRODUCT-READINESS.md).

## מצב שחזור — 2026-08-30

- [x] ה־harness העצמאי עבר מקומית 31/31 תרחישי dry-run דטרמיניסטיים על 13 תבניות; כל שערי intent/language/tools/safety עברו 31/31. לא בוצעה קריאת LLM ולא הופעל כלי.
- [x] `npm test` המלא עבר מקומית על ה־worktree הנוכחי, כולל API, browser flow, lifecycle, CSV, Paddle production boundary, WhatsApp router, engine hardening ו־31/31 תרחישי eval. זו ראיית פיתוח מקומית בלבד.
- [ ] להריץ CI מחדש על ה־commit הסופי. CI היסטורי של diff מוקדם יותר הוא proof לקוד הישן בלבד, לא ל־candidate הנוכחי ולא לפרודקשן.
- [x] נבנתה חבילת OCI עם Docker Compose, ‏Caddy, HTTPS, volume, גיבוי וברירות מחדל fail-closed.
- [x] לא נוצר שירות Render, לא אושר חיוב וקובץ ה־Blueprint בתשלום הוסר מה־repo.
- [ ] לא נוצר ולא אומת עדיין Oracle VM חי.
- [ ] לא למזג ל־`main` לפני שנחסמה פריסת Production אוטומטית ב־Vercel.
- [ ] להריץ quality smoke עם LLM אמיתי לאחר הפריסה; הערכת mock אינה הוכחת מודל בפרודקשן.

## שער 0 — חשבון ומשאב חינמי

- [ ] בעל החשבון יוצר/נכנס לחשבון Oracle ובוחר home region; הרשמה, אימות זהות/כרטיס ו־2FA נשארים בשליטתו.
- [ ] לא לשדרג ל־Pay As You Go.
- [ ] ליצור רק `VM.Standard.A1.Flex` שמסומן **Always Free Eligible**.
- [ ] baseline: ‏1 OCPU, ‏4 GB RAM, ‏Ubuntu ARM64 ו־boot volume של 50 GB.
- [ ] לעצור לפני Create אם מוצג estimate שאינו `$0` או אם משאב כלשהו אינו מסומן Always Free.
- [ ] אם אין A1 capacity: לנסות Availability Domain אחר או להמתין; לא לעבור ל־shape בתשלום.
- [ ] לזכור שאין SLA: Oracle יכולה reclaim למכונה חינמית שהיא מסווגת כ־idle. אין להפעיל עומס מלאכותי; מגינים עם גיבוי ו־runbook שחזור.

## שער 1 — רשת, DNS ושרת

- [ ] לאפשר inbound TCP ‏80/443 מהאינטרנט.
- [ ] להגביל SSH/22 ל־IP הציבורי של הבעלים בלבד.
- [ ] לא לפתוח את 8765; רק Caddy מגיע ל־app בתוך Docker.
- [ ] ליצור hostname חינמי ב־DuckDNS ולהפנות אותו ל־public IPv4 של ה־VM.
- [ ] להריץ `sudo bash ./deploy/oci/bootstrap.sh`; הסקריפט מתקין Docker אך לא מפעיל את האפליקציה.
- [ ] לערוך `.env`, להחליף כל `REPLACE_ME`, ולוודא הרשאת `600`.
- [ ] להריץ `sudo bash ./deploy/oci/deploy.sh` ולוודא ששני הקונטיינרים healthy/running.
- [ ] לוודא תעודת HTTPS תקינה ודומיין זהה ל־`AI_WORKERS_DOMAIN`.

## שער 2 — נתונים ושחזור

VM חדש מתחיל עם `data/` ריק. פריסה ירוקה אינה משחזרת נתוני Railway.

- [ ] להחליט ולתעד: **fresh launch** ריק, או **recovery** של לקוחות קיימים.
- [ ] אם recovery: להשיג export מאומת הכולל `earnings.db` ואת כל `tenants/`.
- [ ] לשמר בנפרד את `INTEGRATIONS_SECRET` המדויק; אם לא היה מוגדר, לשמר את `ADMIN_TOKEN` הישן שהיה fallback להצפנה.
- [ ] לשמור checksum, גודל ותאריך של הגיבוי לפני העברה.
- [ ] לשחזר רק כשה־app עצור ולפני תעבורת לקוחות.
- [ ] לאמת SQLite integrity, ספירת tenants/workers, פענוח integrations ולקוח קיים.
- [ ] אם אין export מאומת, להשיק כ־fresh launch ולא לטעון שהנתונים שוחזרו.
- [ ] להגדיר שני סודות שונים, לפחות 32 תווים כל אחד: `BACKUP_ENCRYPTION_SECRET` ו־`BACKUP_MANIFEST_SECRET`, ולשמור עותק מחוץ ל־VM.
- [ ] להריץ `sudo bash ./deploy/oci/backup.sh`; לוודא שנוצרו `.tar.gz.enc`, ‏`.manifest` ו־`.manifest.hmac`. אם הוגדר `BACKUP_RCLONE_REMOTE`, הוא חייב להיות `rclone crypt` והסטטוס חייב להיות `offsite_verified`.
- [ ] להריץ `sudo bash ./deploy/oci/restore-drill.sh /absolute/path/to/archive.tar.gz.enc`, ואז לבדוק בנפרד candidate משוחזר דרך `/infra-ready`, ‏`/ready`, כניסה וצ׳אט LLM אמיתי.
- [ ] לשמור את `INTEGRATIONS_SECRET` ו־`ADMIN_TOKEN` בנפרד במנהל הסיסמאות של הבעלים; הם אינם נכללים בארכיון הנתונים.

## משתני סביבה לפרודקשן

| Variable | חובה | ערך/הערה ל־Oracle |
|----------|------|--------------------|
| `AI_WORKERS_DOMAIN` | כן | hostname חינמי שמצביע ל־VM; Compose בונה ממנו HTTPS URL |
| `NODE_ENV` | כן | נכפה ל־`production` ב־Compose |
| `ADMIN_TOKEN` | כן | סוד אקראי באורך 24+; שונה מסוד ההצפנה |
| `INTEGRATIONS_SECRET` | כן | סוד הצפנת חיבורים; ב־recovery חייב להיות זהה לערך ההיסטורי |
| `LLM_API_KEY` | כן לתשובות אמיתיות | אחסון חינמי לא מבטיח inference חינמי; לבחור quota/model חינמי אמיתי אם נדרש $0 מלא |
| `LLM_BASE_URL` | לפי ספק | endpoint ציבורי HTTPS בשליטת המפעיל |
| `LLM_MODEL` | כן | model ID זמין אצל הספק שנבחר |
| `PUBLIC_BASE_URL` | כן | נכפה ל־`https://${AI_WORKERS_DOMAIN}` ב־Compose |
| `AGENT_OWNER_CONTACT` | כן | כתובת תמיכה אמיתית שמוצגת למשתמשים |
| `TRUST_PROXY_HEADERS` | כן | נכפה ל־`1`; פורט app אינו ציבורי ונמצא מאחורי Caddy |
| `DATA_DIR` | כן | `/app/data`, מחובר ל־`./data` הקבוע ב־VM |
| `DB_PATH` | כן | `/app/data/earnings.db` |
| `TENANTS_DIR` | כן | `/app/data/tenants` |
| `REQUIRE_PERSISTENT_VOLUME` | כן | `1`; `/infra-ready` נכשל בלי Docker mount |
| `PAYMENT_AUTO_VERIFY` | כן | נכפה ל־`0` בפרודקשן |
| `TRIAL_DAYS` | כן | נכפה ל־`0` עד להחלטת עסק ותקציב מפורשת |
| `EMBED_ALLOW_PUBLIC` | כן | נכפה ל־`0`; לפתוח רק עם allow-list מאושר |
| `ALLOW_PRIVATE_NETWORK_URLS` | כן | נכפה ל־`0` |
| `BIT_PHONE`, `PAYPAL_ME` או בנק | לפחות ערוץ אחד | ערך אמיתי נשמר רק ב־`.env` המוגן, לא ב־Git |

## שער 3 — ראיות לפני URL ציבורי

- [ ] `GET /health` = ‏200 — liveness בלבד.
- [ ] `GET /infra-ready` = ‏200 — SQLite, כתיבה ו־Docker bind mount; זו אינה הוכחת retention או גיבוי מחוץ ל־VM.
- [ ] `GET /ready` = ‏200 עם `ok:true` — שערי ההגדרה והאחסון; זה עדיין אינו smoke של LLM, TLS, buyer flow או restore.
- [ ] Caddy מחזיר HTTPS תקין לאחר reboot מלא של ה־VM.
- [ ] buyer flow מלא: signup → תבנית → אסמכתת תשלום → אישור אדמין → chat עם LLM אמיתי.
- [ ] אם מוצע Paddle: לבצע עסקת production אמיתית עם price map מדויק, webhook חתום, entitlement, ביטול/refund ו־reconciliation. Sandbox אינו הוכחת כסף אמיתי.
- [ ] אם מוצע WhatsApp: מספר Meta Business מאומת מקבל הודעה אמיתית ושולח תשובה אחת בלבד; בדיקות חתימה מקומיות אינן הוכחת Meta end-to-end.
- [ ] אם מוצע Embed: לבדוק מדומיין לקוח HTTPS אמיתי origin allow-list, session expiry, abuse limits, mobile וחשיפת AI/פרטיות.
- [ ] self-serve signup, paywall ו־admin נבדקו מול הדיסק הקבוע.
- [ ] בדיקת גיבוי ושחזור עברה בפועל; עצם יצירת archive אינה הוכחת restore.
- [ ] עותק encrypted הגיע ל־`offsite_verified`, הורד במסלול שחזור נפרד, עבר restore ו־application smoke. גיבוי מקומי על אותו VM אינו disaster recovery.
- [ ] `deploy/oci/monitor.sh` רץ בהצלחה ומתוזמן; ניטור HTTPS חיצוני נפרד בודק `/ready`, ו־503/TLS/timeout מפעילים התראה ועוצרים פתיחת תעבורה.
- [ ] רק לאחר כל אלה אפשר לפרסם URL ולתאר אותו כפרודקשן.

## שער 4 — Go-to-market בישראל

- [ ] **ICP:** קליניקות, תיווך, מסעדות ו־e-commerce עם 5–50 עובדים.
- [ ] **ערוצים:** LinkedIn IL, קבוצות עסקים בפייסבוק, WhatsApp Status ופנייה ל־50 פיילוטים.
- [ ] **הצעה:** להחליט אם להציע ניסיון; ברירת המחדל הבטוחה היא `TRIAL_DAYS=0`.
- [ ] **הוכחה:** שלושה case studies שעברו מ־demo לפיילוט אמיתי.
- [ ] **פיילוט:** לפחות עסק אחד נתן הסכמה מפורשת, הפעיל scope מוגבל עם נתונים אמיתיים, ונמדדו ערך, עלות, תקלות ותמיכה. חומר GTM אינו proof לפיילוט.
- [ ] **משפטי ומס:** עו״ד/יועץ פרטיות ישראלי ורו״ח אישרו פרטיות, תנאים, עיבוד/העברות מידע, החזרים, חשבונית/קבלה ומע״מ בהתאם לסטטוס העסק. מסמכי repo הם טיוטה בלבד.
- [ ] להגדיר מגבלות שימוש גם לספק LLM חינמי; free quota יכולה להשתנות או להיגמר.

## Vercel — Preview בלבד

- Vercel משתמש ב־`/tmp` אקראי/זמני; הנתונים מתאפסים בין cold starts ופריסות.
- מותר להשתמש ב־PR previews לבדיקות UI זמניות בלבד.
- **אסור ש־`main` יבצע Vercel Production auto-deploy.** יש לנתק את חיבור ה־production או לשנות את הגדרות Git לפני merge.
- אין להציג URL של Vercel כפרודקשן ואין לבצע בו buyer/data migration validation.
