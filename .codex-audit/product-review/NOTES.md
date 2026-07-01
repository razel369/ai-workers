# AI Workers SaaS Review Notes

Audit date: 2026-06-30
Local review URL: http://localhost:9876

## Captured Flow

1. `01-dashboard.png` - public dashboard / landing page. Healthy visually, but more dashboard-like than conversion-focused.
2. `02-marketplace-desktop.png` - marketplace. Strong template catalog and pricing visibility; trust suffers from game-like rarity/stars.
3. `03-template-preview.png` - worker preview modal. Useful, concrete, and one of the strongest conversion assets.
4. `04-builder-pending-payment.png` - builder after buying a template. Functional wizard shape, but copy mixes English worker defaults with Hebrew UI.
5. `05-chat-paywall.png` - unpaid chat paywall. Clear blocked state, but payment is manual and depends on admin activation.
6. `06-active-chat-blocked.png` - paid worker after admin activation. Blocked by a UI/API mismatch: paid worker still renders paywall.
7. `07-marketplace-mobile.png` - mobile marketplace. Responsive enough to use, but the first conversion action sits too low after a tall hero/stats area.

## Key Findings

### Functional

- Paid chat is blocked in the UI after activation. `listWorkers()` adds `isActive`, but `getWorker()` / `parseWorkerRow()` does not; the chat screen checks `w.isActive` from `GET /api/workers/:id`, so active paid workers still see the paywall.
- Existing API tests pass when a server is running with the expected admin token, but they do not catch the rendered chat blocker.
- `npm test` only runs `worker-tests.js`; `test.js` is separate and the README count is stale.
- The app has no self-serve signup/payment loop yet. Users need a manually issued `sk_...` key before buying.

### Security And Production Readiness

- `/earnings` and `/earnings.csv` are public and expose business/payment telemetry.
- Admin token can be passed via query string, which leaks through logs, browser history, and shared URLs.
- `/api/mcp/discover` accepts arbitrary URLs server-side and is unauthenticated, creating SSRF risk.
- CORS is wide open for all responses.
- API key quotas exist in schema, but regular authenticated worker routes validate keys without consuming quota.

### UX And Conversion

- The niche is strong: Hebrew-first AI workers for Israeli businesses is concrete and differentiated.
- The template preview modal is the best selling moment because it demonstrates the worker.
- The key-first buying model is the biggest conversion break. A normal SaaS buyer expects signup, checkout/payment, activation, then build/chat.
- Manual admin activation needs clearer contact, expected SLA, and payment proof flow.
- "Rare / epic / legendary" and star ratings create marketplace energy, but they reduce trust for B2B/legal/clinic/property audiences unless backed by real proof.
- Admin navigation is visible to everyone, which distracts buyers and makes the product feel unfinished.

### Visual Design And Accessibility

- The interface is polished and energetic, but the dark purple/gold palette is very dominant and game-like.
- Muted gray/purple text on dark backgrounds is likely low-contrast in several card/stat/secondary areas.
- Mobile works, but hero + stats push actual templates and CTAs too far down.
- The product uses icons and animation effectively, but motion/background effects should respect reduced-motion preferences before production.

## Top Fix Order

1. Fix the active chat blocker by returning `isActive` from `parseWorkerRow()` or checking `status` + `paidUntil` in the UI.
2. Protect `/earnings`, `/earnings.csv`, admin pages, and MCP discovery.
3. Replace query-string admin tokens with Authorization-only admin auth.
4. Create a real buyer path: signup/key issuance, payment intent/proof, activation status, and contact/WhatsApp fallback.
5. Add a browser-level E2E test for buy -> mark paid -> open chat -> send message.
6. Rework marketplace trust signals: real examples, industries, outcomes, and proof instead of rarity/stars.
7. Tighten mobile hierarchy so templates and the first CTA arrive sooner.
