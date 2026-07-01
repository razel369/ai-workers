// Browser regression test for the rendered buy -> activate -> chat flow.

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:8765';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token';
let failures = 0;
const ok = (l) => console.log(`OK    ${l}`);
const fail = (l, d) => { failures++; console.log(`FAIL  ${l}${d ? ' \u2014 ' + d : ''}`); };
const expect = (l, c, d) => c ? ok(l) : fail(l, d);
const adminAuth = { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' };

async function req(path, init = {}) {
  const r = await fetch(BASE + path, init);
  const ct = r.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await r.json() : await r.text();
  return { status: r.status, body, headers: r.headers };
}

console.log(`Browser flow tests against ${BASE}\n`);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(20000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(BASE + '/marketplace#/magic', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#magic-business', { timeout: 10000 });
  await page.fill('#magic-business', 'Browser Flow Business');
  await page.click('#magic-next');
  await page.waitForSelector('.tpl-pick-btn[data-tpl="sales-leads-il"]', { timeout: 10000 });
  expect('magic wizard has no integration fields', await page.locator('#magic-connect-panel').count() === 0);
  await page.click('.tpl-pick-btn[data-tpl="sales-leads-il"]');
  await page.click('#magic-next');
  await page.waitForURL(/#\/workers\/chat\//, { timeout: 20000 });
  const workerId = new URL(page.url()).hash.split('/').pop();
  const tenantKey = await page.evaluate(() => localStorage.getItem('paid-agent.workerKey'));
  expect('magic wizard silent signup stores tenant key', !!tenantKey && tenantKey.startsWith('sk_'));
  expect('magic wizard opens chat with worker id', !!workerId?.startsWith('wk_'));

  await page.waitForSelector('#c-input', { timeout: 15000 });
  expect('demo chat composer visible before payment', await page.locator('#c-input').isVisible());
  expect('no paywall on chat screen', !(await page.locator('#pay-submit').count()));

  const magicWorker = await req('/api/workers/' + workerId, { headers: { authorization: 'Bearer ' + tenantKey } });
  expect('magic wizard saves business name on worker', magicWorker.body?.worker?.name?.includes('Browser Flow Business') || magicWorker.body?.worker?.knowledge?.includes('Browser Flow Business'));

  await page.fill('#c-input', 'שלום, מי אתה ומה אתה עושה?');
  await page.click('#c-send');
  await page.waitForFunction(
    () => {
      const nodes = document.querySelectorAll('.msg.assistant');
      return nodes.length > 0 && nodes[nodes.length - 1].textContent.trim().length > 10;
    },
    null,
    { timeout: 20000 },
  );
  const demoReply = await page.locator('.msg.assistant').last().innerText();
  expect('demo chat returns assistant reply', demoReply.length > 10);

  await page.goto(BASE + '/marketplace#/workers/activate/' + workerId, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pay-contact', { timeout: 15000 });
  expect('activation paywall visible when user opts in', await page.locator('#pay-submit').isVisible());

  const act = await req('/api/workers/' + workerId + '/activation-request', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tenantKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: 'paypal',
      reference: 'BROWSER-PAID',
      contact: 'buyer@example.com',
      note: 'Browser flow payment proof',
    }),
  });
  const requestId = act.body?.requestId;
  expect('activation request id returned', act.status === 200 && typeof requestId === 'string' && requestId.startsWith('act_'));

  const account = await req('/api/account', { headers: { authorization: 'Bearer ' + tenantKey } });
  expect('account endpoint returns tenant id', account.status === 200 && !!account.body?.tenantId);
  const tenantId = account.body.tenantId;
  const paid = await req('/api/admin/mark-worker-paid', {
    method: 'POST',
    headers: adminAuth,
    body: JSON.stringify({ workerId, tenantId, days: 30, paymentChannel: 'browser-test', paymentReference: 'BROWSER-PAID', activationRequestId: requestId }),
  });
  expect('admin mark-paid -> ok', paid.status === 200 && paid.body?.ok === true);

  let workerActive = false;
  const activeDeadline = Date.now() + 15000;
  while (Date.now() < activeDeadline) {
    const w = await req('/api/workers/' + workerId, { headers: { authorization: 'Bearer ' + tenantKey } });
    if (w.body?.worker?.isActive) { workerActive = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  expect('worker active after mark-paid', workerActive);

  await page.goto(BASE + '/marketplace#/workers/chat/' + workerId, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('#c-input') && !document.querySelector('#pay-submit'),
    null,
    { timeout: 20000 },
  );
  expect('paid chat composer is visible', await page.locator('#c-input').isVisible());

  await page.fill('#c-input', 'שלום, מי אתה ומה אתה עושה?');
  await page.click('#c-send');
  await page.waitForFunction(
    () => {
      const nodes = document.querySelectorAll('.msg.assistant');
      return nodes.length > 0 && nodes[nodes.length - 1].textContent.trim().length > 20;
    },
    null,
    { timeout: 20000 },
  );
  const reply = await page.locator('.msg.assistant').last().innerText();
  expect('chat returns assistant reply', reply.length > 20);
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} BROWSER FLOW FAILURE(S)` : '\nBROWSER FLOW TESTS PASSED');
process.exit(failures ? 1 : 0);
