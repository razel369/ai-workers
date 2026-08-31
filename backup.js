// Backups — the difference between an outage and the end of the business.
//
// Every customer key, lead, escalation, knowledge base and chat transcript
// lived on exactly one Railway volume with no copy anywhere. Losing that volume
// loses the product and every customer's data at the same time, which is also a
// notification-grade incident under Israeli privacy law.
//
// This takes a consistent hot snapshot of the platform DB and every tenant DB
// (SQLite VACUUM INTO — safe while the server is serving), gzips it, optionally
// encrypts it with AES-256-GCM, and ships it off-box to any S3-compatible
// bucket. A backup that stays on the volume it is protecting is not a backup,
// so remote upload is the default path and local-only is a fallback.
//
// ENV:
//   BACKUP_ENABLED=1
//   BACKUP_DIR=/app/data/backups
//   BACKUP_KEEP_LOCAL=7                 # daily snapshots to retain on disk
//   BACKUP_ENCRYPTION_KEY=<64 hex>      # 32-byte AES key; omit = plaintext
//   BACKUP_RUN_HOUR=3
//   -- S3-compatible off-site (AWS S3, Cloudflare R2, Backblaze B2, MinIO) --
//   BACKUP_S3_BUCKET, BACKUP_S3_REGION, BACKUP_S3_ENDPOINT
//   BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_PREFIX

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const env = (k, d = '') => (process.env[k] ?? d).trim();

const ENABLED = env('BACKUP_ENABLED', '1') !== '0';
const KEEP_LOCAL = Math.max(1, Number(env('BACKUP_KEEP_LOCAL', '7')));
const RUN_HOUR = Math.min(23, Math.max(0, Number(env('BACKUP_RUN_HOUR', '3'))));
const ENC_KEY_HEX = env('BACKUP_ENCRYPTION_KEY');

let db = null;
let dbPath = '';
let tenantsDir = '';
let backupDir = '';
let timer = null;

