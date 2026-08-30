import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const restoreRoot = path.resolve(process.argv[2] || '/restore');
const platformDb = path.join(restoreRoot, 'earnings.db');
const paddleAuthorityDb = path.join(restoreRoot, 'paddle-authority.db');
const tenantsRoot = path.join(restoreRoot, 'tenants');

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

function verifySqlite(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const quick = db.prepare('PRAGMA quick_check').all();
    const values = quick.flatMap((row) => Object.values(row));
    if (values.length !== 1 || values[0] !== 'ok') {
      throw new Error(`quick_check failed: ${JSON.stringify(quick)}`);
    }
    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length) {
      throw new Error(`foreign_key_check failed: ${foreignKeyErrors.length} row(s)`);
    }
    return { bytes: fs.statSync(file).size };
  } finally {
    db.close();
  }
}

if (!fs.existsSync(platformDb) || !fs.statSync(platformDb).isFile()) {
  fail('earnings.db is missing from the restored archive');
}

const databases = [{ kind: 'platform', file: 'earnings.db', ...verifySqlite(platformDb) }];
if (fs.existsSync(paddleAuthorityDb)) {
  if (!fs.statSync(paddleAuthorityDb).isFile()) fail('paddle-authority.db is not a regular file');
  databases.push({
    kind: 'paddle-authority',
    file: 'paddle-authority.db',
    ...verifySqlite(paddleAuthorityDb),
  });
}
if (fs.existsSync(tenantsRoot)) {
  for (const entry of fs.readdirSync(tenantsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workerDb = path.join(tenantsRoot, entry.name, 'workers.db');
    if (!fs.existsSync(workerDb)) continue;
    databases.push({
      kind: 'tenant',
      tenantDirectory: entry.name,
      file: path.relative(restoreRoot, workerDb),
      ...verifySqlite(workerDb),
    });
  }
}

console.log(JSON.stringify({
  ok: true,
  restoreRoot,
  databaseCount: databases.length,
  paddleAuthorityDatabaseCount: databases.filter((item) => item.kind === 'paddle-authority').length,
  tenantDatabaseCount: databases.filter((item) => item.kind === 'tenant').length,
  databases,
}, null, 2));
