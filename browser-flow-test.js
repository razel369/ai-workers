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
  await page.addInitScript(() => localStorage.setItem('paid-agent.onboardingDone', '1'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(BASE + '/marketplace', { waitUntil: 'domcontentloaded' });
  await page.click('button[data-buy="sales-leads-il"]');
  await page.waitForSelector('#signup-business', { timeout: 10000 });
  await page.fill('#signup-business', 'Browser Flow Business');
  await page.fill('#signup-contact', 'buyer@example.com');
  await page.click('#signup-create');
  await page.waitForURL(/#\/workers\/edit\//, { timeout: 10000 });
  const workerId = new URL(page.url()).hash.split('/').pop();
  const tenantKey = await page.evaluate(() => localStorage.getItem('paid-agent.workerKey'));
  expect('self-serve signup stores tenant key', !!tenantKey && tenantKey.startsWith('sk_'));
  expect('buy redirects to builder with worker id', !!workerId?.startsWith('wk_'));

  await page.waitForSelector('#f-name', { timeout: 10000 });
  await page.fill('#f-name', 'דניאל - עובד מכירות');
  await page.click('button[data-add-task="לאסוף פרטי קשר ולידים"]');
  await page.click('#w-next');
  await page.waitForSelector('#f-knowledge', { timeout: 10000 });
  await page.fill('#f-knowledge', 'שם העסק: Browser Flow Business\nשעות פעילות: א-ה 9:00-18:00\nמתי להעביר לאדם: לקוח כועס או בקשת החזר');
  await page.click('button[data-tone="professional"]');
  await page.click('#w-next');
  await page.waitForSelector('#integrations-panel', { timeout: 10000 });
  await page.click('#w-next');
  await page.waitForSelector('#f-save', { timeout: 10000 });
  await page.click('#f-save');
  await page.waitForFunction(() => document.querySelector('#f-status')?.textContent?.includes('נשמר'), null, { timeout: 10000 });
  const configuredWorker = await req('/api/workers/' + workerId, { headers: { authorization: 'Bearer ' + tenantKey } });
  expect('beginner builder saves worker name', configuredWorker.body?.worker?.name === 'דניאל - עובד מכירות');
  expect('beginner builder saves business knowledge', configuredWorker.body?.worker?.knowledge?.includes('Browser Flow Business'));

  await page.goto(BASE + '/marketplace#/workers/chat/' + workerId, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pay-contact', { timeout: 15000 });
  expect('paywall form visible', await page.locator('#pay-submit').isVisible());

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

  await page.reload({ waitUntil: 'domcontentloaded' });
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