export function initBackup({ database, platformDbPath, tenantsDirectory, dataDir }) {
  db = database;
  dbPath = platformDbPath;
  tenantsDir = tenantsDirectory;
  backupDir = env('BACKUP_DIR') || path.join(dataDir ?? path.dirname(platformDbPath), 'backups');
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      file_name TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      databases INTEGER NOT NULL DEFAULT 0,
      encrypted INTEGER NOT NULL DEFAULT 0,
      remote_status TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs(started_at);
  `);
  try { fs.mkdirSync(backupDir, { recursive: true }); } catch {}
  return db;
}

function encryptionKey() {
  if (!ENC_KEY_HEX) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(ENC_KEY_HEX)) {
    console.warn('[backup] BACKUP_ENCRYPTION_KEY must be 64 hex chars — writing plaintext backups');
    return null;
  }
  return Buffer.from(ENC_KEY_HEX, 'hex');
}

// --- Archive format -------------------------------------------------------
//
// A minimal container so a restore needs nothing but Node: a JSON header of
// {name, length} entries, then the raw member bytes back to back.

function packArchive(members) {
  const index = members.map((m) => ({ name: m.name, length: m.data.length }));
  const header = Buffer.from(JSON.stringify({ version: 1, createdAt: new Date().toISOString(), index }), 'utf8');
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32BE(header.length, 0);
  return Buffer.concat([Buffer.from('AIWBK1'), headerLen, header, ...members.map((m) => m.data)]);
}

export function unpackArchive(buf) {
  if (buf.subarray(0, 6).toString() !== 'AIWBK1') throw new Error('not_an_aiworkers_archive');
  const headerLen = buf.readUInt32BE(6);
  const header = JSON.parse(buf.subarray(10, 10 + headerLen).toString('utf8'));
  let offset = 10 + headerLen;
  const members = [];
  for (const entry of header.index) {
    members.push({ name: entry.name, data: buf.subarray(offset, offset + entry.length) });
    offset += entry.length;
  }
  return { header, members };
}

// --- Snapshot -------------------------------------------------------------

/**
 * VACUUM INTO gives a consistent copy of a live SQLite database without
 * stopping writes — copying the file directly can capture a torn page mid-txn.
 */
function snapshotDatabase(sourcePath, tmpPath) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
    source.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
  } finally {
    try { source.close(); } catch {}
  }
  return fs.readFileSync(tmpPath);
}

function listTenantDbs() {
  const out = [];
  if (!tenantsDir || !fs.existsSync(tenantsDir)) return out;
  for (const tid of fs.readdirSync(tenantsDir)) {
    const p = path.join(tenantsDir, tid, 'workers.db');
    try {
      if (fs.existsSync(p) && fs.statSync(path.join(tenantsDir, tid)).isDirectory()) {
        out.push({ tenantId: tid, path: p });
      }
    } catch {}
  }
  return out;
}

export async function runBackup({ force = false } = {}) {
  if (!db) return { ok: false, error: 'backup_not_initialised' };
  if (!ENABLED && !force) return { ok: false, skipped: 'disabled' };

  const id = `bk_${crypto.randomBytes(8).toString('hex')}`;
  const startedAt = new Date().toISOString();
  db.prepare(`INSERT INTO backup_runs (id, started_at, status) VALUES (?,?,'running')`).run(id, startedAt);

  const stamp = startedAt.replace(/[:.]/g, '-');
  const tmpDir = path.join(backupDir, `.tmp-${id}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const members = [];

    if (fs.existsSync(dbPath)) {
      members.push({ name: 'platform/earnings.db', data: snapshotDatabase(dbPath, path.join(tmpDir, 'platform.db')) });
    }
    for (const t of listTenantDbs()) {
      members.push({
        name: `tenants/${t.tenantId}/workers.db`,
        data: snapshotDatabase(t.path, path.join(tmpDir, `${t.tenantId}.db`)),
      });
    }
    if (!members.length) throw new Error('nothing_to_back_up');

    const archive = packArchive(members);
    const gz = zlib.gzipSync(archive, { level: 9 });

    const key = encryptionKey();
    let payload = gz;
    let ext = 'aiwbk.gz';
    if (key) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(gz), cipher.final()]);
      // iv | authTag | ciphertext — self-describing for the restore path.
      payload = Buffer.concat([iv, cipher.getAuthTag(), enc]);
      ext = 'aiwbk.gz.enc';
    }

    const fileName = `backup-${stamp}.${ext}`;
    const filePath = path.join(backupDir, fileName);
    fs.writeFileSync(filePath, payload);

    let remoteStatus = 'not_configured';
    if (s3Configured()) {
      const up = await uploadToS3(fileName, payload);
      remoteStatus = up.ok ? 'uploaded' : `failed: ${up.error}`;
      // A local-only backup does not survive the failure it exists for.
      if (!up.ok) console.warn(`[backup] off-site upload failed: ${up.error}`);
    }

    pruneLocal();
    db.prepare(`UPDATE backup_runs SET finished_at=?, status='ok', file_name=?, size_bytes=?, databases=?, encrypted=?, remote_status=? WHERE id=?`)
      .run(new Date().toISOString(), fileName, payload.length, members.length, key ? 1 : 0, remoteStatus, id);

    return {
      ok: true, id, fileName, sizeBytes: payload.length,
      databases: members.length, encrypted: !!key, remoteStatus,
    };
  } catch (e) {
    const error = e?.message ?? String(e);
    db.prepare(`UPDATE backup_runs SET finished_at=?, status='failed', error=? WHERE id=?`)
      .run(new Date().toISOString(), error.slice(0, 500), id);
    return { ok: false, error };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function pruneLocal() {
  try {
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith('backup-'))
      .sort()
      .reverse();
    for (const f of files.slice(KEEP_LOCAL)) {
      try { fs.rmSync(path.join(backupDir, f), { force: true }); } catch {}
    }
  } catch {}
}

// --- Restore --------------------------------------------------------------

/**
 * Decrypt + decompress an archive and write its databases under `targetDir`.
 * Never writes over a live path by default — restore into a staging directory,
 * verify, then swap.
 */
export function restoreBackup(filePath, targetDir) {
  let buf = fs.readFileSync(filePath);
  if (filePath.endsWith('.enc')) {
    const key = encryptionKey();
    if (!key) throw new Error('BACKUP_ENCRYPTION_KEY required to restore this archive');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    buf = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  }
  const archive = unpackArchive(zlib.gunzipSync(buf));
  const written = [];
  for (const m of archive.members) {
    // Reject traversal in member names before joining them onto a real path.
    if (m.name.includes('..') || path.isAbsolute(m.name)) throw new Error(`unsafe_member: ${m.name}`);
    const out = path.join(targetDir, m.name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, m.data);
    written.push({ name: m.name, bytes: m.data.length });
  }
  return { ok: true, createdAt: archive.header.createdAt, written };
}

