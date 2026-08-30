# וידג'ט צ'אט מוטמע

הטמיעו את העובד הפעיל באתר העסק עם שורה אחת.

## דרישות

- העובד חייב להיות **פעיל** (`isActive`).
- ברירת המחדל הבטוחה היא `EMBED_ALLOW_PUBLIC=0`, שמאפשרת שימוש באותו origin בלבד. לצ'אט מדומיין חיצוני: הגדירו `EMBED_ALLOW_PUBLIC=1` וגם `EMBED_ALLOWED_ORIGINS=https://your-website.com` (רשימה מופרדת בפסיקים למספר אתרים). `*` מותר רק בהחלטה מודעת על embed ציבורי מכל אתר.

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

### עם מפתח tenant (מומלץ לפרודקשן)

```html
<script
  src="https://YOUR_HOST/embed.js"
  data-worker="wk_YOUR_WORKER_ID"
  data-key="sk_..."
  data-label="שירות לקוחות"
  defer
></script>
```

`data-key` נשלח ב-`Authorization: Bearer` ל-`/api/embed/chat`.

## API

| נתיב | תיאור |
|------|--------|
| `GET /embed.js` | סקריפט הווידג'ט |
| `GET /api/embed/config?workerId=` | שם העובד וסטטוס |
| `POST /api/embed/chat` | `{ workerId, message, customerId? }` |

## אבטחה

- `EMBED_ALLOW_PUBLIC=0` חוסם CORS חיצוני וגם config לעובדים לא פעילים.
- Rate limit גלובלי חל על כל הבקשות.
- העדיפו `data-key` כשהאתר המארח אינו באותו דומיין.

## סיכום הזמנה לעובד

`GET /invoice/:workerId` — HTML עם מחיר וסטטוס גישה, שמסומן במפורש כסיכום הזמנה שאינו חשבונית מס או קבלה.
