# Oracle Cloud Always Free deployment

This is the zero-cost hosting path for AI Workers. It keeps the existing Node,
SQLite, and uploaded-file architecture on a persistent VM disk. It is not a
production SLA: Oracle may have no A1 capacity, and may reclaim an Always Free
compute instance that it classifies as idle. Keep verified off-VM backups.

## 1. Create only an Always Free VM

In the Oracle Cloud account's **home region**, create an Ubuntu AArch64 compute
instance whose shape is explicitly labelled **Always Free Eligible**:

- Shape: `VM.Standard.A1.Flex`
- Suggested size: 1 OCPU and 4 GB RAM
- Boot volume: 50 GB, within the Always Free combined storage allowance
- Public IPv4: enabled
- Do not upgrade the account to Pay As You Go and do not select an unlabelled
  paid resource

Oracle account creation, login, region selection, and any identity/card check
are owner-controlled steps. Stop if the console shows a non-zero estimate.
As verified against Oracle's documentation on 2026-08-30, the Always Free A1
allowance is currently described as 2 OCPUs / 12 GB total, with 200 GB combined
boot + block volume storage. Limits can change; the live console is decisive.

## 2. Network and a free hostname

Allow inbound TCP 80 and 443 from the internet. Restrict SSH/22 to the owner's
current public IP; do not expose 8765 because it is internal to Docker.

Create a free hostname at [DuckDNS](https://www.duckdns.org/) and point it at the
VM's public IPv4 address. The example below uses
`ai-workers-il.duckdns.org`. Caddy obtains and renews HTTPS automatically after
DNS and ports 80/443 are correct.

## 3. Install and configure

SSH to the VM, clone the repository and check out the reviewed candidate branch:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/razel369/ai-workers.git
cd ai-workers
git checkout codex/revive-ai-workers-baseline
sudo bash ./deploy/oci/bootstrap.sh
```

Edit `.env`, replace every `REPLACE_ME`, and keep it private:

```bash
sudo nano .env
sudo chmod 600 .env
```

Required launch decisions are the public hostname, owner contact, two distinct
random secrets, a real LLM configuration, and at least one real payment channel.
Hosting can be $0 while the LLM provider still charges; select a genuine free
quota/model if the entire stack must stay at $0.

## 4. Deploy and verify

```bash
sudo bash ./deploy/oci/deploy.sh
sudo docker compose --env-file .env -f compose.oci.yaml ps
```

Then check the evidence gates separately:

```bash
curl -i https://ai-workers-il.duckdns.org/health
curl -i https://ai-workers-il.duckdns.org/infra-ready
curl -i https://ai-workers-il.duckdns.org/ready
```

`/health` proves only that the process responds. `/infra-ready` proves that
SQLite, host-path writing and the Docker bind mount are usable; it does not
prove that Oracle will retain the VM or that an off-VM backup exists. Do not send customers to the site
until `/ready` returns HTTP 200 with `ok:true` and a real LLM buyer flow passes.

## 5. Back up and restore

Create a consistent archive while briefly stopping the app container:

```bash
sudo bash ./deploy/oci/backup.sh
```

Before the first run, generate two additional, distinct secrets with
`openssl rand -hex 32` and set `BACKUP_ENCRYPTION_SECRET` and
`BACKUP_MANIFEST_SECRET` in `.env`. The script never leaves a completed plaintext
archive: it encrypts locally with AES-256-CBC + PBKDF2 (250,000 iterations), then
creates an HMAC-SHA256 signed manifest bound to the ciphertext name, size and
SHA-256 digest. Both secrets are required to restore; retain them outside the VM.

For an automatic off-VM copy, configure a dedicated **rclone crypt** remote once
with `sudo rclone config`, then set `BACKUP_RCLONE_REMOTE` in `.env` (for example,
`encrypted-gdrive:ai-workers-production`). The script verifies that the selected
remote is actually type `crypt`, uploads the encrypted archive + manifest + HMAC,
and downloads the remote bytes for comparison before reporting success. Leaving
the variable empty produces only an encrypted local copy, not disaster recovery.
Local encrypted generations rotate after `BACKUP_LOCAL_RETENTION_DAYS` (default
14); the dedicated crypt path rotates matching generations after
`BACKUP_REMOTE_RETENTION_DAYS` (default 90). Choose periods that satisfy the
published privacy policy and legal hold requirements.

Run the non-destructive restore drill against a selected archive:

```bash
sudo bash ./deploy/oci/restore-drill.sh \
  /absolute/path/to/backups/ai-workers-data-YYYYMMDDTHHMMSSZ.tar.gz.enc
```

The drill authenticates the signed manifest before decrypting, then rejects
absolute/traversal paths, duplicate paths, symlinks, hardlinks, devices, fifos,
unsupported entries and oversized archives before writing any member. It runs
the SQLite verifier as a numeric non-root container user when possible and checks
`quick_check` plus `foreign_key_check` on the platform DB and every tenant DB. It
never overwrites `data/`. A final launch gate must still test the restored
candidate through `/infra-ready`, `/ready`, login, an existing worker, and a real
LLM chat.

## 6. Monitor readiness

`deploy/oci/monitor.sh` checks both `/health` and the stricter `/ready`, stores
only the last state under `data/`, and exits non-zero when customer traffic
should be stopped. If `MONITOR_ALERT_WEBHOOK_URL` is configured, it sends an
HTTPS notification only when the state changes (failure or recovery).

Run it manually first, then schedule it every five minutes with the VM's cron
or systemd timer:

```bash
sudo bash ./deploy/oci/monitor.sh
```

This local check cannot alert while the VM itself is down. Before launch, add a
separate external HTTPS monitor for `/ready`; the external monitor must expect
HTTP 200 and should alert on 503, TLS failure, timeout, or DNS failure.

Copy all three files (`.enc`, `.manifest`, `.manifest.hmac`) from `backups/` to a different machine. Test a restore before
claiming recovery. A new VM starts empty; it does not recover the old Railway
volume automatically. A valid recovery also requires the exact historical
`INTEGRATIONS_SECRET` (or the old `ADMIN_TOKEN` if it was the encryption-key
fallback), not just the SQLite files.

Treat the encrypted local archive as staging only: it is on the same boot volume
as the live data and does not survive every termination/reclamation scenario.
Keep the two backup secrets and the two application secrets separately in the
owner's password manager. The signed manifest detects ciphertext or metadata
tampering; rclone verification proves the remote bytes are readable. Neither is
a restore proof until the isolated drill actually passes.

Official constraints: [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
