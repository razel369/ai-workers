# Google Media API (Image & Video)

This project uses **Google AI Studio / Gemini API** with an API key — the simplest and cheapest path for startups (no Vertex GCP project required).

## Models (July 2026)

| Capability | Default model ID | Notes |
|------------|----------------|-------|
| **Image (cheapest, newest)** | `gemini-3.1-flash-lite-image` | Nano Banana 2 Lite — ~$0.034 per 1K image |
| Image (alternative) | `imagen-4.0-fast-generate-001` | $0.02/image — deprecated Aug 2026 |
| **Video (cheapest)** | `veo-3.1-lite-generate-preview` | Veo 3.1 Lite — from $0.05/sec (720p+audio) |

### Why Gemini API (not Vertex)?

- Single **API key** from [Google AI Studio](https://aistudio.google.com/apikey)
- Pay-as-you-go billing on paid tier (no free tier for image/video generation)
- Same models as Vertex for Veo/Nano Banana; less setup for early-stage teams

## Pricing estimates (paid tier, USD)

### Images — Nano Banana 2 Lite (`gemini-3.1-flash-lite-image`)

- **~$0.0336 per 1K (1024×1024) image**
- 100 images/month ≈ **$3.40**
- 1,000 images/month ≈ **$34**

### Images — Imagen 4 Fast (legacy fallback)

- **$0.02 per image** (shut down Aug 17, 2026)

### Video — Veo 3.1 Lite (`veo-3.1-lite-generate-preview`)

| Resolution | With audio | Without audio |
|------------|------------|---------------|
| 720p | $0.05/sec | $0.03/sec |
| 1080p | $0.08/sec | $0.05/sec |

Examples (720p, with audio, 6-second clip):

- 10 videos/month ≈ **$3.00**
- 50 videos/month ≈ **$15.00**

> You are only charged when generation succeeds.

## Environment variables

```env
# Required for real generation (either name works)
GOOGLE_AI_API_KEY=
# GEMINI_API_KEY=

# Optional overrides
GOOGLE_MEDIA_IMAGE_MODEL=gemini-3.1-flash-lite-image
GOOGLE_MEDIA_VIDEO_MODEL=veo-3.1-lite-generate-preview
GOOGLE_MEDIA_VIDEO_MAX_WAIT_MS=90000

# Rate limits (per tenant)
MEDIA_GEN_LIMIT_PER_MONTH=50
```

Without an API key, workers run in **mock mode** (SVG placeholders) — tests pass without billing.

## Worker tools

| Tool | Description |
|------|-------------|
| `generate_image` | Hebrew/English prompt → markdown image link + outbox entry |
| `generate_video` | Text (+ optional image) → async Veo job, polls until ready |
| `check_video_status` | Poll pending video job by `jobId` |

## Templates with media

- **social-media-creator-he** — Instagram/LinkedIn posts + AI images
- **restaurant-manager-he** — menu promo images
- **real-estate-il** — stylized listing visuals (not real photos)
- **content-he** — blog header images

## API endpoints used

```
POST https://generativelanguage.googleapis.com/v1beta/interactions
  → Nano Banana image generation

POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning
GET  https://generativelanguage.googleapis.com/v1beta/{operation_name}
  → Veo 3.1 Lite video generation (async)
```

## Safety

- Basic NSFW keyword filter on prompts (Hebrew + English)
- Per-tenant monthly generation counter in SQLite (`media_gen_usage`)
- Generated assets stored under `TENANTS_DIR/{tenantId}/media/`
- Served at `GET /api/media/{tenantId}/{filename}` (requires tenant API key)

## Demo message flow

1. Enable tools `generate_image`, `generate_video` on a worker (or use `social-media-creator-he` template).
2. User (Hebrew): `צור פוסט לאינסטגרם על קפה חדש שלנו עם תמונה`
3. Agent calls `generate_image` with brand-safe prompt → returns `![instagram_post](https://…/api/media/…/med_….png)`
4. Agent replies with caption + hashtags + markdown image link.
5. For video: `צור סרטון 6 שניות של המסעדה בערב` → `generate_video` → job ID → URL when ready.

## References

- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Nano Banana image generation](https://ai.google.dev/gemini-api/docs/interactions/image-generation)
- [Veo 3.1 Lite](https://ai.google.dev/gemini-api/docs/models/veo-3.1-lite-generate-preview)
- [Veo 3.1 Lite blog post](https://blog.google/innovation-and-ai/technology/ai/veo-3-1-lite/)
