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
sudo ./deploy/oci/bootstrap.sh
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
sudo ./deploy/oci/deploy.sh
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
sudo ./deploy/oci/backup.sh
```

Copy both files from `backups/` to a different machine. Test a restore before
claiming recovery. A new VM starts empty; it does not recover the old Railway
volume automatically. A valid recovery also requires the exact historical
`INTEGRATIONS_SECRET` (or the old `ADMIN_TOKEN` if it was the encryption-key
fallback), not just the SQLite files.

Treat the local archive as staging only: it is on the same boot volume as the
live data and does not survive every termination/reclamation scenario. Store the
archive in encrypted off-VM storage, verify it there with
`sha256sum -c ai-workers-data-*.tar.gz.sha256`, and retain the two production
secrets separately in the owner's password manager. The script refuses to start
when there is not enough free space; remove old local archives only after their
off-VM copies are verified.

Official constraints: [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
