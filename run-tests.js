// Self-contained test runner: starts an isolated local server, runs all suites, then shuts it down.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token';

runDockerContextSmoke();
await runLegacyMigrationSmoke();

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workers-test-'));
let port = await getFreePort();
let baseUrl = `http://localhost:${port}`;
let env = buildEnv(tmpRoot, port, baseUrl);
let server = null;
let serverExited = false;

function buildEnv(root, listenPort, publicUrl) {
  return {
    ...process.env,
    PORT: String(listenPort),
    PUBLIC_BASE_URL: publicUrl,
    ADMIN_TOKEN,
    DB_PATH: path.join(root, 'earnings.db'),
    TENANTS_DIR: path.join(root, 'tenants'),
    TRUST_PROXY_HEADERS: '',
    PADDLE_CLIENT_TOKEN: process.env.PADDLE_CLIENT_TOKEN ?? 'test_client_token',
    PADDLE_PRICE_ID: process.env.PADDLE_PRICE_ID ?? 'pri_test_monthly',
    PADDLE_WEBHOOK_SECRET: process.env.PADDLE_WEBHOOK_SECRET ?? 'test-paddle-webhook-secret',
    PADDLE_ENVIRONMENT: 'sandbox',
  };
}

function startServer() {
  serverExited = false;
  server = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', 'server.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (buf) => process.stdout.write(`[server] ${buf}`));
  server.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));
  server.on('exit', (code) => {
    serverExited = true;
    if (code !== 0 && code !== null) console.error(`Server exited with code ${code}`);
  });
}

async function stopServer() {
  if (server && !serverExited) {
    server.kill('SIGINT');
    await new Promise((resolve) => server.once('exit', resolve));
    serverExited = true;
  }
}

startServer();

try {
    await waitForHealth(baseUrl);
    await runSuite('test.js');
    await runSuite('worker-tests.js');
    await stopServer();
    const browserRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workers-browser-'));
    port = await getFreePort();
    baseUrl = `http://localhost:${port}`;
    env = buildEnv(browserRoot, port, baseUrl);
    startServer();
    await waitForHealth(baseUrl);
    await runSuite('browser-flow-test.js');
    await stopServer();
    fs.rmSync(browserRoot, { recursive: true, force: true });
  console.log('\nALL SUITES PASSED');
} finally {
  await stopServer();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function runDockerContextSmoke() {
  console.log('--- docker-context-smoke ---');
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const entryFiles = ['server.js', 'workers.js'];
  const required = new Set(entryFiles);
  for (const file of entryFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/import\s+(?:[^'"]+\s+from\s+)?['"](\.\/[^'"]+\.js)['"]/g)) {
      required.add(match[1].replace(/^\.\//, ''));
    }
  }
  const missing = [...required].filter((file) => {
    if (file.startsWith('integrations/') && /COPY\s+integrations\//m.test(dockerfile)) return false;
    return !new RegExp(`COPY\\s+[^\\n]*\\b${file.replace(/\./g, '\\.')}\\b`, 'm').test(dockerfile);
  });
  if (missing.length) throw new Error(`Dockerfile does not copy runtime file(s): ${missing.join(', ')}`);
  if (!dockerfile.includes('DB_PATH=/app/data/earnings.db')) throw new Error('Dockerfile must set persistent DB_PATH');
  if (!dockerfile.includes('TENANTS_DIR=/app/data/tenants')) throw new Error('Dockerfile must set persistent TENANTS_DIR');
  console.log('OK    Dockerfile copies runtime modules and uses persistent data paths');
}

async function runLegacyMigrationSmoke() {
  console.log('--- legacy-db-migration ---');
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workers-legacy-'));
  const dbPath = path.join(legacyRoot, 'earnings.db');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      plan TEXT NOT NULL, calls_limit INTEGER NOT NULL, calls_used INTEGER NOT NULL DEFAULT 0,
      period_start TEXT NOT NULL, period_end TEXT,
      payment_channel TEXT NOT NULL DEFAULT 'manual',
      payment_reference TEXT,
      created_at TEXT NOT NULL, revoked_at TEXT
    );
  `);
  legacyDb.close();

  const legacyPort = await getFreePort();
  const legacyBaseUrl = `http://localhost:${legacyPort}`;
  const legacyEnv = {
    ...process.env,
    PORT: String(legacyPort),
    PUBLIC_BASE_URL: legacyBaseUrl,
    ADMIN_TOKEN,
    DB_PATH: dbPath,
    TENANTS_DIR: path.join(legacyRoot, 'tenants'),
    TRUST_PROXY_HEADERS: '',
  };
  const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', 'server.js'], {
    env: legacyEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let exited = false;
  child.stdout.on('data', (buf) => { logs += buf; });
  child.stderr.on('data', (buf) => { logs += buf; });
  child.on('exit', () => { exited = true; });

  try {
    await waitForHealth(legacyBaseUrl);
    const keys = await fetch(legacyBaseUrl + '/admin/keys', {
      headers: { authorization: 'Bearer ' + ADMIN_TOKEN },
    });
    if (!keys.ok) throw new Error(`/admin/keys returned ${keys.status}`);
    console.log('OK    legacy api_keys table migrates tenant_id on startup');
  } catch (err) {
    const detail = logs.trim() || (exited ? 'server exited before producing logs' : 'no server logs');
    throw new Error(`legacy migration smoke failed: ${err.message}\n${detail}`);
  } finally {
    if (!exited) {
      child.kill('SIGINT');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  }
}

async function runSuite(file) {
  console.log(`\n--- ${file} ---`);
  const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', file], {
    env: { ...env, BASE_URL: baseUrl },
    stdio: 'inherit',
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) throw new Error(`${file} failed with code ${code}`);
}

async function waitForHealth(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url + '/health');
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Server did not become healthy in time');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
