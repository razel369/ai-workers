// Self-contained test runner: starts an isolated local server, runs all suites, then shuts it down.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token';

runDockerContextSmoke();
runOciConfigSmoke();
await runLegacyMigrationSmoke();
await runReadinessSafetySmoke();
await runShopifyOAuthBoundarySmoke();
await runPaypalWebhookFailClosedSmoke();
await runLlmTrustBoundarySmoke();
await runMediaTrustBoundarySmoke();

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
    DATA_DIR: root,
    TENANTS_DIR: path.join(root, 'tenants'),
    NODE_ENV: 'test',
    TRIAL_DAYS: '0',
    REQUIRE_PERSISTENT_VOLUME: '',
    LLM_API_KEY: '',
    TRUST_PROXY_HEADERS: '',
    RATE_LIMIT_PER_MIN: String(Number(process.env.RATE_LIMIT_PER_MIN ?? 120) * 5),
    PADDLE_CLIENT_TOKEN: process.env.PADDLE_CLIENT_TOKEN ?? 'test_client_token',
    PADDLE_PRICE_ID: process.env.PADDLE_PRICE_ID ?? 'pri_test_monthly',
    PADDLE_WEBHOOK_SECRET: process.env.PADDLE_WEBHOOK_SECRET ?? 'test-paddle-webhook-secret',
    BIT_WEBHOOK_SECRET: process.env.BIT_WEBHOOK_SECRET ?? 'test-bit-webhook-secret',
    PAYPAL_WEBHOOK_SECRET: 'test-paypal-webhook-secret',
    PAYMENT_WEBHOOK_SECRET: '',
    SHOPIFY_CLIENT_ID: 'test-shopify-client-id',
    SHOPIFY_CLIENT_SECRET: 'test-shopify-client-secret',
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
  // AI eval harness runs standalone (mock mode, no server needed)
  await runSuite('eval-harness.js');
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
  if (!dockerfile.includes('DATA_DIR=/app/data')) throw new Error('Dockerfile must align DATA_DIR with the persistent disk');
  if (!dockerfile.includes('TENANTS_DIR=/app/data/tenants')) throw new Error('Dockerfile must set persistent TENANTS_DIR');
  if (!dockerfile.includes('REQUIRE_PERSISTENT_VOLUME=1')) throw new Error('Production container must fail readiness without a real data mount');
  if (!dockerfile.includes('NODE_ENV=production')) throw new Error('Production container must enable production configuration guards');
  if (!dockerfile.includes('/infra-ready" || exit 1')) throw new Error('Production container healthcheck must verify persistent infrastructure readiness');
  if (!dockerfile.includes('ARG INSTALL_TUNNEL=0')) throw new Error('Production image must skip the optional cloudflared download by default');
  if (!dockerfile.includes('ALLOW_PRIVATE_NETWORK_URLS=0')) throw new Error('Production image must keep private-network fetches disabled');
  const dockerignore = fs.readFileSync('.dockerignore', 'utf8');
  if (!/^data$/m.test(dockerignore) || !/^\.env$/m.test(dockerignore)) throw new Error('.dockerignore must exclude runtime data and local secrets');
  const productionEnv = fs.readFileSync('.env.production.example', 'utf8');
  if (!/^TRIAL_DAYS=0$/m.test(productionEnv)) throw new Error('Production template must not enable a trial without an owner decision');
  const mediaTools = fs.readFileSync('media-tools.js', 'utf8');
  if (!mediaTools.includes('process.env.RENDER_EXTERNAL_URL')) throw new Error('Generated media URLs must use Render\'s external URL fallback');
  if (!mediaTools.includes('fetchPublicHttpContent') || /fetch\s*\(\s*args\.imageUrl/.test(mediaTools)) {
    throw new Error('Reference images must use the SSRF-safe bounded public fetch helper');
  }
  const workersSource = fs.readFileSync('workers.js', 'utf8');
  if ((workersSource.match(/body\.tools = formattedTools/g) || []).length !== 2) {
    throw new Error('Both Anthropic and OpenAI-compatible requests must use provider-formatted tool schemas');
  }
  console.log('OK    Dockerfile copies runtime modules and uses persistent data paths');
}

