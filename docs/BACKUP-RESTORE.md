# Backups and restore

Every customer key, lead, escalation, knowledge base and chat transcript lives
in SQLite on one volume. Losing that volume loses the product **and** every
customer's data at once — which is also a notification-grade incident under
Israeli privacy law. This is the one failure the business cannot recover from,
so it gets its own document.

## What runs

`backup.js` takes a daily hot snapshot:

1. `VACUUM INTO` on the platform DB and every tenant DB. This gives a consistent
   copy while the server is still serving — copying the file directly can
   capture a torn page mid-transaction.
2. Packs them into a single self-describing archive (`AIWBK1` header + JSON
   index + raw members).
3. Gzips it.
4. Encrypts with AES-256-GCM when `BACKUP_ENCRYPTION_KEY` is set.
5. Uploads to any S3-compatible bucket (SigV4, no SDK).
6. Prunes local copies beyond `BACKUP_KEEP_LOCAL`.

**A backup that stays on the volume it is protecting is not a backup.** Configure
off-site upload; `/health.backups.warnings` says so loudly until you do.

## Configure

```bash
BACKUP_ENABLED=1
BACKUP_DIR=/app/data/backups
BACKUP_KEEP_LOCAL=7
BACKUP_RUN_HOUR=3
BACKUP_ENCRYPTION_KEY=<64 hex chars>   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Off-site — AWS S3, Cloudflare R2, Backblaze B2 or MinIO
BACKUP_S3_BUCKET=ai-workers-backups
BACKUP_S3_REGION=auto
BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
BACKUP_S3_PREFIX=prod
```

Store `BACKUP_ENCRYPTION_KEY` somewhere **other than** the server it protects.
An encrypted archive whose only key died with the volume is not recoverable.

## Check

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" $BASE/api/admin/backups
```

`healthy: false` means either no successful run in 36 hours or the last run
failed. `verification` decrypts and unpacks the newest archive to prove it is
readable — an untested backup is a guess.

Force one:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $BASE/api/admin/backup-now
```

## Restore

Restore into a staging directory, verify, then swap. Never restore straight over
live data.

```bash
node --experimental-sqlite -e "
  process.env.BACKUP_ENCRYPTION_KEY='<key>';
  const b = await import('./backup.js');
  console.log(b.restoreBackup('/app/data/backups/backup-<stamp>.aiwbk.gz.enc', '/tmp/restore'));
"
```

Produces:

```
/tmp/restore/platform/earnings.db
/tmp/restore/tenants/<tenantId>/workers.db
```

Then:

1. Stop the service.
2. Verify a couple of tenant DBs open and contain expected rows.
3. Move the current `/app/data` aside (do not delete it).
4. Copy `platform/earnings.db` to `DB_PATH` and `tenants/` to `TENANTS_DIR`.
5. Start, check `/health` → `persistentStorage: true`.
6. Spot-check one tenant's worker list and chat history.

## Test this quarterly

A restore path that has never been exercised is not a restore path. Run a real
restore into a staging environment at least once a quarter and confirm a tenant
can chat with their worker afterwards. `business-tests.js` covers the
archive/restore round-trip on every CI run, but that is not a substitute for
rehearsing the production procedure.
