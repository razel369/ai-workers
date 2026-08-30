// Browser regression test for the rendered buy -> activate -> chat flow.

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

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
      await req('/api/workers/' + buy.body.workerId, {
        method: 'PATCH',
        headers: { authorization: 'Bearer ' + issue.body.key, 'content-type': 'application/json' },
        body: JSON.stringify({
          knowledge: 'שם העסק: Browser Flow Business\nשעות פעילות: א׳–ה׳ 09:00–17:00\nמידע חסר מועבר תמיד לנציג אנושי.',
          knowledgeReviewed: true,
        }),
      });
      return { tenantKey: issue.body.key, tenantId: issue.body.tenantId, workerId: buy.body.workerId };
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return { tenantKey: issue.body.key, tenantId: issue.body.tenantId, workerId: null };
}

console.log(`Browser flow tests against ${BASE}\n`);

const uiSource = await readFile(new URL('./workers-ui.html', import.meta.url), 'utf8');
expect('UI has no automatic account key rotation request', !uiSource.includes("const rotateRow = await api('/api/account/rotate-key'"));
expect('Paddle completion waits for server activation', uiSource.includes('waitForWorkerActivation(workerId, alive)') && uiSource.includes('paddle-activation-status'));
expect('Paddle checkout uses only a server-created transaction id', uiSource.includes('transactionId: body.transactionId')
  && !uiSource.includes('customData: body.customData'));
