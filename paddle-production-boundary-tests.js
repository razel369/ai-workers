import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workers-paddle-production-'));
process.env.NODE_ENV = 'production';
process.env.DATA_DIR = root;
process.env.TENANTS_DIR = path.join(root, 'tenants');
// Assemble format-valid fixtures at runtime so repository secret scanners do
// not mistake deliberately fake test data for usable Paddle credentials.
process.env.PADDLE_CLIENT_TOKEN = ['live', 'fixtureclienttoken000000000000'].join('_');
process.env.PADDLE_API_KEY = ['pdl', 'live', 'apikey', 'fixturekey000000000000000000000'].join('_');
process.env.PADDLE_WEBHOOK_SECRET = ['pdl', 'ntfset', 'fixturewebhook000000000000'].join('_');

try {
  const workers = await import(`./workers.js?paddle-production-map=${Date.now()}`);
  process.env.PADDLE_PRICE_MAP = JSON.stringify(Object.fromEntries(
    workers.TEMPLATES.map((template) => [template.id, `pri_boundary_${template.id}`])
  ));

  process.env.PADDLE_ENVIRONMENT = 'sandbox';
  const sandbox = await import(`./paddle-billing.js?production-sandbox=${Date.now()}`);
  if (!sandbox.paddlePriceMapStatus().complete) throw new Error('test price map is incomplete');
  if (sandbox.paddleProductionReady() || sandbox.paddleEnabled()) {
    throw new Error('production accepted sandbox Paddle configuration');
  }
  const direct = sandbox.processPaddleWebhookEvent({
    event_type: 'transaction.completed',
    data: { id: 'txn_sandbox_should_never_activate' },
  });
  if (direct.ok || direct.error !== 'paddle_production_not_ready') {
    throw new Error(`direct webhook processor did not fail closed: ${JSON.stringify(direct)}`);
  }
  let response = null;
  const handled = await sandbox.handlePaddleWebhook(
    { method: 'POST', headers: {} },
    {},
    new URL('https://workers.example/api/webhooks/paddle'),
    {
      send: (_res, status, body) => { response = { status, body }; },
      readBody: async () => { throw new Error('misconfigured production webhook read its body'); },
      recordAdminAudit: () => {},
    }
  );
  if (!handled || response?.status !== 503 || response?.body?.error !== 'paddle_production_not_ready') {
    throw new Error(`webhook route did not fail closed: ${JSON.stringify(response)}`);
  }
  console.log('OK    production checkout and webhook processing reject Paddle sandbox configuration');

  process.env.PADDLE_ENVIRONMENT = 'production';
  const production = await import(`./paddle-billing.js?production-live=${Date.now()}`);
  if (!production.paddleProductionReady() || !production.paddleEnabled()) {
    throw new Error('complete live Paddle configuration did not pass the production gate');
  }
  console.log('OK    complete live Paddle configuration passes the production gate');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