/** Prove the newest archive is readable — an untested backup is a guess. */
export function verifyLatestBackup() {
  try {
    const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('backup-')).sort().reverse();
    if (!files.length) return { ok: false, error: 'no_backups' };
    const filePath = path.join(backupDir, files[0]);
    let buf = fs.readFileSync(filePath);
    if (filePath.endsWith('.enc')) {
      const key = encryptionKey();
      if (!key) return { ok: false, error: 'encryption_key_missing' };
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      buf = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    }
    const archive = unpackArchive(zlib.gunzipSync(buf));
    return { ok: true, file: files[0], members: archive.members.length, createdAt: archive.header.createdAt };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// --- S3-compatible upload (SigV4, no SDK) ---------------------------------

function s3Configured() {
  return !!(env('BACKUP_S3_BUCKET') && env('BACKUP_S3_ACCESS_KEY_ID') && env('BACKUP_S3_SECRET_ACCESS_KEY'));
}

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

async function uploadToS3(fileName, body) {
  const bucket = env('BACKUP_S3_BUCKET');
  const region = env('BACKUP_S3_REGION', 'auto');
  const accessKey = env('BACKUP_S3_ACCESS_KEY_ID');
  const secretKey = env('BACKUP_S3_SECRET_ACCESS_KEY');
  const prefix = env('BACKUP_S3_PREFIX', 'ai-workers').replace(/^\/+|\/+$/g, '');
  const endpoint = env('BACKUP_S3_ENDPOINT') || `https://s3.${region}.amazonaws.com`;

  const objectKey = `${prefix ? `${prefix}/` : ''}${fileName}`;
  let host;
  let urlPath;
  try {
    const base = new URL(endpoint);
    host = base.host;
    // Path-style addressing works on R2, B2 and MinIO as well as AWS.
    urlPath = `${base.pathname.replace(/\/$/, '')}/${bucket}/${objectKey}`;
  } catch {
    return { ok: false, error: 'invalid_endpoint' };
  }

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    urlPath.split('/').map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/'),
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  try {
    const r = await fetch(`${new URL(endpoint).origin}${urlPath}`, {
      method: 'PUT',
      headers: {
        host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        'content-type': 'application/octet-stream',
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (r.ok) return { ok: true, key: objectKey };
    return { ok: false, error: `s3_http_${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// --- Status + scheduler ---------------------------------------------------

export function backupStatus() {
  const cfg = {
    enabled: ENABLED,
    dir: backupDir,
    keepLocal: KEEP_LOCAL,
    encrypted: !!encryptionKey(),
    offsite: s3Configured() ? 'configured' : 'not_configured',
    runHour: RUN_HOUR,
  };
  if (!db) return { ...cfg, lastRun: null };
  const lastRun = db.prepare(`SELECT id, started_at AS startedAt, finished_at AS finishedAt, status,
    file_name AS fileName, size_bytes AS sizeBytes, databases, encrypted, remote_status AS remoteStatus, error
    FROM backup_runs ORDER BY started_at DESC LIMIT 1`).get() ?? null;
  let localCount = 0;
  try { localCount = fs.readdirSync(backupDir).filter((f) => f.startsWith('backup-')).length; } catch {}
  // Surface the two states that mean "you are not actually protected".
  const stale = !lastRun?.finishedAt || (Date.now() - new Date(lastRun.startedAt).getTime() > 36 * 3600_000);
  return {
    ...cfg,
    lastRun,
    localCount,
    healthy: !!lastRun && lastRun.status === 'ok' && !stale,
    warnings: [
      !s3Configured() ? 'off-site backup not configured — a volume loss still loses everything' : null,
      !encryptionKey() ? 'backups are unencrypted' : null,
      stale ? 'no successful backup in the last 36 hours' : null,
    ].filter(Boolean),
  };
}

export function startBackupScheduler() {
  if (!ENABLED || timer) return { started: false };
  const tick = async () => {
    try {
      if (new Date().getHours() < RUN_HOUR) return;
      const today = new Date().toISOString().slice(0, 10);
      const already = db?.prepare(`SELECT 1 FROM backup_runs WHERE status='ok' AND started_at >= ?`).get(`${today}T00:00:00.000Z`);
      if (already) return;
      await runBackup();
    } catch (e) {
      console.warn('[backup] scheduled run failed:', e?.message ?? e);
    }
  };
  timer = setInterval(tick, 60 * 60_000);
  timer.unref?.();
  setTimeout(tick, 60_000).unref?.();
  return { started: true, runHour: RUN_HOUR };
}

export function stopBackupScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
