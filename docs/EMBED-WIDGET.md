# וידג'ט צ'אט מוטמע

הטמיעו את העובד הפעיל באתר העסק עם שורה אחת.

**סטטוס 2026-08-30:** המימוש קיים בקוד ונבדק מקומית בלבד. אין כרגע URL
פרודקשן, תעודת TLS חיה, דומיין לקוח שנבדק end-to-end או LLM אמיתי מאומת.
לכן אין להציג את הווידג'ט כערוץ פעיל ללקוחות לפני השלמת הצ'קליסט למטה.

## דרישות

- העובד חייב להיות **פעיל** (`isActive`).
- ברירת המחדל הבטוחה היא `EMBED_ALLOW_PUBLIC=0`, שמאפשרת שימוש באותו origin בלבד. לצ'אט מדומיין חיצוני: הגדירו `EMBED_ALLOW_PUBLIC=1` וגם `EMBED_ALLOWED_ORIGINS=https://your-website.com` (רשימה מופרדת בפסיקים למספר אתרים). `*` אינו נתמך.

## העתקה לאתר

החליפו `YOUR_HOST` ו-`wk_YOUR_WORKER_ID`:

```html
<script
  src="https://YOUR_HOST/embed.js"
  data-worker="wk_YOUR_WORKER_ID"
  data-label="צ'אט עם העסק"
  data-position="right"
  defer
></script>
```

אין להכניס tenant API key, סוד או token קבוע ל-HTML. הווידג'ט מבקש
מהשרת session קצר-חיים שמוגבל לעובד ול-origin שבו הוא נטען. מזהה הלקוח
נוצר בשרת ואינו מתקבל מהדפדפן.

## API

| נתיב | תיאור |
|------|--------|
| `GET /embed.js` | סקריפט הווידג'ט |
| `GET /api/embed/config?workerId=` | שם העובד וסטטוס |
| `POST /api/embed/session` | יוצר session קצר-חיים לעובד הפעיל |
| `POST /api/embed/chat` | `{ message }` עם `Authorization: Embed emb_...` |

## אבטחה

- `EMBED_ALLOW_PUBLIC=0` מאפשר רק same-origin. עובד לא פעיל חסום תמיד.
- Rate limit גלובלי חל על כל הבקשות.
- בנוסף קיימים תקציבי abuse שעתיים לפי session, ‏IP+worker ו־worker; ערכי
  ברירת המחדל חייבים להיבדק בעומס אמיתי ואינם SLA או הוכחת עמידות להתקפה.
- `EMBED_ALLOWED_ORIGINS` חייב להכיל origins מדויקים. `*` אינו מתקבל בשער
  המוכנות לפרודקשן.
- session של embed אינו מעניק גישה ל-API של בעל העסק, אינו יכול לבחור
  `customerId`, ואינו מחליף authentication של dashboard או CLI.

## מה הוכח ומה לא

- תרחישי ה־eval המקומיים הם mock planning-only; הם אינם שולחים הודעה דרך
  הווידג'ט לדומיין חיצוני ואינם קוראים ל־LLM.
- בדיקות source/API יכולות להוכיח scope של token, origin מדויק וחסימת עובד לא
  פעיל. הן אינן מוכיחות DNS, ‏TLS, ‏CORS בדפדפן לקוח אמיתי, latency, uptime,
  עומס, accessibility או טיפול בפניות אמיתיות.
- Vercel preview משתמש באחסון זמני ואסור להזין בו מידע של לקוחות או להציגו
  כפרודקשן.

## שער הפעלה לדומיין לקוח

- [x] `npm test` ירוק מקומית על ה־worktree הנוכחי; עדיין נדרש CI ירוק על
  ה־commit הסופי לפני פריסה.
- [ ] Oracle/DNS/TLS נבדקו מבחוץ ו־`/ready` מחזיר 200.
- [ ] נוסף origin מדויק בלבד ל־`EMBED_ALLOWED_ORIGINS`; אין wildcard.
- [ ] worker עבר knowledge review, תשלום/entitlement אמיתי ו־LLM smoke אמיתי.
- [ ] נבדקו session expiry, refresh, CORS reject, מכסות abuse, 429 והתאוששות.
- [ ] הווידג'ט נבדק ב־mobile וב־desktop באתר הלקוח עצמו, כולל RTL,
  keyboard/focus, disclosure שמדובר ב־AI וקישור פרטיות.
- [ ] הלקוח אישר אילו נתונים נאספים, retention, הסלמה לאדם ואיש קשר לתמיכה.

## סיכום הזמנה לעובד

`GET /invoice/:workerId` — HTML עם מחיר וסטטוס גישה, שמסומן במפורש כסיכום הזמנה שאינו חשבונית מס או קבלה.