function runOciConfigSmoke() {
  console.log('--- oci-config-smoke ---');
  if (fs.existsSync('render.yaml')) throw new Error('Paid Render Blueprint must stay removed from the zero-cost deployment branch');
  const compose = fs.readFileSync('compose.oci.yaml', 'utf8');
  const appBlock = compose.match(/^  app:\n([\s\S]*?)^  caddy:/m)?.[1] ?? '';
  const caddyBlock = compose.match(/^  caddy:\n([\s\S]*?)^volumes:/m)?.[1] ?? '';
  const requiredAppSettings = [
    'INSTALL_TUNNEL: "0"',
    'PUBLIC_BASE_URL: "https://${AI_WORKERS_DOMAIN:',
    'REQUIRE_PERSISTENT_VOLUME: "1"',
    'TRUST_PROXY_HEADERS: "1"',
    'ALLOW_PRIVATE_NETWORK_URLS: "0"',
    'PAYMENT_AUTO_VERIFY: "0"',
    'TRIAL_DAYS: "0"',
    'EMBED_ALLOW_PUBLIC: "0"',
    './data:/app/data',
  ];
  const missing = requiredAppSettings.filter((entry) => !appBlock.includes(entry));
  if (missing.length) throw new Error(`OCI app service missing safe setting(s): ${missing.join(', ')}`);
  if (/^\s+ports:/m.test(appBlock)) throw new Error('OCI app service must not publish port 8765');
  if (!/^\s+expose:\s*\n\s+- "8765"/m.test(appBlock)) throw new Error('OCI app service must expose port 8765 only to the Compose network');
  if (!/image: caddy:\d+\.\d+\.\d+-alpine/.test(caddyBlock)) throw new Error('OCI Caddy image must use an exact stable Alpine tag');
  for (const binding of ['"80:80"', '"443:443"']) {
    if (!caddyBlock.includes(binding)) throw new Error(`OCI Caddy service missing public binding ${binding}`);
  }
  if (caddyBlock.includes('"8765:8765"')) throw new Error('OCI Caddy service must not expose the private app port');

  const caddyfile = fs.readFileSync('deploy/oci/Caddyfile', 'utf8');
  if (!caddyfile.includes('{$AI_WORKERS_DOMAIN}') || !caddyfile.includes('reverse_proxy app:8765')) {
    throw new Error('OCI Caddyfile must terminate the configured hostname and proxy only to the private app service');
  }
  if (/caddy:[\s\S]*?env_file:/m.test(compose)) throw new Error('OCI Caddy service must not receive the app secret environment file');
  if (/^\s*log\s*\{/m.test(caddyfile)) throw new Error('OCI Caddy access logs must stay off unless OAuth query strings are explicitly redacted');

  const envTemplate = fs.readFileSync('.env.oci.example', 'utf8');
  for (const safeDefault of ['TRIAL_DAYS=0', 'PAYMENT_AUTO_VERIFY=0', 'EMBED_ALLOW_PUBLIC=0', 'ALLOW_PRIVATE_NETWORK_URLS=0']) {
    if (!new RegExp(`^${safeDefault}$`, 'm').test(envTemplate)) throw new Error(`OCI env template missing ${safeDefault}`);
  }
  for (const requiredPlaceholder of ['AI_WORKERS_DOMAIN=REPLACE_ME', 'LLM_API_KEY=REPLACE_ME', 'ADMIN_TOKEN=REPLACE_ME', 'INTEGRATIONS_SECRET=REPLACE_ME']) {
    if (!envTemplate.includes(requiredPlaceholder)) throw new Error(`OCI env template must fail visibly with ${requiredPlaceholder}`);
  }

  const deployScript = fs.readFileSync('deploy/oci/deploy.sh', 'utf8');
  const placeholderGuard = deployScript.indexOf("/REPLACE_ME/p");
  const domainGuard = deployScript.indexOf('AI_WORKERS_DOMAIN must be a plain public hostname');
  const composeStart = deployScript.indexOf(' up -d --build');
  if (placeholderGuard < 0 || domainGuard < 0 || composeStart < 0 || placeholderGuard > composeStart || domainGuard > composeStart) {
    throw new Error('OCI deploy script must reject placeholders and malformed hostnames before starting containers');
  }
  const bootstrap = fs.readFileSync('deploy/oci/bootstrap.sh', 'utf8');
  if (/docker compose[^\n]* up /.test(bootstrap)) throw new Error('OCI bootstrap must not deploy before the owner configures secrets');
  if (!bootstrap.includes('$(uname -m)') || !bootstrap.includes('aarch64') || !bootstrap.includes('VERSION_ID:-') || !bootstrap.includes('24.04')) {
    throw new Error('OCI bootstrap must reject the wrong architecture or Ubuntu release before package installation');
  }
  for (const script of ['deploy/oci/bootstrap.sh', 'deploy/oci/deploy.sh', 'deploy/oci/backup.sh']) {
    if ((fs.statSync(script).mode & 0o111) === 0) throw new Error(`${script} must be executable`);
  }
  for (const ignoreFile of ['.gitignore', '.dockerignore']) {
    if (!new RegExp('^backups/?$', 'm').test(fs.readFileSync(ignoreFile, 'utf8'))) {
      throw new Error(`${ignoreFile} must exclude staged customer-data backups`);
    }
  }

  console.log('OK    OCI free-tier stack binds host data, keeps app private, proxies HTTPS, and leaves launch settings fail-closed');
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

async function runReadinessSafetySmoke() {
  console.log('--- readiness-safety-smoke ---');
  const placeholder = await runReadinessProbe({
    ADMIN_TOKEN: 'short',
    INTEGRATIONS_SECRET: 'changeme',
    LLM_API_KEY: 'sk-...',
    LLM_MODEL: 'your-model',
    BIT_PHONE: '9725XXXXXXXX',
    PAYPAL_ME: '---',
    AGENT_OWNER_CONTACT: 'support@yourdomain.com',
    EMBED_ALLOWED_ORIGINS: '',
    RENDER: '',
  });
  const rejected = ['adminEnabled', 'integrationsEncryptionConfigured', 'llmConfigured', 'paymentChannelConfigured', 'ownerContactConfigured', 'embedOriginsConfigured'];
  if (placeholder.status !== 503 || rejected.some((key) => placeholder.body.configuration?.[key] !== false)) {
    throw new Error(`Placeholder production config was not rejected: ${JSON.stringify(placeholder.body)}`);
  }
  if (placeholder.infraStatus !== 200 || placeholder.rootStatus !== 503) {
    throw new Error(`Bootstrap gate did not separate infrastructure health from customer readiness: ${JSON.stringify(placeholder)}`);
  }
  console.log('OK    /ready rejects placeholder secrets, contacts, payments, models, and empty embed origins');
  console.log('OK    /infra-ready permits bootstrap while incomplete production remains closed to customer traffic');

  const unsafeLlmEndpoint = await runReadinessProbe({
    LLM_BASE_URL: 'http://127.0.0.1:11434',
  });
  if (unsafeLlmEndpoint.status !== 503 || unsafeLlmEndpoint.body.configuration?.llmConfigured !== false) {
    throw new Error(`Unsafe operator LLM endpoint was not rejected: ${JSON.stringify(unsafeLlmEndpoint.body)}`);
  }
  console.log('OK    /ready rejects a non-public or non-HTTPS operator LLM endpoint');

  const renderWithoutDisk = await runReadinessProbe({
    RENDER: 'true',
    PUBLIC_BASE_URL: '',
    RENDER_EXTERNAL_URL: 'https://ai-workers-safety-probe.onrender.com',
  });
  if (renderWithoutDisk.status !== 503
      || renderWithoutDisk.body.configurationOk !== true
      || renderWithoutDisk.body.persistence?.required !== true
      || renderWithoutDisk.body.persistence?.mounted !== false
      || renderWithoutDisk.body.persistence?.ok !== false
      || renderWithoutDisk.infraStatus !== 503) {
    throw new Error(`Render without a mounted disk was not rejected: ${JSON.stringify(renderWithoutDisk.body)}`);
  }
  console.log('OK    RENDER=true enforces a real persistent mount even if the explicit flag is omitted');

  const unsafePrivateFetch = await runReadinessProbe({
    ALLOW_PRIVATE_NETWORK_URLS: '1',
  });
  if (unsafePrivateFetch.status !== 503
      || unsafePrivateFetch.body.configuration?.privateNetworkFetchDisabled !== false) {
    throw new Error(`Production readiness allowed private-network fetches: ${JSON.stringify(unsafePrivateFetch.body)}`);
  }
  console.log('OK    /ready rejects production config that enables private-network fetches');

  const unsafePaymentStub = await runReadinessProbe({
    PAYMENT_AUTO_VERIFY: '1',
  });
  if (unsafePaymentStub.status !== 503
      || unsafePaymentStub.body.configuration?.paymentAutoVerifyDisabled !== false) {
    throw new Error('Production readiness allowed the payment auto-verification stub');
  }
  console.log('OK    /ready rejects the development-only payment auto-verification stub');

  const sanitizedPaymentCopy = await runReadinessProbe({
    PAYPAL_ME: 'your-username',
    BIT_PHONE: '0501234567',
  });
  if (sanitizedPaymentCopy.status !== 200
      || sanitizedPaymentCopy.infraStatus !== 200
      || sanitizedPaymentCopy.rootStatus !== 200
      || !sanitizedPaymentCopy.paymentInfo.includes('0501234567')
      || !sanitizedPaymentCopy.marketplace.includes('0501234567')
      || sanitizedPaymentCopy.paymentInfo.includes('your-username')
      || sanitizedPaymentCopy.marketplace.includes('your-username')) {
    throw new Error('Payment surfaces exposed an invalid/placeholder channel or omitted the valid Bit channel');
  }
  console.log('OK    payment information shows only channels that pass the production validator');

  const punctuationOnlyPayPal = await runReadinessProbe({
    BIT_PHONE: '',
    PAYPAL_ME: '---',
  });
  if (punctuationOnlyPayPal.status !== 503
      || punctuationOnlyPayPal.body.configuration?.paymentChannelConfigured !== false) {
    throw new Error('A punctuation-only PayPal.Me slug passed the production payment gate');
  }

  const incompleteBankCopy = await runReadinessProbe({
    BIT_PHONE: '0501234567',
    PAYEE_NAME: 'Unverified Recipient',
    BANK_NAME: '',
    BANK_BRANCH: '',
    BANK_ACCOUNT: '',
    IBAN: 'UNVERIFIED-IBAN',
    SWIFT: 'UNVERIFIED-SWIFT',
  });
  if (incompleteBankCopy.status !== 200
      || incompleteBankCopy.paymentInfo.includes('Unverified Recipient')
      || incompleteBankCopy.marketplace.includes('Unverified Recipient')
      || incompleteBankCopy.paymentInfo.includes('UNVERIFIED-IBAN')
      || incompleteBankCopy.paymentInfo.includes('UNVERIFIED-SWIFT')) {
    throw new Error('Incomplete bank details leaked onto a public payment surface');
  }

  const normalizedBankCopy = await runReadinessProbe({
    BIT_PHONE: '',
    PAYEE_NAME: 'Raz Digital Services',
    BANK_NAME: 'Bank Leumi',
    BANK_BRANCH: '811',
    BANK_ACCOUNT: '98765432',
    IBAN: 'il62 abcdefghijklmno',
    SWIFT: 'poalilit',
  });
  if (normalizedBankCopy.status !== 200
      || !normalizedBankCopy.paymentInfo.includes('IL62ABCDEFGHIJKLMNO')
      || !normalizedBankCopy.paymentInfo.includes('POALILIT')) {
    throw new Error('Validated bank details were not normalized on the payment information surface');
  }

  const invalidOptionalBankCopy = await runReadinessProbe({
    BIT_PHONE: '',
    PAYEE_NAME: 'Raz Digital Services',
    BANK_NAME: 'Bank Leumi',
    BANK_BRANCH: '811',
    BANK_ACCOUNT: '98765432',
    IBAN: 'IL00BAD',
    SWIFT: 'SHORT',
  });
  if (invalidOptionalBankCopy.status !== 200
      || invalidOptionalBankCopy.paymentInfo.includes('IL00BAD')
      || invalidOptionalBankCopy.paymentInfo.includes('SWIFT/BIC:  SHORT')) {
    throw new Error('Invalid optional IBAN/SWIFT details leaked onto the payment information surface');
  }
  console.log('OK    incomplete bank records stay hidden; valid IBAN/SWIFT values are normalized and invalid optional values are omitted');
}

async function runReadinessProbe(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workers-readiness-'));
  const probePort = await getFreePort();
  const probeBase = `http://localhost:${probePort}`;
  const probeEnv = {
    ...process.env,
    PORT: String(probePort),
    PUBLIC_BASE_URL: 'https://ai-workers-safety-probe.onrender.com',
    ADMIN_TOKEN: 'a'.repeat(32),
    INTEGRATIONS_SECRET: 'b'.repeat(32),
    LLM_API_KEY: 'unit-production-key-1234567890',
    LLM_PROVIDER: 'openai_compatible',
    LLM_MODEL: 'unit-model',
    LLM_BASE_URL: '',
    BIT_PHONE: '972501234567',
    PAYPAL_ME: '',
    PAYEE_NAME: '',
    BANK_NAME: '',
    BANK_BRANCH: '',
    BANK_ACCOUNT: '',
    IBAN: '',
    SWIFT: '',
    PADDLE_API_KEY: '',
    PADDLE_CLIENT_TOKEN: '',
    PADDLE_PRICE_ID: '',
    PADDLE_WEBHOOK_SECRET: '',
    AGENT_OWNER_CONTACT: 'owner@business.co.il',
    EMBED_ALLOW_PUBLIC: '1',
    EMBED_ALLOWED_ORIGINS: 'https://customer.co.il',
    NODE_ENV: 'production',
    DATA_DIR: root,
    DB_PATH: path.join(root, 'earnings.db'),
    TENANTS_DIR: path.join(root, 'tenants'),
    REQUIRE_PERSISTENT_VOLUME: '',
    ALLOW_PRIVATE_NETWORK_URLS: '',
    PAYMENT_AUTO_VERIFY: '0',
    TRUST_PROXY_HEADERS: '',
    RENDER: '',
    ...overrides,
  };
  const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', 'server.js'], {
    env: probeEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let exited = false;
  child.stdout.on('data', (buf) => { logs += buf; });
  child.stderr.on('data', (buf) => { logs += buf; });
  child.on('exit', () => { exited = true; });
  try {
    await waitForHealth(probeBase);
    const infraResponse = await fetch(probeBase + '/infra-ready');
    const response = await fetch(probeBase + '/ready');
    const body = await response.json();
    const rootStatus = await fetch(probeBase + '/').then((result) => result.status);
    const paymentInfo = await fetch(probeBase + '/invoice').then((result) => result.text());
    const marketplace = await fetch(probeBase + '/marketplace').then((result) => result.text());
    return { status: response.status, infraStatus: infraResponse.status, rootStatus, body, paymentInfo, marketplace };
  } catch (err) {
    throw new Error(`Readiness probe failed: ${err.message}\n${logs.trim()}`);
  } finally {
    if (!exited) {
      child.kill('SIGINT');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runShopifyOAuthBoundarySmoke() {
  console.log('--- shopify-oauth-boundary-smoke ---');
  const previousEnv = {
    SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET,
    SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY,
    SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET,
    INTEGRATIONS_SECRET: process.env.INTEGRATIONS_SECRET,
  };
  process.env.SHOPIFY_CLIENT_ID = 'operator-shopify-client-id';
  process.env.SHOPIFY_CLIENT_SECRET = 'operator-shopify-client-secret';
  process.env.SHOPIFY_API_KEY = '';
  process.env.SHOPIFY_API_SECRET = '';
  process.env.INTEGRATIONS_SECRET = 'shopify-boundary-integration-secret';

  const mainDb = new DatabaseSync(':memory:');
  const tenantDbs = new Map();
  const getTenantDb = (tenantId) => {
    if (!tenantDbs.has(tenantId)) tenantDbs.set(tenantId, new DatabaseSync(':memory:'));
    return tenantDbs.get(tenantId);
  };
  const originalFetch = globalThis.fetch;
  const outbound = [];

  try {
    const oauth = await import('./integrations/oauth.js');
    const store = await import('./integrations/store.js');
    const { normalizeShopifyShopHost } = await import('./integrations/registry.js');
    store.initIntegrationStore({ getTenantDb, newId: (prefix) => `${prefix}_shopify_boundary` });
    oauth.initOAuth({ db: mainDb, publicBaseUrl: 'https://platform.example', newId: (prefix) => `${prefix}_shopify_boundary` });

    if (normalizeShopifyShopHost(' HTTPS://Demo-Store.MyShopify.com/ ') !== 'demo-store.myshopify.com') {
      throw new Error('Valid Shopify host was not normalized');
    }
    const invalidHosts = [
      'attacker.example',
      'store.myshopify.com.attacker.example',
      'store.myshopify.com@attacker.example',
      'store.myshopify.com:444',
      'store.myshopify.com/admin/oauth',
      'myshopify.com',
      'nested.store.myshopify.com',
      'javascript://store.myshopify.com',
    ];
    for (const shop of invalidHosts) {
      if (normalizeShopifyShopHost(shop)) throw new Error(`Malformed/custom Shopify host was accepted: ${shop}`);
    }

    const manualRejected = oauth.connectWithUserFields('ten_shopify_manual', 'shopify', {
      shopDomain: 'attacker.example',
      accessToken: 'tenant-token',
    });
    if (manualRejected.ok || manualRejected.error !== 'invalid_shop_domain') {
      throw new Error(`Direct Shopify connect accepted a custom host: ${JSON.stringify(manualRejected)}`);
    }
    const manualConnected = oauth.connectWithUserFields('ten_shopify_manual', 'shopify', {
      shopDomain: 'HTTPS://Manual-Store.MyShopify.com/',
      accessToken: 'tenant-token',
    });
    if (!manualConnected.ok) throw new Error(`Normalized direct Shopify connect failed: ${JSON.stringify(manualConnected)}`);
    const manualConfig = store.getIntegrationSecrets('ten_shopify_manual', manualConnected.id)?.config;
    if (manualConfig?.shopDomain !== 'manual-store.myshopify.com') {
      throw new Error(`Direct Shopify connect did not persist the canonical host: ${JSON.stringify(manualConfig)}`);
    }

    const stateCountBefore = mainDb.prepare('SELECT COUNT(*) AS count FROM oauth_states').get().count;
    for (const shop of invalidHosts) {
      const rejected = oauth.createOAuthStart('ten_shopify_start', { type: 'shopify', extra: { shop } });
      if (rejected.ok || rejected.error !== 'invalid_shop_domain') {
        throw new Error(`OAuth start accepted a malformed/custom host ${shop}: ${JSON.stringify(rejected)}`);
      }
    }
    const missing = oauth.createOAuthStart('ten_shopify_start', { type: 'shopify', extra: {} });
    if (missing.ok || missing.error !== 'shop_required') throw new Error(`OAuth start accepted a missing shop: ${JSON.stringify(missing)}`);
    const stateCountAfter = mainDb.prepare('SELECT COUNT(*) AS count FROM oauth_states').get().count;
    if (stateCountAfter !== stateCountBefore) throw new Error('Rejected Shopify OAuth start persisted an OAuth state');

    const started = oauth.createOAuthStart('ten_shopify_oauth', {
      type: 'shopify',
      returnPath: '/marketplace',
      extra: { shop: ' HTTPS://OAuth-Store.MyShopify.com/ ' },
    });
    if (!started.ok) throw new Error(`Valid Shopify OAuth start failed: ${JSON.stringify(started)}`);
    const authorizeUrl = new URL(started.redirectUrl);
    if (authorizeUrl.protocol !== 'https:'
        || authorizeUrl.hostname !== 'oauth-store.myshopify.com'
        || authorizeUrl.pathname !== '/admin/oauth/authorize') {
      throw new Error(`Shopify OAuth start escaped the canonical host: ${started.redirectUrl}`);
    }
    const persisted = JSON.parse(mainDb.prepare('SELECT extra_json FROM oauth_states WHERE state = ?').get(started.state).extra_json);
    if (persisted.shop !== 'oauth-store.myshopify.com') {
      throw new Error(`OAuth state did not persist the canonical Shopify host: ${JSON.stringify(persisted)}`);
    }

    globalThis.fetch = async (url, init = {}) => {
      outbound.push({ url: String(url), body: String(init.body || ''), redirect: init.redirect });
      return new Response(JSON.stringify({ access_token: 'shopify-oauth-access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const callback = await oauth.handleOAuthCallback({ code: 'shopify-code', state: started.state });
    if (!callback.ok) throw new Error(`Valid Shopify callback failed: ${JSON.stringify(callback)}`);
    if (outbound.length !== 1 || outbound[0].url !== 'https://oauth-store.myshopify.com/admin/oauth/access_token') {
      throw new Error(`Shopify credentials were sent outside the canonical host: ${JSON.stringify(outbound)}`);
    }
    if (outbound[0].redirect !== 'error') throw new Error('Shopify credential exchange allowed redirects');
    const exchangeBody = JSON.parse(outbound[0].body);
    if (exchangeBody.client_id !== 'operator-shopify-client-id'
        || exchangeBody.client_secret !== 'operator-shopify-client-secret') {
      throw new Error(`Shopify callback did not use the expected operator credentials: ${outbound[0].body}`);
    }

    const tamperedState = 'tampered_shopify_state';
    const now = new Date();
    mainDb.prepare(`INSERT INTO oauth_states (state, tenant_id, integration_type, provider_id, return_path, extra_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      tamperedState,
      'ten_shopify_oauth',
      'shopify',
      'shopify',
      '/marketplace',
      JSON.stringify({ shop: 'attacker.example' }),
      now.toISOString(),
      new Date(now.getTime() + 60_000).toISOString(),
    );
    const outboundBeforeTamperedCallback = outbound.length;
    const tampered = await oauth.handleOAuthCallback({ code: 'attacker-code', state: tamperedState });
    if (tampered.ok || tampered.error !== 'invalid_shop_domain') {
      throw new Error(`Tampered Shopify callback was not rejected: ${JSON.stringify(tampered)}`);
    }
    if (outbound.length !== outboundBeforeTamperedCallback) {
      throw new Error('Tampered Shopify callback made an outbound credential request');
    }
    if (mainDb.prepare('SELECT 1 FROM oauth_states WHERE state = ?').get(tamperedState)) {
      throw new Error('Tampered Shopify OAuth state was not consumed');
    }
    console.log('OK    Shopify connect/start/callback normalize valid shops and reject malformed or custom hosts before credential use');
  } finally {
    globalThis.fetch = originalFetch;
    for (const db of tenantDbs.values()) db.close();
    mainDb.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runPaypalWebhookFailClosedSmoke() {
  console.log('--- paypal-webhook-fail-closed-smoke ---');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workers-paypal-boundary-'));
  const appPort = await getFreePort();
  const appBase = `http://127.0.0.1:${appPort}`;
  const appEnv = {
    ...process.env,
    PORT: String(appPort),
    PUBLIC_BASE_URL: appBase,
    ADMIN_TOKEN,
    DB_PATH: path.join(root, 'earnings.db'),
    DATA_DIR: root,
    TENANTS_DIR: path.join(root, 'tenants'),
    NODE_ENV: 'test',
    TRIAL_DAYS: '0',
    REQUIRE_PERSISTENT_VOLUME: '',
    RENDER: '',
    TRUST_PROXY_HEADERS: '',
    LLM_API_KEY: '',
    PAYPAL_WEBHOOK_SECRET: '',
    PAYMENT_WEBHOOK_SECRET: '',
  };
  const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', 'server.js'], {
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let exited = false;
  child.stdout.on('data', (buf) => { logs += buf; });
  child.stderr.on('data', (buf) => { logs += buf; });
  child.on('exit', () => { exited = true; });
  const api = async (requestPath, init = {}) => {
    const response = await fetch(appBase + requestPath, init);
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, body };
  };

  try {
    await waitForHealth(appBase);
    const issued = await api('/admin/issue-key', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'paypal-boundary', reference: 'PAYPAL-BOUNDARY', label: 'PayPal boundary tenant' }),
    });
    if (issued.status !== 200 || !issued.body.key || !issued.body.tenantId) throw new Error(`Could not issue PayPal boundary key: ${JSON.stringify(issued.body)}`);
    const tenantHeaders = { authorization: `Bearer ${issued.body.key}`, 'content-type': 'application/json' };
    const created = await api('/api/workers', {
      method: 'POST',
      headers: tenantHeaders,
      body: JSON.stringify({ templateId: 'sales-leads-il', name: 'Unpaid PayPal Worker', tools: [] }),
    });
    if (created.status !== 200 || !created.body.workerId) throw new Error(`Could not create PayPal boundary worker: ${JSON.stringify(created.body)}`);

    const forged = await api('/api/webhooks/paypal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId: created.body.workerId,
        tenantId: issued.body.tenantId,
        payment_status: 'Completed',
        txn_id: 'FORGED-NO-SECRET',
      }),
    });
    if (forged.status !== 503 || forged.body.error !== 'webhook_secret_not_configured') {
      throw new Error(`PayPal webhook without a configured secret did not fail closed: ${JSON.stringify(forged)}`);
    }
    const worker = await api(`/api/workers/${created.body.workerId}`, { headers: tenantHeaders });
    if (worker.body.worker?.isActive || worker.body.worker?.status === 'active' || worker.body.worker?.paidUntil) {
      throw new Error(`Unverified PayPal webhook activated a worker: ${JSON.stringify(worker.body.worker)}`);
    }
    console.log('OK    PayPal webhook without a verification secret returns 503 and leaves the worker unpaid');
  } catch (err) {
    throw new Error(`PayPal fail-closed smoke failed: ${err.message}\n${logs.trim()}`);
  } finally {
    if (!exited) {
      child.kill('SIGINT');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runLlmTrustBoundarySmoke() {
  console.log('--- llm-trust-boundary-smoke ---');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workers-llm-boundary-'));
  const operatorRequests = [];
  const tenantEndpointRequests = [];
  const platformSecret = 'platform-llm-secret-never-send-to-tenants';
  const operatorModel = 'operator-controlled-model';
  const captureServer = (sink) => http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      sink.push({
        url: req.url,
        authorization: req.headers.authorization || '',
        anthropicKey: req.headers['x-api-key'] || '',
        body,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'זו תשובה בטוחה מהמודל שהוגדר על ידי מפעיל הפלטפורמה.' } }],
      }));
    });
  });
  const listenCapture = async (sink) => {
    const server = captureServer(sink);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
  };
  const closeCapture = async (server) => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };

  const operator = await listenCapture(operatorRequests);
  const tenantEndpoint = await listenCapture(tenantEndpointRequests);
  const appPort = await getFreePort();
  const appBase = `http://127.0.0.1:${appPort}`;
  const appEnv = {
    ...process.env,
    PORT: String(appPort),
    PUBLIC_BASE_URL: appBase,
    ADMIN_TOKEN,
    DB_PATH: path.join(root, 'earnings.db'),
    DATA_DIR: root,
    TENANTS_DIR: path.join(root, 'tenants'),
    NODE_ENV: 'test',
    TRIAL_DAYS: '0',
    REQUIRE_PERSISTENT_VOLUME: '',
    RENDER: '',
    TRUST_PROXY_HEADERS: '',
    LLM_API_KEY: platformSecret,
    LLM_PROVIDER: 'openai_compatible',
    LLM_MODEL: operatorModel,
    LLM_BASE_URL: operator.baseUrl,
  };
  const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', 'server.js'], {
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let exited = false;
  child.stdout.on('data', (buf) => { logs += buf; });
  child.stderr.on('data', (buf) => { logs += buf; });
  child.on('exit', () => { exited = true; });

  const assertBoundary = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const api = async (requestPath, init = {}) => {
    const response = await fetch(appBase + requestPath, init);
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, body };
  };

  try {
    await waitForHealth(appBase);
    const issued = await api('/admin/issue-key', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'boundary-test', reference: 'BOUNDARY-1', label: 'LLM boundary tenant' }),
    });
    assertBoundary(issued.status === 200 && issued.body.key && issued.body.tenantId, 'Could not issue the LLM boundary tenant key');
    const tenantHeaders = { authorization: `Bearer ${issued.body.key}`, 'content-type': 'application/json' };
    const maliciousLlm = {
      provider: 'anthropic',
      model: 'tenant-controlled-model',
      baseUrl: tenantEndpoint.baseUrl,
    };

    const created = await api('/api/workers', {
      method: 'POST',
      headers: tenantHeaders,
      body: JSON.stringify({
        templateId: 'sales-leads-il',
        name: 'Boundary Worker',
        persona: 'Legitimate tenant persona from create.',
        knowledge: 'Legitimate tenant knowledge from create.',
        tasks: ['Answer safely'],
        tools: ['save_lead'],
        agentMode: 'agent',
        llm: maliciousLlm,
      }),
    });
    assertBoundary(created.status === 200 && created.body.workerId, `Create failed: ${JSON.stringify(created.body)}`);
    const workerId = created.body.workerId;
    const afterCreate = await api(`/api/workers/${workerId}`, { headers: tenantHeaders });
    assertBoundary(afterCreate.body.worker?.persona === 'Legitimate tenant persona from create.', 'Create did not preserve tenant persona');
    assertBoundary(afterCreate.body.worker?.knowledge === 'Legitimate tenant knowledge from create.', 'Create did not preserve tenant knowledge');
    assertBoundary(afterCreate.body.worker?.llm?.provider === 'openai_compatible', 'Create overrode the platform LLM provider');
    assertBoundary(afterCreate.body.worker?.llm?.model === operatorModel, 'Create overrode the platform LLM model');
    assertBoundary(afterCreate.body.worker?.llm?.baseUrl === operator.baseUrl, 'Create overrode the platform LLM base URL');

    const patched = await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      headers: tenantHeaders,
      body: JSON.stringify({
        persona: 'Legitimate tenant persona from PATCH.',
        knowledge: 'Legitimate tenant knowledge from PATCH.',
        llm: maliciousLlm,
      }),
    });
    assertBoundary(patched.status === 200, `PATCH failed: ${JSON.stringify(patched.body)}`);
    const afterPatch = await api(`/api/workers/${workerId}`, { headers: tenantHeaders });
    assertBoundary(afterPatch.body.worker?.persona === 'Legitimate tenant persona from PATCH.', 'PATCH did not preserve tenant persona');
    assertBoundary(afterPatch.body.worker?.knowledge === 'Legitimate tenant knowledge from PATCH.', 'PATCH did not preserve tenant knowledge');
    assertBoundary(afterPatch.body.worker?.llm?.provider === 'openai_compatible', 'PATCH overrode the platform LLM provider');
    assertBoundary(afterPatch.body.worker?.llm?.model === operatorModel, 'PATCH overrode the platform LLM model');
    assertBoundary(afterPatch.body.worker?.llm?.baseUrl === operator.baseUrl, 'PATCH overrode the platform LLM base URL');

    const tenantDb = new DatabaseSync(path.join(root, 'tenants', issued.body.tenantId, 'workers.db'));
    const stored = tenantDb.prepare('SELECT llm_provider AS provider, llm_model AS model, llm_base_url AS baseUrl FROM workers WHERE id = ?').get(workerId);
    tenantDb.close();
    assertBoundary(stored?.provider !== maliciousLlm.provider && stored?.model !== maliciousLlm.model && stored?.baseUrl !== maliciousLlm.baseUrl,
      `Tenant LLM routing was persisted: ${JSON.stringify(stored)}`);
    assertBoundary(operatorRequests.length === 0 && tenantEndpointRequests.length === 0, 'Create/PATCH unexpectedly called an LLM endpoint');

    const pendingTestAgent = await api(`/api/workers/${workerId}/test-agent`, {
      method: 'POST', headers: tenantHeaders, body: JSON.stringify({ message: 'בדיקת סוכן' }),
    });
    assertBoundary(pendingTestAgent.status === 200 && /^mock/.test(pendingTestAgent.body.runtime), `pending test-agent was not mock-only: ${JSON.stringify(pendingTestAgent.body)}`);

    const pendingDemoChat = await api(`/api/workers/${workerId}/chat`, {
      method: 'POST', headers: tenantHeaders, body: JSON.stringify({ message: 'בדיקת דמו', demoMode: true, customerId: 'boundary-demo' }),
    });
    assertBoundary(pendingDemoChat.status === 200 && /^mock/.test(pendingDemoChat.body.runtime), `pending demo chat was not mock-only: ${JSON.stringify(pendingDemoChat.body)}`);

    const pendingLiveChat = await api(`/api/workers/${workerId}/chat`, {
      method: 'POST', headers: tenantHeaders, body: JSON.stringify({ message: 'בדיקת צאט', customerId: 'boundary-live' }),
    });
    assertBoundary(pendingLiveChat.status === 402, `pending live chat bypassed payment: ${JSON.stringify(pendingLiveChat.body)}`);

    const publicDemoBefore = operatorRequests.length;
    const publicDemo = await api('/api/public/demo-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'support-he', message: 'בדיקת דמו ציבורי' }),
    });
    assertBoundary(publicDemo.status === 200, `public demo failed: ${JSON.stringify(publicDemo.body)}`);
    assertBoundary(operatorRequests.length === publicDemoBefore, 'Public mock demo unexpectedly used the platform LLM credential');
    assertBoundary(operatorRequests.length === 0 && tenantEndpointRequests.length === 0,
      'A pending worker used an LLM credential through create, PATCH, test-agent, demo, live chat, or public demo');

    const activation = await api(`/api/workers/${workerId}/activation-request`, {
      method: 'POST',
      headers: tenantHeaders,
      body: JSON.stringify({ channel: 'boundary-test', reference: 'BOUNDARY-PAID', contact: 'owner@boundary.test' }),
    });
    assertBoundary(activation.status === 200 && activation.body.requestId, `Activation request failed: ${JSON.stringify(activation.body)}`);
    const markedPaid = await api('/api/admin/mark-worker-paid', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId,
        tenantId: issued.body.tenantId,
        activationRequestId: activation.body.requestId,
        days: 30,
        paymentChannel: 'boundary-test',
        paymentReference: 'BOUNDARY-PAID',
      }),
    });
    assertBoundary(markedPaid.status === 200 && markedPaid.body.ok === true, `Activation failed: ${JSON.stringify(markedPaid.body)}`);

    const activeTestAgent = await api(`/api/workers/${workerId}/test-agent`, {
      method: 'POST', headers: tenantHeaders, body: JSON.stringify({ message: 'בדיקת סוכן פעיל' }),
    });
    assertBoundary(activeTestAgent.status === 200 && activeTestAgent.body.runtime === 'openai_compatible', `active test-agent failed: ${JSON.stringify(activeTestAgent.body)}`);

    const activeDemoChat = await api(`/api/workers/${workerId}/chat`, {
      method: 'POST', headers: tenantHeaders, body: JSON.stringify({ message: 'בדיקת דמו פעיל', demoMode: true, customerId: 'boundary-active-demo' }),
    });
    assertBoundary(activeDemoChat.status === 200 && activeDemoChat.body.runtime === 'openai_compatible', `active demo chat failed: ${JSON.stringify(activeDemoChat.body)}`);

    const activeLiveChat = await api(`/api/workers/${workerId}/chat`, {
      method: 'POST', headers: tenantHeaders, body: JSON.stringify({ message: 'בדיקת צאט פעיל', customerId: 'boundary-active-live' }),
    });
    assertBoundary(activeLiveChat.status === 200 && activeLiveChat.body.runtime === 'openai_compatible', `active live chat failed: ${JSON.stringify(activeLiveChat.body)}`);

    assertBoundary(tenantEndpointRequests.length === 0, 'Platform LLM credential was sent to a tenant-controlled endpoint');
    assertBoundary(operatorRequests.length === 3, `Expected three operator LLM calls, got ${operatorRequests.length}`);
    assertBoundary(operatorRequests.every((request) => request.url === '/v1/chat/completions'), 'LLM request escaped the operator-configured path');
    assertBoundary(operatorRequests.every((request) => request.authorization === `Bearer ${platformSecret}`), 'Operator endpoint did not receive the platform credential as expected');
    assertBoundary(operatorRequests.every((request) => request.body?.model === operatorModel), 'A tenant-controlled model reached the operator endpoint');
    assertBoundary(operatorRequests.every((request) => Array.isArray(request.body?.tools)
      && request.body.tools.length > 0
      && request.body.tools.every((tool) => tool.type === 'function'
        && typeof tool.function?.name === 'string'
        && tool.function?.parameters?.type === 'object')),
    'OpenAI-compatible requests did not receive provider-formatted tool schemas');
    console.log('OK    create/PATCH ignore tenant LLM routing while preserving persona and knowledge');
    console.log('OK    pending test-agent/demo are mock-only; active calls use only the operator endpoint/model with formatted tools');
  } catch (err) {
    throw new Error(`LLM trust-boundary smoke failed: ${err.message}\n${logs.trim()}`);
  } finally {
    if (!exited) {
      child.kill('SIGINT');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await closeCapture(operator.server);
    await closeCapture(tenantEndpoint.server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runMediaTrustBoundarySmoke() {
  console.log('--- media-trust-boundary-smoke ---');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workers-media-boundary-'));
  const previousGoogleKey = process.env.GOOGLE_AI_API_KEY;
  const previousAllowPrivateNetworkUrls = process.env.ALLOW_PRIVATE_NETWORK_URLS;
  const originalFetch = globalThis.fetch;
  const db = new DatabaseSync(':memory:');
  let redirectServer;
  try {
    // A configured operator key is the risky case: pending/demo workers must
    // still stay local and must never trigger a billable Google request.
    process.env.GOOGLE_AI_API_KEY = 'operator-media-key-must-not-be-used';
    globalThis.fetch = async () => { throw new Error('unexpected_external_media_request'); };

    db.exec(`CREATE TABLE outbox (
      id INTEGER PRIMARY KEY, worker_id TEXT, customer_id TEXT,
      recipient TEXT, subject TEXT, body TEXT, created_at TEXT
    )`);
    const defs = [];
    const { registerMediaTools } = await import('./media-tools.js');
    const { fetchPublicHttpContent } = await import('./url-security.js');
    registerMediaTools(defs, {
      getTenantDb: () => db,
      ensureTenantDir: (tenantId) => {
        const dir = path.join(root, tenantId);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },
      newId: (prefix) => `${prefix}_media_boundary`,
    });
    const tool = (name) => defs.find((entry) => entry.name === name);
    const pendingCtx = {
      tenantId: 'ten_media_boundary',
      workerId: 'wk_media_boundary',
      customerId: 'cus_media_boundary',
      allowPlatformMedia: false,
    };

    const image = await tool('generate_image').handler({ prompt: 'מודעת קפה לעסק ישראלי', aspectRatio: '1:1' }, pendingCtx);
    if (!image.mock || !String(image.url).startsWith('data:image/svg+xml')) {
      throw new Error(`Pending image generation escaped mock mode: ${JSON.stringify(image)}`);
    }

    const video = await tool('generate_video').handler({
      prompt: 'סרטון קצר לבית קפה',
      imageUrl: 'http://127.0.0.1/operator-only',
    }, pendingCtx);
    if (!video.mock || video.status !== 'done' || !String(video.url).startsWith('data:image/svg+xml')) {
      throw new Error(`Pending video generation escaped mock mode: ${JSON.stringify(video)}`);
    }

    const privateFetch = await fetchPublicHttpContent('http://127.0.0.1/operator-only', { responseType: 'buffer' });
    if (privateFetch.ok || privateFetch.error !== 'private_network_blocked') {
      throw new Error(`Private reference-image URL was not blocked: ${JSON.stringify(privateFetch)}`);
    }

    redirectServer = http.createServer((_req, res) => {
      res.writeHead(302, { location: 'https://127.0.0.1/reference.png' });
      res.end();
    });
    await new Promise((resolve, reject) => {
      redirectServer.once('error', reject);
      redirectServer.listen(0, '127.0.0.1', resolve);
    });
    process.env.ALLOW_PRIVATE_NETWORK_URLS = '1';
    const redirectGuardModule = await import(`./url-security.js?redirect-protocol-guard=${Date.now()}`);
    if (previousAllowPrivateNetworkUrls === undefined) delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
    else process.env.ALLOW_PRIVATE_NETWORK_URLS = previousAllowPrivateNetworkUrls;
    const redirectPort = redirectServer.address().port;
    const redirectedProtocol = await redirectGuardModule.fetchPublicHttpContent(
      `http://127.0.0.1:${redirectPort}/reference`,
      { allowedProtocols: ['http:'], responseType: 'buffer' }
    );
    if (redirectedProtocol.ok || redirectedProtocol.error !== 'protocol_not_allowed' || !String(redirectedProtocol.url).startsWith('https:')) {
      throw new Error(`Redirect escaped the per-hop protocol guard: ${JSON.stringify(redirectedProtocol)}`);
    }
    await new Promise((resolve) => redirectServer.close(resolve));
    redirectServer = undefined;

    const paidPrivateReference = await tool('generate_video').handler({
      prompt: 'סרטון עם תמונת ייחוס',
      imageUrl: 'https://127.0.0.1/operator-only',
    }, { ...pendingCtx, allowPlatformMedia: true });
    if (paidPrivateReference.error !== 'reference_image_private_network_blocked') {
      throw new Error(`Paid media accepted a private reference-image URL: ${JSON.stringify(paidPrivateReference)}`);
    }
    const paidHttpReference = await tool('generate_video').handler({
      prompt: 'סרטון עם תמונת ייחוס לא מוצפנת',
      imageUrl: 'http://8.8.8.8/reference.png',
    }, { ...pendingCtx, allowPlatformMedia: true });
    if (paidHttpReference.error !== 'unsupported_reference_image') {
      throw new Error(`Paid media accepted a non-HTTPS reference-image URL: ${JSON.stringify(paidHttpReference)}`);
    }
    const chargedUsage = db.prepare(`SELECT COALESCE(SUM(count), 0) AS count FROM media_gen_usage WHERE tenant_id = ?`).get(pendingCtx.tenantId)?.count;
    if (chargedUsage !== 0) {
      throw new Error(`Mock or rejected media consumed paid generation quota: ${chargedUsage}`);
    }

    db.prepare(`INSERT INTO media_gen_usage (tenant_id, period, count) VALUES (?, ?, ?)
      ON CONFLICT(tenant_id, period) DO UPDATE SET count = excluded.count`).run(
      pendingCtx.tenantId, image.usage.period, 1_000_000
    );
    const exhaustedQuotaReference = await tool('generate_video').handler({
      prompt: 'סרטון שלא אמור לנסות לטעון תמונת ייחוס',
      imageUrl: 'https://127.0.0.1/must-not-be-fetched',
    }, { ...pendingCtx, allowPlatformMedia: true });
    if (!String(exhaustedQuotaReference.result).includes('מגבלת יצירת מדיה') || exhaustedQuotaReference.error) {
      throw new Error(`Exhausted quota did not stop before private reference fetch: ${JSON.stringify(exhaustedQuotaReference)}`);
    }

    db.prepare(`INSERT INTO media_jobs
      (id, worker_id, kind, status, operation_name, prompt, created_at, updated_at)
      VALUES (?, ?, 'video', 'pending', ?, ?, ?, ?)`).run(
      'vidjob_external_pending', pendingCtx.workerId, 'operations/external-paid-job', 'external job',
      new Date().toISOString(), new Date().toISOString()
    );
    const blockedPoll = await tool('check_video_status').handler({ jobId: 'vidjob_external_pending' }, pendingCtx);
    if (blockedPoll.error !== 'platform_media_not_allowed' || blockedPoll.status !== 'payment_required') {
      throw new Error(`Pending worker polled an external video job: ${JSON.stringify(blockedPoll)}`);
    }

    console.log('OK    pending/demo workers use local mock media without consuming paid quota, even when the operator Google key is configured');
    console.log('OK    reference images enforce HTTPS on every redirect and exhausted quota stops before reference download');
    console.log('OK    pending video polls enforce the payment boundary');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousGoogleKey === undefined) delete process.env.GOOGLE_AI_API_KEY;
    else process.env.GOOGLE_AI_API_KEY = previousGoogleKey;
    if (previousAllowPrivateNetworkUrls === undefined) delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
    else process.env.ALLOW_PRIVATE_NETWORK_URLS = previousAllowPrivateNetworkUrls;
    if (redirectServer?.listening) await new Promise((resolve) => redirectServer.close(resolve));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
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
