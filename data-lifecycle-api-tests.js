import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const baseUrl = process.env.BASE_URL || 'http://localhost:8765';
const platformDbPath = process.env.DB_PATH;
const tenantsDir = process.env.TENANTS_DIR;
assert.ok(platformDbPath && tenantsDir, 'DB_PATH and TENANTS_DIR are required');

async function request(pathname, { method = 'GET', cookie = '', body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['x-aiw-csrf'] = '1';
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

const nonce = crypto.randomBytes(6).toString('hex');
const signup = await request('/api/signup', {
  method: 'POST',
  body: { businessName: `Lifecycle ${nonce}`, contact: `lifecycle-${nonce}@example.test` },
});
assert.equal(signup.status, 201, JSON.stringify(signup.body));
const cookie = String(signup.headers.get('set-cookie') ?? '').split(';', 1)[0];
assert.ok(cookie);
const tenantId = signup.body.tenantId;

async function createWorker(templateId) {
  const response = await request('/api/workers', {
    method: 'POST', cookie,
    body: { templateId },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.workerId;
}

const firstWorker = await createWorker('support-he');
const secondWorker = await createWorker('data-entry');
const tenantDbPath = path.join(tenantsDir, tenantId, 'workers.db');
const tenantDb = new DatabaseSync(tenantDbPath);
const platformDb = new DatabaseSync(platformDbPath);

try {
  tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      filename TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      worker_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      operation_name TEXT,
      result_path TEXT,
      prompt TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const mediaDir = path.join(tenantsDir, tenantId, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const firstFile = 'med_aaaaaaaaaaaaaaaa.png';
  const secondFile = 'med_bbbbbbbbbbbbbbbb.png';
  fs.writeFileSync(path.join(mediaDir, firstFile), 'first-owned-media', { mode: 0o600 });
  fs.writeFileSync(path.join(mediaDir, secondFile), 'second-owned-media', { mode: 0o600 });
  const now = new Date().toISOString();
  const insertAsset = tenantDb.prepare(`INSERT INTO media_assets
    (id, tenant_id, worker_id, filename, kind, mime_type, created_at)
    VALUES (?, ?, ?, ?, 'image', 'image/png', ?)`);
  insertAsset.run('med_aaaaaaaaaaaaaaaa', tenantId, firstWorker, firstFile, now);
  insertAsset.run('med_bbbbbbbbbbbbbbbb', tenantId, secondWorker, secondFile, now);
  const insertJob = tenantDb.prepare(`INSERT INTO media_jobs
    (id, tenant_id, worker_id, kind, status, operation_name, result_path, prompt, created_at, updated_at)
    VALUES (?, ?, ?, 'video', 'done', ?, ?, 'test', ?, ?)`);
  insertJob.run(`job_${nonce}_first`, tenantId, firstWorker, 'mock:first', `${baseUrl}/api/media/public/${tenantId}/${firstFile}`, now, now);
  insertJob.run(`job_${nonce}_second`, tenantId, secondWorker, 'mock:second', `${baseUrl}/api/media/public/${tenantId}/${secondFile}`, now, now);

  const insertEmbed = platformDb.prepare(`INSERT INTO embed_sessions
    (token_hash, tenant_id, worker_id, customer_id, origin, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, 'https://customer-site.example', ?, ?, ?)`);
  insertEmbed.run(`hash_${nonce}_first`, tenantId, firstWorker, `customer_${nonce}_first`, now, '2099-01-01T00:00:00.000Z', now);
  insertEmbed.run(`hash_${nonce}_second`, tenantId, secondWorker, `customer_${nonce}_second`, now, '2099-01-01T00:00:00.000Z', now);
  const insertRoute = platformDb.prepare(`INSERT INTO whatsapp_routes
    (phone_key, tenant_id, worker_id, provider, created_at) VALUES (?, ?, ?, 'meta', ?)`);
  insertRoute.run(`meta:${nonce}1`, tenantId, firstWorker, now);
  insertRoute.run(`meta:${nonce}2`, tenantId, secondWorker, now);
  const insertEvent = platformDb.prepare(`INSERT INTO whatsapp_events
    (message_id, provider, received_at, updated_at, status, tenant_id, worker_id, customer_id)
    VALUES (?, 'meta', ?, ?, 'done', ?, ?, ?)`);
  insertEvent.run(`meta:${nonce}-first`, now, now, tenantId, firstWorker, `wa:${nonce}1`);
  insertEvent.run(`meta:${nonce}-second`, now, now, tenantId, secondWorker, `wa:${nonce}2`);
  const insertActivation = platformDb.prepare(`INSERT INTO activation_requests
    (id, at, tenant_id, worker_id, worker_name, template_id, amount_ils, channel, contact, status)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'test', ?, 'pending')`);
  insertActivation.run(`act_${nonce}_first`, now, tenantId, firstWorker, 'First', 'support-he', signup.body.email);
  insertActivation.run(`act_${nonce}_second`, now, tenantId, secondWorker, 'Second', 'data-entry', signup.body.email);

  const firstBefore = await request(`/api/media/public/${tenantId}/${firstFile}`);
  const secondBefore = await request(`/api/media/public/${tenantId}/${secondFile}`);
  assert.equal(firstBefore.status, 200);
  assert.equal(secondBefore.status, 200);

  const deleted = await request(`/api/workers/${firstWorker}`, { method: 'DELETE', cookie, body: {} });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.deleted.embedSessions, 1);
  assert.equal(deleted.body.deleted.whatsappRoutes, 1);
  assert.equal(deleted.body.deleted.whatsappEvents, 1);
  assert.equal(deleted.body.deleted.activationRequests, 1);

  const firstAfter = await request(`/api/media/public/${tenantId}/${firstFile}`);
  const secondAfter = await request(`/api/media/public/${tenantId}/${secondFile}`);
  assert.equal(firstAfter.status, 404);
  assert.equal(secondAfter.status, 200);
  assert.equal(fs.existsSync(path.join(mediaDir, firstFile)), false);
  assert.equal(fs.existsSync(path.join(mediaDir, secondFile)), true);
  for (const table of ['embed_sessions', 'whatsapp_routes', 'whatsapp_events', 'activation_requests']) {
    assert.equal(platformDb.prepare(`SELECT count(*) AS count FROM ${table} WHERE tenant_id = ? AND worker_id = ?`).get(tenantId, firstWorker).count, 0, table);
    assert.equal(platformDb.prepare(`SELECT count(*) AS count FROM ${table} WHERE tenant_id = ? AND worker_id = ?`).get(tenantId, secondWorker).count, 1, table);
  }
  assert.ok((await request(`/api/workers/${secondWorker}`, { cookie })).body.worker);
  console.log('OK    worker delete removes only owned media, embed, WhatsApp and activation artifacts; old media URL is 404');
} finally {
  tenantDb.close();
  platformDb.close();
}
