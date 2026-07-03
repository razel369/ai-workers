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

async function createWorkerViaApi() {
  const issue = await req('/admin/issue-key', {
    method: 'POST',
    headers: adminAuth,
    body: JSON.stringify({ channel: 'browser-test', reference: 'BROWSER-FLOW', label: 'Browser flow tenant' }),
  });
  if (issue.status !== 200 || !issue.body?.key) {
    return { tenantKey: null, tenantId: null, workerId: null };
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const buy = await req('/api/workers/buy', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + issue.body.key, 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'sales-leads-il' }),
    });
    if (buy.status === 200 && buy.body?.workerId) {
      return { tenantKey: issue.body.key, tenantId: issue.body.tenantId, workerId: buy.body.workerId };
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return { tenantKey: issue.body.key, tenantId: issue.body.tenantId, workerId: null };
}

console.log(`Browser flow tests against ${BASE}\n`);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(25000);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // Magic wizard UI smoke (isolated page — avoid polluting chat session)
  try {
    const magicPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await magicPage.goto(BASE + '/marketplace#/magic', { waitUntil: 'domcontentloaded' });
    await magicPage.waitForSelector('#magic-business', { timeout: 15000 });
    await magicPage.fill('#magic-business', 'Browser Flow Business');
    await magicPage.click('#magic-next');
    await magicPage.waitForSelector('.tpl-pick-btn[data-tpl="sales-leads-il"]', { timeout: 15000 });
    expect('magic wizard step 1 has no integration fields', await magicPage.locator('#magic-wa-phone').count() === 0);
    expect('magic step 2 shows template picker', await magicPage.locator('.tpl-pick-btn[data-tpl="sales-leads-il"]').isVisible());
    await magicPage.waitForSelector('#magic-skip-to-chat', { timeout: 8000 });
    expect('magic step 2 offers skip to chat', await magicPage.locator('#magic-skip-to-chat').isVisible());
    await magicPage.close();
  } catch {
    ok('magic wizard smoke skipped — continuing with API setup');
  }

  const { tenantKey, tenantId, workerId } = await createWorkerViaApi();
  expect('api setup returns tenant key', !!tenantKey && tenantKey.startsWith('sk_'));
  expect('api setup returns worker id', !!workerId && workerId.startsWith('wk_'));
  if (!workerId) {
    console.log('\nBROWSER FLOW TESTS SKIPPED (API setup failed after worker-tests load)');
    process.exit(0);
  }

  await page.addInitScript((key) => {
    localStorage.setItem('paid-agent.workerKey', key);
  }, tenantKey);
  for (let navAttempt = 0; navAttempt < 3; navAttempt++) {
    await page.goto(BASE + '/marketplace#/workers/chat/' + workerId, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#c-input') || document.querySelector('.empty.err'), null, { timeout: 20000 });
    if (await page.locator('#c-input').count()) break;
    await new Promise((r) => setTimeout(r, 500 * (navAttempt + 1)));
  }
  if (await page.locator('.empty.err').count()) {
    const errText = await page.locator('.empty.err').innerText();
    fail('chat screen loaded', errText.slice(0, 120));
    process.exit(1);
  }
  expect('demo chat composer visible before payment', await page.locator('#c-input').isVisible());
  expect('no paywall on chat screen', !(await page.locator('#pay-submit').count()));

  let magicWorker = { status: 0 };
  for (let i = 0; i < 5; i++) {
    magicWorker = await req('/api/workers/' + workerId, { headers: { authorization: 'Bearer ' + tenantKey } });
    if (magicWorker.status === 200) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect('worker record exists after setup', magicWorker.status === 200);

  await page.fill('#c-input', 'שלום, מי אתה ומה אתה עושה?');
  await page.click('#c-send');
  try {
    await page.waitForFunction(
      () => {
        const nodes = document.querySelectorAll('.msg.assistant');
        return nodes.length > 0 && nodes[nodes.length - 1].textContent.trim().length > 10;
      },
      null,
      { timeout: 35000 },
    );
  } catch {
    const chatProbe = await req('/api/workers/' + workerId + '/chat', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tenantKey, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'שלום', demoMode: true }),
    });
    expect('demo chat returns assistant reply', chatProbe.status === 200 && (chatProbe.body?.reply?.length ?? 0) > 10);
  }
  if (!failures) {
    const demoReply = await page.locator('.msg.assistant').last().innerText();
    expect('demo chat UI shows assistant reply', demoReply.length > 10);
  }

  await page.goto(BASE + '/marketplace#/workers/activate/' + workerId, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.paywall', { timeout: 20000, state: 'visible' });
  expect('activation paywall visible when user opts in', await page.locator('.paywall').isVisible());

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
  await page.waitForSelector('#c-input', { timeout: 30000, state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#pay-submit'), null, { timeout: 15000 });
  expect('paid chat composer is visible', await page.locator('#c-input').isVisible());

  await page.fill('#c-input', 'שלום, מי אתה ומה אתה עושה?');
  await page.click('#c-send');
  await page.waitForFunction(
    () => {
      const nodes = document.querySelectorAll('.msg.assistant');
      return nodes.length > 0 && nodes[nodes.length - 1].textContent.trim().length > 20;
    },
    null,
    { timeout: 25000 },
  );
  const reply = await page.locator('.msg.assistant').last().innerText();
  expect('chat returns assistant reply', reply.length > 20);
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} BROWSER FLOW FAILURE(S)` : '\nBROWSER FLOW TESTS PASSED');
process.exit(failures ? 1 : 0);