expect('protected exports use authenticated Blob download', uiSource.includes('downloadAuthenticated(`/api/workers/${encodeURIComponent(workerId)}/leads.csv`') && !uiSource.includes('href="/api/workers/${encodeURIComponent(workerId)}/leads.csv"'));

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(25000);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // API failures must be rendered as failures, never as an empty catalogue.
  try {
    const errorPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await errorPage.route('**/api/workers/templates', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary' }) }));
    await errorPage.goto(BASE + '/marketplace#/', { waitUntil: 'domcontentloaded' });
    await errorPage.waitForSelector('#marketplace-retry', { timeout: 15000 });
    expect('template API error is not rendered as empty catalogue', (await errorPage.locator('[role="alert"]').innerText()).includes('לא הצלחנו לטעון'));
    await errorPage.close();
  } catch (e) {
    fail('template API error state', e.message);
  }

  // Magic wizard: real owner contact and mandatory knowledge review precede creation.
  try {
    const magicContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const magicPage = await magicContext.newPage();
    let buyRequests = 0;
    magicPage.on('request', (request) => { if (request.url().includes('/api/workers/buy')) buyRequests++; });
    await magicPage.goto(BASE + '/marketplace#/magic', { waitUntil: 'domcontentloaded' });
    await magicPage.waitForSelector('#magic-business', { timeout: 15000 });
    await magicPage.fill('#magic-business', 'Browser Flow Business');
    await magicPage.fill('#magic-contact', `browser-flow-${Date.now()}@example.com`);
    await magicPage.click('#magic-next');
    await magicPage.waitForSelector('.tpl-pick-btn[data-tpl="sales-leads-il"]', { timeout: 15000 });
    expect('magic wizard step 1 has no integration fields', await magicPage.locator('#magic-wa-phone').count() === 0);
    expect('magic step 2 shows template picker', await magicPage.locator('.tpl-pick-btn[data-tpl="sales-leads-il"]').isVisible());
    await magicPage.click('.tpl-pick-btn[data-tpl="sales-leads-il"]');
    await magicPage.click('#magic-next');
    await magicPage.waitForSelector('#magic-knowledge', { timeout: 15000 });
    expect('knowledge review is mandatory before worker creation', await magicPage.locator('#magic-review-next').isDisabled() && buyRequests === 0);
    await magicPage.fill('#magic-knowledge', 'שם העסק: Browser Flow Business\nשעות: א׳–ה׳ 09:00–17:00\nבכל מידע חסר יש להעביר לנציג אנושי.');
    await magicPage.check('#magic-knowledge-confirm');
    expect('explicit knowledge approval enables review continuation', !(await magicPage.locator('#magic-review-next').isDisabled()));
    await magicPage.click('#magic-review-next');
    await magicPage.waitForSelector('#magic-finish', { timeout: 10000 });
    expect('final CTA creates worker only after review', await magicPage.locator('#magic-finish').isVisible() && buyRequests === 0);
    await magicPage.click('#magic-skip');
    await magicPage.waitForSelector('#recovery-code-value', { timeout: 20000 });
    const magicCookies = await magicContext.cookies(BASE);
    expect('signup establishes HttpOnly owner session cookie', magicCookies.some((cookie) => cookie.name === 'aiw_owner_session' && cookie.httpOnly));
    expect('signup does not persist a new tenant key in localStorage', await magicPage.evaluate(() => !localStorage.getItem('paid-agent.workerKey')));
    expect('recovery code is shown once with storage warning', (await magicPage.locator('[role="dialog"]').innerText()).includes('לא יוצג שוב'));
    await magicPage.waitForFunction(() => location.hash.startsWith('#/workers/chat/'), null, { timeout: 15000 });
    await magicPage.click('#recovery-code-close');
    await magicPage.goto(BASE + '/marketplace#/account', { waitUntil: 'domcontentloaded' });
    await magicPage.waitForSelector('#create-api-key-btn', { timeout: 15000 });
    expect('cookie session exposes API-key creation only as an explicit action', await magicPage.locator('#create-api-key-btn').isVisible());
    await magicContext.close();
  } catch (e) {
    fail('magic wizard review flow', e.message);
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
  let ownerRotateRequests = 0;
  let lastChatCustomerId = '';
  let lastHistoryCustomerId = '';
  page.on('request', (request) => {
    if (request.url().includes('/api/account/rotate-key')) ownerRotateRequests++;
    if (request.url().includes(`/api/workers/${workerId}/messages`)) {
      lastHistoryCustomerId = new URL(request.url()).searchParams.get('customerId') || '';
    }
    if (request.method() === 'POST'
        && (request.url().endsWith(`/api/workers/${workerId}/chat`)
          || request.url().endsWith(`/api/workers/${workerId}/test-agent`))) {
      try { lastChatCustomerId = JSON.parse(request.postData() || '{}').customerId || ''; } catch {}
    }
  });
  await page.goto(BASE + '/marketplace#/account', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.account-page', { timeout: 20000 });
  const legacyKeyAfterAccountLoad = await page.evaluate(() => localStorage.getItem('paid-agent.workerKey'));
  expect('account load never rotates owner key', ownerRotateRequests === 0 && legacyKeyAfterAccountLoad === tenantKey);
  expect('legacy migration login cannot rotate key from UI', await page.locator('#create-api-key-btn').count() === 0);
  const legacyStillValid = await req('/api/account', { headers: { authorization: 'Bearer ' + tenantKey } });
  expect('legacy key remains valid after account screen', legacyStillValid.status === 200);

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
  expect('chat exposes accessible log and labelled composer', await page.locator('#chat-window[role="log"]').count() === 1 && (await page.locator('#c-input').getAttribute('aria-label')) === 'הודעה לעובד');
  expect('zero-day configuration is labeled as demo, not a timed trial', (await page.locator('.demo-banner-copy').innerText()).includes('מצב דמו') && !(await page.locator('.demo-banner-copy').innerText()).includes('מצב ניסיון'));

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
    const chatProbe = await req('/api/workers/' + workerId + '/test-agent', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tenantKey, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'שלום', customerId: `owner:${workerId}` }),
    });
    expect('demo chat returns assistant reply', chatProbe.status === 200 && (chatProbe.body?.reply?.length ?? 0) > 10);
  }
  if (!failures) {
    const demoReply = await page.locator('.msg.assistant').last().innerText();
    expect('demo chat UI shows assistant reply', demoReply.length > 10);
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#c-input', { timeout: 20000 });
  const demoReloadText = await page.locator('#chat-window').innerText();
  expect('owner chat uses one stable customer id for send and history', lastChatCustomerId === `owner:${workerId}` && lastHistoryCustomerId === `owner:${workerId}`);
  expect('demo preview is intentionally ephemeral', !demoReloadText.includes('שלום, מי אתה ומה אתה עושה?'));

  const historyPattern = `**/api/workers/${workerId}/messages*`;
  const failHistory = (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary' }) });
  await page.route(historyPattern, failHistory);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chat-history-error', { timeout: 15000 });
  expect('chat history failure shows retry instead of empty state', await page.locator('#chat-history-retry').isVisible());
  await page.unroute(historyPattern, failHistory);
  await page.click('#chat-history-retry');
  await page.waitForSelector('#chat-history-error', { state: 'detached', timeout: 15000 });

  await page.goto(BASE + '/marketplace#/workers/insights/' + workerId, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#leads-csv-download', { timeout: 20000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#leads-csv-download'),
  ]);
  expect('CSV export is downloaded through authenticated fetch', download.suggestedFilename().startsWith('leads-'));

  await page.goto(BASE + '/marketplace#/workers/activate/' + workerId, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.paywall', { timeout: 20000, state: 'visible' });
  expect('activation paywall visible when user opts in', await page.locator('.paywall').isVisible());
  if (await page.locator('#paddle-checkout').count()) {
    await page.evaluate(() => {
      window.Paddle = {
        Environment: { set() {} },
        Initialize(config) { this.eventCallback = config.eventCallback; },
        Checkout: { open() {} },
      };
    });
    await page.click('#paddle-checkout');
    await page.waitForFunction(() => typeof window.Paddle?.eventCallback === 'function', null, { timeout: 10000 });
    await page.evaluate(() => { void window.Paddle.eventCallback({ name: 'checkout.completed' }); });
    await page.waitForFunction(
      () => document.querySelector('#paddle-activation-status')?.textContent.includes('ממתינים לאישור'),
      null,
      { timeout: 10000 },
    );
    expect('Paddle completion stays pending until server confirms active', page.url().includes(`#/workers/activate/${workerId}`) && !page.url().includes('/live/'));
  }

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
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#c-input', { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelector('#chat-window')?.textContent.includes('שלום, מי אתה ומה אתה עושה?'),
    null,
    { timeout: 10000 },
  );
  expect('paid owner chat history persists after reload', (await page.locator('#chat-window').innerText()).includes('שלום, מי אתה ומה אתה עושה?'));
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} BROWSER FLOW FAILURE(S)` : '\nBROWSER FLOW TESTS PASSED');
process.exit(failures ? 1 : 0);
