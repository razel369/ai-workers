# AI Workers — Launch Checklist (Israel)

## Phase 0 — Infrastructure (this sprint)

- [ ] `gh auth login` + push to `github.com/razel369/ai-workers`
- [ ] `vercel login` + `vercel link` + set env vars (`ADMIN_TOKEN`, `LLM_API_KEY`, `PUBLIC_BASE_URL`)
- [ ] **Production DB**: deploy Docker image on Railway/Fly with persistent `/app/data` volume
- [ ] Point `PUBLIC_BASE_URL` to production URL (Railway primary; Vercel for demos only)
- [ ] Run `npm test` green on GitHub Actions

## Phase 1 — Product readiness

- [ ] Fix paid-worker chat paywall (`isActive` on `GET /api/workers/:id`)
- [ ] Hide admin nav from public marketplace
- [ ] Hebrew-first landing copy; reduce game-like rarity/stars for B2B trust
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

| Variable | Required |
|----------|----------|
| `ADMIN_TOKEN` | Yes |
| `LLM_API_KEY` | Yes (real replies) |
| `PUBLIC_BASE_URL` | Yes |
| `BIT_PHONE` or `PAYPAL_ME` | At least one |
| `AGENT_OWNER_CONTACT` | Yes (support) |
| `TRUST_PROXY_HEADERS` | Yes behind Railway/Vercel |

See [business-model.canvas.tsx](file:///C:/Users/rmalk/.cursor/projects/c-Users-rmalk-paid-agent-demo/canvases/business-model.canvas.tsx) for unit economics.
