# AI Workers — Launch Checklist (Israel)

## Phase 0 — Infrastructure (this sprint)

- [ ] Push to `github.com/razel369/ai-workers`
- [ ] **Production DB (Railway — recommended)**
  - [ ] Create Railway project from GitHub repo (uses `Dockerfile` + `railway.toml`)
  - [ ] Add **persistent volume** mounted at `/app/data` (SQLite + tenant DBs)
  - [ ] Set env vars in Railway dashboard (see below)
  - [ ] Set `PUBLIC_BASE_URL` to the Railway URL (e.g. `https://ai-workers-production.up.railway.app`)
  - [ ] Verify `GET /health` returns `"persistentStorage": true`
- [ ] Vercel (`paid-agent-demo.vercel.app`) — demos only; SQLite is ephemeral on `/tmp`
- [ ] Run `npm test` green on GitHub Actions

## Phase 1 — Product readiness

- [ ] Fix paid-worker chat paywall (`isActive` on `GET /api/workers/:id`)
- [ ] Hide admin nav from public marketplace
- [ ] Hebrew-first landing copy; B2B trust (no game-like UI)
- [ ] Self-serve signup flow tested end-to-end
- [ ] Payment proof + admin approval SLA documented on paywall
- [ ] WhatsApp channel (Meta Business API or Twilio) — highest ROI for IL market

## Phase 2 — Go-to-market (Israel)

- [ ] **ICP**: clinics, real estate agencies, restaurants, e-commerce (5–50 employees)
- [ ] **Channels**: LinkedIn IL, Facebook business groups, WhatsApp status, cold outreach to 50 pilots
- [ ] **Offer**: 14-day trial on one worker template; setup call included
- [ ] **Proof**: 3 case studies (even mock → pilot → real)
- [ ] **Legal**: privacy policy (חוק הגנת הפרטיות), terms, invoice with מע"מ if עוסק מורשה

## Phase 3 — Monetization experiments

- [ ] A/B: setup fee only vs setup + monthly
- [ ] Bundle: 3 workers for 499 ₪/mo
- [ ] Annual prepay: 2 months free
- [ ] Agency white-label tier

## Env vars (production)

| Variable | Required | Notes |
|----------|----------|-------|
| `ADMIN_TOKEN` | Yes | Long random secret; Bearer auth for admin API |
| `LLM_API_KEY` | Yes (real replies) | Platform LLM; mock mode if empty |
| `PUBLIC_BASE_URL` | Yes | Full URL, no trailing slash |
| `TRUST_PROXY_HEADERS` | Yes on Railway/Vercel | Set to `1` |
| `DB_PATH` | Yes on Railway | `/app/data/earnings.db` (set in `railway.toml`) |
| `TENANTS_DIR` | Yes on Railway | `/app/data/tenants` |
| `BIT_PHONE` or `PAYPAL_ME` | At least one | Israeli payment channels |
| `AGENT_OWNER_CONTACT` | Yes | Support email shown on landing |
| `WEBHOOK_NOTIFY_URL` | Optional | JSON webhook for leads/escalations |
| `BUSINESS_HOURS` | Optional | Default hours for `check_business_hours` tool |

### Railway deploy (5 min)

1. **New Project** → Deploy from GitHub → select `razel369/ai-workers`
2. **Volume**: Service → Settings → Volumes → Add volume, mount path `/app/data`
3. **Variables** (Railway dashboard):
   ```
   ADMIN_TOKEN=<random-hex>
   LLM_API_KEY=sk-...
   PUBLIC_BASE_URL=https://<your-service>.up.railway.app
   TRUST_PROXY_HEADERS=1
   AGENT_OWNER_CONTACT=you@example.com
   BIT_PHONE=972...
   ```
4. Deploy → open `https://<your-service>.up.railway.app/health`
5. Smoke test: signup → buy template → activation proof → admin approve → chat

### Vercel (demos only)

- Ephemeral `/tmp/ai-workers-data` — data resets on cold deploy
- Use for UI previews; **do not** use as primary production DB

See [business-model.canvas.tsx](file:///C:/Users/rmalk/.cursor/projects/c-Users-rmalk-paid-agent-demo/canvases/business-model.canvas.tsx) for unit economics.
