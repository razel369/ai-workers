# Production health check (`GET /health`)

Railway, Fly.io, and CI use this endpoint to confirm the service is alive and correctly configured.

## Request

```http
GET /health HTTP/1.1
Host: your-service.up.railway.app
```

No authentication required.

## Response (200)

```json
{
  "ok": true,
  "agent": "AI Workers",
  "channels": ["bit", "paypal"],
  "adminEnabled": true,
  "llmConfigured": true,
  "llmProvider": "openai_compatible",
  "llmModel": "gpt-5.5",
  "publicBaseUrl": "https://your-service.up.railway.app",
  "dbPath": "/app/data/earnings.db",
  "tenantsDir": "/app/data/tenants",
  "persistentStorage": true
}
```

### Field reference

| Field | Healthy value | Notes |
|-------|---------------|-------|
| `ok` | `true` | Always `true` when server responds |
| `adminEnabled` | `true` in production | Set `ADMIN_TOKEN` in Railway |
| `llmConfigured` | `true` for real AI | `false` = mock/demo replies only |
| `channels` | non-empty array | At least one of Bit/PayPal/etc. configured |
| `publicBaseUrl` | your Railway URL | Must match `PUBLIC_BASE_URL` env |
| `persistentStorage` | `true` on Railway | `false` if `DB_PATH` points at `/tmp` (data loss on restart) |
| `dbPath` | `/app/data/earnings.db` | Matches volume mount |
| `tenantsDir` | `/app/data/tenants` | Worker SQLite files per tenant |

## Extended manual checks

After deploy, also verify:

```bash
# Marketplace HTML
curl -s -o /dev/null -w "%{http_code}" https://YOUR_HOST/marketplace
# Expect: 200

# Templates API (no auth)
curl -s https://YOUR_HOST/api/workers/templates | head -c 200
# Expect: JSON with "templates" array

# Legal pages (Hebrew)
curl -s -o /dev/null -w "%{http_code}" https://YOUR_HOST/privacy
curl -s -o /dev/null -w "%{http_code}" https://YOUR_HOST/terms
# Expect: 200
```

## Smoke script

Run from your machine against production:

```powershell
.\scripts\smoke-production.ps1 -BaseUrl "https://your-service.up.railway.app"
```

Exit code `0` = all checks passed.

## Railway configuration

`railway.toml` sets `healthcheckPath = "/health"`. If health fails:

1. Confirm `PORT` is not hard-coded incorrectly.
2. Confirm volume mounted at `/app/data`.
3. Check deploy logs for SQLite or startup errors.

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| `persistentStorage: false` | Missing volume or wrong `DB_PATH` |
| `adminEnabled: false` | `ADMIN_TOKEN` not set |
| `llmConfigured: false` | `LLM_API_KEY` missing |
| `channels: []` | No `BIT_PHONE` / `PAYPAL_ME` / etc. |
| Wrong `publicBaseUrl` | Set `PUBLIC_BASE_URL` + `TRUST_PROXY_HEADERS=1` |

## Related

- [LAUNCH-CHECKLIST.md](./LAUNCH-CHECKLIST.md)
- [GTM-PILOT.md](./GTM-PILOT.md)
