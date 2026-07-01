# וידג'ט צ'אט מוטמע

הטמיעו את העובד הפעיל באתר העסק עם שורה אחת.

## דרישות

- העובד חייב להיות **פעיל** (`isActive`).
- לצ'אט מדומיין חיצוני: הגדירו `CORS_ALLOW_ORIGIN=https://your-website.com` (או השאירו `EMBED_ALLOW_PUBLIC=1` — השרת משקף את כותרת `Origin` בנתיבי `/api/embed/*`).

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

- `EMBED_ALLOW_PUBLIC=0` חוסם config לעובדים לא פעילים.
- Rate limit גלובלי חל על כל הבקשות.
- העדיפו `data-key` כשהאתר המארח אינו באותו דומיין.

## חשבונית לעובד

`GET /invoice/:workerId` — HTML עם שורת מע"מ (placeholder).
