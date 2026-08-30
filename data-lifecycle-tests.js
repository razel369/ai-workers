import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workers-lifecycle-'));
process.env.DATA_DIR = root;
process.env.TENANTS_DIR = path.join(root, 'tenants');
process.env.CUSTOMER_DATA_RETENTION_DAYS = '180';
process.env.BACKUP_ENCRYPTION_SECRET = 'encryption-secret-0123456789abcdef-AAAA';
process.env.BACKUP_MANIFEST_SECRET = 'manifest-secret-0123456789abcdef-BBBB';

const workers = await import(`./workers.js?data-lifecycle=${Date.now()}`);
const { createManifest, verifyManifest } = await import(`./deploy/oci/backup-manifest.mjs?data-lifecycle=${Date.now()}`);

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`OK    ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name} — ${error?.stack || error}`);
  }
}

await test('worker deletion removes only precisely owned media records and files', () => {
  const tenantId = 'ten_media_lifecycle';
  const first = workers.buyTemplate({ tenantId, templateId: 'support-he' });
  const second = workers.buyTemplate({ tenantId, templateId: 'data-entry' });
  const db = workers._internals.getTenantDb(tenantId);
  const firstName = 'med_1111111111111111.png';
  const secondName = 'med_2222222222222222.png';
  // resolveMediaFile initializes/migrates the ownership tables; unowned bytes
  // remain private until an exact worker record exists.
  assert.equal(workers.resolveMediaFile(tenantId, firstName), null);
  const mediaDir = path.join(process.env.TENANTS_DIR, tenantId, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, firstName), 'first', { mode: 0o600 });
  fs.writeFileSync(path.join(mediaDir, secondName), 'second', { mode: 0o600 });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO media_assets
    (id, tenant_id, worker_id, filename, kind, mime_type, created_at)
    VALUES (?, ?, ?, ?, 'image', 'image/png', ?), (?, ?, ?, ?, 'image', 'image/png', ?)`)
    .run('med_1111111111111111', tenantId, first.workerId, firstName, now,
      'med_2222222222222222', tenantId, second.workerId, secondName, now);
  db.prepare(`INSERT INTO media_jobs
    (id, tenant_id, worker_id, kind, status, operation_name, result_path, prompt, created_at, updated_at)
    VALUES ('job_first', ?, ?, 'video', 'done', 'mock:first', ?, 'first', ?, ?),
           ('job_second', ?, ?, 'video', 'done', 'mock:second', ?, 'second', ?, ?)`)
    .run(tenantId, first.workerId, `https://workers.test/api/media/public/${tenantId}/${firstName}`, now, now,
      tenantId, second.workerId, `https://workers.test/api/media/public/${tenantId}/${secondName}`, now, now);

  assert.equal(workers.deleteWorker(tenantId, first.workerId), true);
  assert.equal(fs.existsSync(path.join(mediaDir, firstName)), false);
  assert.equal(workers.resolveMediaFile(tenantId, firstName), null);
  assert.equal(fs.existsSync(path.join(mediaDir, secondName)), true);
  assert.equal(workers.resolveMediaFile(tenantId, secondName), fs.realpathSync(path.join(mediaDir, secondName)));
  assert.equal(db.prepare(`SELECT count(*) AS count FROM media_assets WHERE worker_id = ?`).get(first.workerId).count, 0);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM media_assets WHERE worker_id = ?`).get(second.workerId).count, 1);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM media_jobs WHERE worker_id = ?`).get(first.workerId).count, 0);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM media_jobs WHERE worker_id = ?`).get(second.workerId).count, 1);
  assert.ok(workers.getWorker(tenantId, second.workerId));
});

await test('fake-time sweep catches up cached and inactive tenant databases', () => {
  const cachedTenant = 'ten_retention_cached';
  const inactiveTenant = 'ten_retention_inactive';
  const cachedWorker = workers.buyTemplate({ tenantId: cachedTenant, templateId: 'support-he' });
  const inactiveWorker = workers.buyTemplate({ tenantId: inactiveTenant, templateId: 'support-he' });
  const cachedDb = workers._internals.getTenantDb(cachedTenant);
  const inactiveDb = workers._internals.getTenantDb(inactiveTenant);
  for (const [db, workerId] of [[cachedDb, cachedWorker.workerId], [inactiveDb, inactiveWorker.workerId]]) {
    db.prepare(`INSERT INTO messages (worker_id, customer_id, role, content, created_at)
      VALUES (?, 'old', 'user', 'old', '2030-01-01T00:00:00.000Z'),
             (?, 'recent', 'user', 'recent', '2039-12-01T00:00:00.000Z')`).run(workerId, workerId);
  }
  workers._internals.closeTenantDb(inactiveTenant);
  assert.equal(workers._internals.isTenantDbCached(cachedTenant), true);
  assert.equal(workers._internals.isTenantDbCached(inactiveTenant), false);

  const fakeNow = new Date('2040-01-01T00:00:00.000Z');
  const sweep = workers.runTenantRetentionSweep({
    tenantIds: [cachedTenant, inactiveTenant, 'ten_registered_empty'],
    now: fakeNow,
  });
  assert.equal(sweep.ok, true);
  assert.equal(sweep.tenantCount >= 3, true);
  assert.equal(cachedDb.prepare(`SELECT count(*) AS count FROM messages WHERE customer_id='old'`).get().count, 0);
  assert.equal(cachedDb.prepare(`SELECT count(*) AS count FROM messages WHERE customer_id='recent'`).get().count, 1);
  assert.equal(workers._internals.isTenantDbCached(inactiveTenant), false);
  const reopenedInactive = workers._internals.getTenantDb(inactiveTenant);
  assert.equal(reopenedInactive.prepare(`SELECT count(*) AS count FROM messages WHERE customer_id='old'`).get().count, 0);
  assert.equal(reopenedInactive.prepare(`SELECT count(*) AS count FROM messages WHERE customer_id='recent'`).get().count, 1);
  workers._internals.closeTenantDb(inactiveTenant);

  cachedDb.prepare(`INSERT INTO messages (worker_id, customer_id, role, content, created_at)
    VALUES (?, 'second_old', 'user', 'old again', '2030-02-01T00:00:00.000Z')`).run(cachedWorker.workerId);
  const inactiveForInsert = workers._internals.getTenantDb(inactiveTenant);
  inactiveForInsert.prepare(`INSERT INTO messages (worker_id, customer_id, role, content, created_at)
    VALUES (?, 'second_old', 'user', 'old again', '2030-02-01T00:00:00.000Z')`).run(inactiveWorker.workerId);
  workers._internals.closeTenantDb(inactiveTenant);
  const scheduler = workers.startTenantRetentionScheduler({
    tenantIdsProvider: () => [cachedTenant, inactiveTenant],
    now: () => new Date('2041-01-01T00:00:00.000Z'),
    intervalMs: 86_400_000,
  });
  scheduler.stop();
  assert.equal(scheduler.initial.ok, true);
  assert.equal(cachedDb.prepare(`SELECT count(*) AS count FROM messages WHERE customer_id='second_old'`).get().count, 0);
  const inactiveAfterStartup = workers._internals.getTenantDb(inactiveTenant);
  assert.equal(inactiveAfterStartup.prepare(`SELECT count(*) AS count FROM messages WHERE customer_id='second_old'`).get().count, 0);
  workers._internals.closeTenantDb(inactiveTenant);
  const status = workers.getRetentionSweepStatus({ now: new Date('2041-01-01T01:00:00.000Z') });
  assert.equal(status.lastRunAt, '2041-01-01T00:00:00.000Z');
  assert.equal(status.failed, 0);
  assert.equal(status.alert.active, false);
});

await test('encrypted archive manifest is HMAC-authenticated and ciphertext-bound', () => {
  const backupDir = path.join(root, 'backup-manifest');
  fs.mkdirSync(backupDir, { recursive: true });
  const plaintext = path.join(backupDir, 'payload.tar.gz');
  const archive = path.join(backupDir, 'ai-workers-data-20410102T030405Z.tar.gz.enc');
  const manifest = `${archive}.manifest`;
  const signature = `${manifest}.hmac`;
  fs.writeFileSync(plaintext, Buffer.from('test backup plaintext\n'.repeat(100)));
  execFileSync('openssl', [
    'enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '250000',
    '-pass', 'env:BACKUP_ENCRYPTION_SECRET', '-in', plaintext, '-out', archive,
  ], { env: process.env, stdio: 'pipe' });
  createManifest({ archivePath: archive, manifestPath: manifest, signaturePath: signature, createdAt: '20410102T030405Z' });
  assert.equal(verifyManifest({ archivePath: archive, manifestPath: manifest, signaturePath: signature }).archive, path.basename(archive));

  const original = fs.readFileSync(archive);
  const tampered = Buffer.from(original);
  tampered[tampered.length - 1] ^= 0xff;
  fs.writeFileSync(archive, tampered);
  assert.throws(() => verifyManifest({ archivePath: archive, manifestPath: manifest, signaturePath: signature }), /does not match/);
  fs.writeFileSync(archive, original);
  const priorSecret = process.env.BACKUP_MANIFEST_SECRET;
  process.env.BACKUP_MANIFEST_SECRET = 'wrong-manifest-secret-0123456789-CCCC';
  assert.throws(() => verifyManifest({ archivePath: archive, manifestPath: manifest, signaturePath: signature }), /signature mismatch/);
  process.env.BACKUP_MANIFEST_SECRET = priorSecret;
});

await test('restore extractor rejects traversal, links, devices, fifos and absolute paths', () => {
  const result = spawnSync('python3', ['deploy/oci/safe-extract.py', '--self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.unsafeCasesRejected, 8);
});

await test('OCI scripts require encrypted signed rotation and non-root strict restore', () => {
  for (const script of ['deploy/oci/backup.sh', 'deploy/oci/restore-drill.sh']) {
    execFileSync('bash', ['-n', script]);
  }
  const backup = fs.readFileSync('deploy/oci/backup.sh', 'utf8');
  const restore = fs.readFileSync('deploy/oci/restore-drill.sh', 'utf8');
  assert.match(backup, /aes-256-cbc/);
  assert.match(backup, /BACKUP_MANIFEST_SECRET/);
  assert.match(backup, /remote_type.*crypt/s);
  assert.match(backup, /BACKUP_LOCAL_RETENTION_DAYS/);
  assert.match(backup, /BACKUP_REMOTE_RETENTION_DAYS/);
  assert.match(restore, /backup-manifest\.mjs.*verify/s);
  assert.match(restore, /safe-extract\.py/);
  assert.match(restore, /--user/);
  assert.doesNotMatch(restore, /tar\s+-x/);
});

for (const tenantId of ['ten_media_lifecycle', 'ten_retention_cached', 'ten_retention_inactive', 'ten_registered_empty']) {
  workers._internals.closeTenantDb(tenantId);
}
fs.rmSync(root, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} data lifecycle test(s) failed`);
  process.exit(1);
}
console.log('\nDATA LIFECYCLE TESTS PASSED');
