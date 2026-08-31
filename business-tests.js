// Tests for the revenue, reliability and compliance subsystems.
//
// These cover the loops that decide whether the business works: does a lapsing
// subscription get chased instead of silently dying, does usage get attributed
// to the tenant paying for it, can a backup actually be restored, and can a
// deletion request be honoured.
//
// Pure-module tests run in-process against a temp SQLite DB; API tests run
// against the shared server started by run-tests.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.BASE_URL ?? 'http://localhost:8765';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token';
let failures = 0;
const ok = (l) => console.log(`OK    ${l}`);
const fail = (l, d) => { failures++; console.log(`FAIL  ${l}${d ? ' — ' + d : ''}`); };
const expect = (l, c, d) => (c ? ok(l) : fail(l, d));
const adminAuth = { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' };

async function req(path_, init = {}) {
  const r = await fetch(BASE + path_, init);
  const ct = r.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await r.json() : await r.text();
  return { status: r.status, body, headers: r.headers };
}

console.log(`Business subsystem tests against ${BASE}\n`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-business-'));
const scratchDb = new DatabaseSync(path.join(tmpRoot, 'scratch.db'));

// --- Tenant registry + plans ---------------------------------------------
{
  const registry = await import('./tenant-registry.js');
  registry.initTenantRegistry(scratchDb);

  const t = registry.upsertTenant({ tenantId: 'ten_a', businessName: 'מרפאת שיניים', contact: 'clinic@example.com' });
  expect('registry: creates tenant', t?.tenantId === 'ten_a');
  expect('  splits an email contact into contactEmail', t.contactEmail === 'clinic@example.com');

  const t2 = registry.upsertTenant({ tenantId: 'ten_b', businessName: 'נדל"ן', contact: '054-1234567' });
  expect('  splits a phone contact and normalises to E.164', t2.contactPhone === '972541234567');

  expect('  israeli local phone → 972 prefix', registry.normalisePhone('0501234567') === '972501234567');
  expect('  already-international phone untouched', registry.normalisePhone('+972501234567') === '972501234567');

  const targets = registry.notificationTargets('ten_a');
  expect('  notification targets resolve email', targets.email === 'clinic@example.com');

  registry.updateNotificationPrefs('ten_a', { notifyEmail: false });
  expect('  opting out suppresses the email target', registry.notificationTargets('ten_a').email === '');

  expect('plans: starter is cheaper per worker than agency', registry.getPlan('starter').priceIls < registry.getPlan('agency').priceIls);
  expect('  annual plan is 10x monthly (2 months free)', registry.getPlan('starter_annual').priceIls === registry.getPlan('starter').priceIls * 10);
  expect('  unknown plan falls back to the default', registry.getPlan('nope').id === registry.DEFAULT_PLAN);
  expect('  trial is excluded from the sellable catalogue', !registry.listPlans().some((p) => p.id === 'trial'));
}

// --- Usage metering + quota ----------------------------------------------
{
  const metering = await import('./usage-metering.js');
  metering.initUsageMetering(scratchDb);

  const cost = metering.estimateCostUsd({ model: 'gpt-4o-mini', promptTokens: 1_000_000, completionTokens: 0 });
  expect('metering: prices 1M prompt tokens from the table', Math.abs(cost - 0.15) < 1e-9);
  expect('  a frontier model costs more than a small one',
    metering.estimateCostUsd({ model: 'gpt-4o', promptTokens: 1000, completionTokens: 1000 })
    > metering.estimateCostUsd({ model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 1000 }));
  expect('  unknown model still gets a non-zero price',
    metering.estimateCostUsd({ model: 'totally-made-up', promptTokens: 1000, completionTokens: 1000 }) > 0);

  // Hebrew packs fewer characters per token than English.
  expect('  token approximation is higher for Hebrew than English of equal length',
    metering.approximateTokens('שלום'.repeat(50)) > metering.approximateTokens('hello'.repeat(40)));

  expect('  extracts OpenAI usage shape',
    metering.extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }, 'openai_compatible')?.promptTokens === 10);
  expect('  extracts Anthropic usage shape',
    metering.extractUsage({ usage: { input_tokens: 7, output_tokens: 3 } }, 'anthropic')?.completionTokens === 3);
  expect('  returns null when the gateway omits usage',
    metering.extractUsage({ choices: [] }, 'openai_compatible') === null);

  metering.recordUsage({ tenantId: 'ten_a', workerId: 'wk_1', model: 'gpt-4o-mini', promptTokens: 2000, completionTokens: 500 });
  metering.recordUsage({ tenantId: 'ten_a', workerId: 'wk_1', model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 200 });
  const usage = metering.tenantUsage('ten_a');
  expect('  counts messages per tenant', usage.messages === 2);
  expect('  accumulates prompt tokens', usage.promptTokens === 3000);
  expect('  converts cost to shekels', usage.costIls > 0);

  const quota = metering.checkQuota('ten_a');
  expect('quota: allows a tenant well under the limit', quota.allowed === true && quota.used === 2);
  expect('  reports the plan limit', quota.limit > 0);
  expect('  remaining is limit minus used', quota.remaining === quota.limit - quota.used);

  const margin = metering.marginReport();
  const row = margin.tenants.find((r) => r.tenantId === 'ten_a');
  expect('margin: reports revenue minus cost per tenant', row && row.marginIls === Number((row.revenueIls - row.costIls).toFixed(2)));
  expect('  totals flag unprofitable tenants', typeof margin.totals.unprofitableTenants === 'number');
}

// --- Billing lifecycle ----------------------------------------------------
{
  const billing = await import('./billing-lifecycle.js');
  const DAY = 86_400_000;

  expect('billing: a future date is not in grace', billing.isWithinGrace(new Date(Date.now() + DAY).toISOString()) === false);
  expect('  a date that just passed is in grace', billing.isWithinGrace(new Date(Date.now() - DAY).toISOString()) === true);
  expect('  a long-past date is beyond grace',
    billing.isWithinGrace(new Date(Date.now() - (billing.GRACE_DAYS + 2) * DAY).toISOString()) === false);
  expect('  no paid_until is never in grace', billing.isWithinGrace(null) === false);

  expect('  daysUntil counts forward', billing.daysUntil(new Date(Date.now() + 3 * DAY).toISOString()) === 3);
  expect('  daysUntil goes negative after expiry', billing.daysUntil(new Date(Date.now() - 2 * DAY).toISOString()) < 0);
  expect('  daysUntil tolerates rubbish input', billing.daysUntil('not-a-date') === null);

  const graceEnd = billing.graceEndsAt(new Date(Date.now() - DAY).toISOString());
  expect('  grace window ends GRACE_DAYS after paid_until',
    Math.round((new Date(graceEnd).getTime() - (Date.now() - DAY)) / DAY) === billing.GRACE_DAYS);
}

// --- Grace-aware activation ----------------------------------------------
{
  const workers = await import('./workers.js');
  const DAY = 86_400_000;
  const future = new Date(Date.now() + 10 * DAY).toISOString();
  const justExpired = new Date(Date.now() - DAY).toISOString();
  const longExpired = new Date(Date.now() - 90 * DAY).toISOString();

  const live = workers.subscriptionState({ status: 'active', paidUntil: future, paused: false });
  expect('subscription: a paid worker is live', live.isActive === true && live.inGrace === false);

  const grace = workers.subscriptionState({ status: 'active', paidUntil: justExpired, paused: false });
  expect('  a just-lapsed worker keeps serving inside grace', grace.isActive === true);
  expect('  and is flagged so the UI can warn', grace.inGrace === true && !!grace.graceEndsAt);

  const dead = workers.subscriptionState({ status: 'active', paidUntil: longExpired, paused: false });
  expect('  a long-lapsed worker stops serving', dead.isActive === false);

  const paused = workers.subscriptionState({ status: 'active', paidUntil: future, paused: true });
  expect('  a paused worker never serves', paused.isActive === false);

  const suspended = workers.subscriptionState({ status: 'suspended', paidUntil: future, paused: false });
  expect('  a suspended worker never serves', suspended.isActive === false);

  // The chat gate is stricter than the dashboard view on purpose.
  expect('  requirePaid rejects active-with-no-rental',
    workers.subscriptionState({ status: 'active', paidUntil: null, paused: false, requirePaid: true }).isActive === false);
  expect('  the list view still shows it as active',
    workers.subscriptionState({ status: 'active', paidUntil: null, paused: false }).isActive === true);
}

// --- Notification outbox --------------------------------------------------
{
  const notify = await import('./notify.js');
  notify.initNotify(scratchDb);

  const q = notify.queueNotification({
    recipient: 'owner@example.com', subject: 'בדיקה', html: '<b>שלום</b>',
    kind: 'test', tenantId: 'ten_a', dedupeKey: 'k1',
  });
  expect('notify: queues a message', q.queued === true);

  const dupe = notify.queueNotification({
    recipient: 'owner@example.com', subject: 'בדיקה', html: '<b>שלום</b>',
    kind: 'test', tenantId: 'ten_a', dedupeKey: 'k1',
  });
  expect('  dedupe key blocks a repeat send', dupe.queued === false && dupe.deduplicated === true);

  expect('  rejects a malformed email', notify.queueNotification({ recipient: 'not-an-email', subject: 'x' }).queued === false);
  expect('  rejects an empty recipient', notify.queueNotification({ recipient: '', subject: 'x' }).queued === false);

  // A CRLF in a subject would let a tenant-chosen worker name inject mail headers.
  const injected = notify.queueNotification({
    recipient: 'owner@example.com', subject: 'ok\r\nBcc: victim@example.com',
    html: 'x', dedupeKey: 'inj1',
  });
  const injectedRow = notify.recentNotifications(20).find((r) => r.id === injected.id);
  expect('  strips CRLF from subjects (header injection)',
    injected.queued === true && !/[\r\n]/.test(injectedRow?.subject ?? ''));

  const html = notify.renderEmail({ title: 'כותרת', intro: 'פתיח', ctaText: 'לחצו', ctaUrl: 'https://example.com' });
  expect('  renders RTL Hebrew email', html.includes('dir="rtl"') && html.includes('כותרת'));
  expect('  escapes HTML in user-supplied text',
    notify.renderEmail({ title: '<script>x</script>', intro: '' }).includes('&lt;script&gt;'));
  expect('  derives a text/plain alternative', notify.htmlToText('<p>שלום</p><br>עולם').includes('שלום'));

  expect('  rejects a phone that is not a phone',
    notify.queueNotification({ channel: 'whatsapp', recipient: 'abc', text: 'x' }).queued === false);
  expect('  accepts a valid WhatsApp recipient',
    notify.queueNotification({ channel: 'whatsapp', recipient: '972501234567', text: 'שלום', dedupeKey: 'wa1' }).queued === true);

  // Default provider is 'console' with no credentials, so flushing succeeds
  // without touching the network.
  const flushed = await notify.flushOutbox({ limit: 10 });
  expect('  flush drains the queue', flushed.sent >= 1);
  expect('  outbox stats reflect the send', notify.outboxStats().sent >= 1);
  // A whatsapp row must not be handed to the email sender: with no WhatsApp
  // credentials it should fail as whatsapp_not_configured, not as a bad address.
  const waRow = notify.recentNotifications(20).find((r) => r.channel === 'whatsapp');
  expect('  whatsapp rows route to the whatsapp sender',
    waRow && String(waRow.lastError ?? '').includes('whatsapp'), waRow?.lastError);
}

// --- Backup archive round-trip -------------------------------------------
{
  const backup = await import('./backup.js');
  const dataDir = path.join(tmpRoot, 'bkdata');
  const tenantsDir = path.join(dataDir, 'tenants');
  fs.mkdirSync(path.join(tenantsDir, 'ten_x'), { recursive: true });

  const platformPath = path.join(dataDir, 'earnings.db');
  const pdb = new DatabaseSync(platformPath);
  pdb.exec(`CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('platform-value');`);
  pdb.close();

  const tenantPath = path.join(tenantsDir, 'ten_x', 'workers.db');
  const tdb = new DatabaseSync(tenantPath);
  tdb.exec(`CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('tenant-value');`);
  tdb.close();

  const bdb = new DatabaseSync(path.join(tmpRoot, 'backup-meta.db'));
  backup.initBackup({ database: bdb, platformDbPath: platformPath, tenantsDirectory: tenantsDir, dataDir });

  const run = await backup.runBackup({ force: true });
  expect('backup: snapshot succeeds', run.ok === true, run.error);
  expect('  captures platform + tenant databases', run.databases === 2);

  const verified = backup.verifyLatestBackup();
  expect('  the written archive is readable back', verified.ok === true, verified.error);

  const restoreDir = path.join(tmpRoot, 'restored');
  const backupFile = path.join(dataDir, 'backups', run.fileName);
  const restored = backup.restoreBackup(backupFile, restoreDir);
  expect('  restore writes both databases', restored.written.length === 2);

  // The real test of a backup is that the restored data is actually there.
  const check = new DatabaseSync(path.join(restoreDir, 'tenants', 'ten_x', 'workers.db'), { readOnly: true });
  const value = check.prepare('SELECT v FROM marker').get()?.v;
  check.close();
  expect('  restored tenant data matches the original', value === 'tenant-value');

  const status = backup.backupStatus();
  expect('  status warns that off-site backup is unconfigured',
    status.warnings.some((w) => w.includes('off-site')));
  bdb.close();
}

// --- WhatsApp 24h window + signatures ------------------------------------
{
  const waSession = await import('./whatsapp-session.js');
  const wa = await import('./whatsapp-webhook.js');
  waSession.initWhatsAppSessions(scratchDb);

  const unknown = waSession.sessionWindow({ phoneKey: 'meta:1', customerPhone: '972501234567' });
  expect('whatsapp: an unknown session is closed (fails safe)', unknown.open === false);

  const blocked = waSession.planOutbound({ phoneKey: 'meta:1', customerPhone: '972501234567' });
  expect('  with no template configured, sending outside the window is blocked', blocked.type === 'blocked');

  waSession.recordInbound({ phoneKey: 'meta:1', customerPhone: '972501234567', tenantId: 'ten_a', workerId: 'wk_1' });
  const open = waSession.sessionWindow({ phoneKey: 'meta:1', customerPhone: '972501234567' });
  expect('  an inbound message opens the window', open.open === true && open.hoursRemaining > 0);
  expect('  phone formatting does not matter', waSession.sessionWindow({ phoneKey: 'meta:1', customerPhone: '+972-50-123-4567' }).open === true);

  const plan = waSession.planOutbound({ phoneKey: 'meta:1', customerPhone: '972501234567' });
  expect('  inside the window free-form text is allowed', plan.type === 'text');
  const payload = waSession.buildMetaPayload({ to: '972501234567', plan, text: 'שלום' });
  expect('  builds a Meta text payload', payload.type === 'text' && payload.text.body === 'שלום');

  const tplPayload = waSession.buildMetaPayload({
    to: '972501234567',
    plan: { type: 'template', name: 'reengage_he', language: 'he', params: ['דני'] },
  });
  expect('  builds a Meta template payload with body params',
    tplPayload.type === 'template' && tplPayload.template.components[0].parameters[0].text === 'דני');

  // Signature verification: the endpoint drives real spend, so a forged POST
  // must not get through.
  const body = JSON.stringify({ entry: [] });
  process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
  const good = `sha256=${crypto.createHmac('sha256', 'test-app-secret').update(body, 'utf8').digest('hex')}`;
  expect('  accepts a correctly signed Meta webhook', wa.verifyMetaSignature(body, good).ok === true);
  expect('  rejects a tampered body', wa.verifyMetaSignature(`${body} `, good).ok === false);
  expect('  rejects a missing signature', wa.verifyMetaSignature(body, '').ok === false);

  process.env.TWILIO_AUTH_TOKEN = 'test-twilio-token';
  const params = { From: 'whatsapp:+972501234567', Body: 'hi' };
  const url = 'https://example.com/api/webhooks/whatsapp';
  let payloadStr = url;
  for (const k of Object.keys(params).sort()) payloadStr += k + params[k];
  const twSig = crypto.createHmac('sha1', 'test-twilio-token').update(payloadStr, 'utf8').digest('base64');
  expect('  accepts a correctly signed Twilio webhook', wa.verifyTwilioSignature(url, params, twSig).ok === true);
  expect('  rejects a Twilio signature for a different URL',
    wa.verifyTwilioSignature('https://evil.example/x', params, twSig).ok === false);
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.TWILIO_AUTH_TOKEN;
}

// --- Compliance -----------------------------------------------------------
{
  const compliance = await import('./compliance.js');
  expect('compliance: AI disclosure is appended to a persona', compliance.withAiDisclosure('אתה מזכיר.').includes(compliance.AI_DISCLOSURE_HE));
  expect('  erasure refuses a partial phone number',
    compliance.deleteCustomerData('ten_a', { phone: '123' }).error === 'phone_too_short');
  expect('  it is not appended twice', (() => {
    const once = compliance.withAiDisclosure('x');
    return compliance.withAiDisclosure(once) === once;
  })());
  expect('  the disclosure forbids impersonating a human', compliance.AI_DISCLOSURE_HE.includes('לא אדם'));
}

// --- Owner alert escaping -------------------------------------------------
{
  const notify = await import('./notify.js');
  expect('escaping: notify.esc neutralises markup', notify.esc('<img src=x onerror=1>').includes('&lt;img'));
  expect('  quotes are escaped too', notify.esc('a"b\'c').includes('&quot;'));
}

// --- Funnel analytics -----------------------------------------------------
{
  const funnel = await import('./funnel-analytics.js');
  funnel.initFunnelAnalytics(scratchDb);

  expect('funnel: rejects an unknown step', funnel.recordEvent({ step: 'nope', sessionKey: 's1' }).ok === false);
  expect('  requires a session key', funnel.recordEvent({ step: 'landing_view', sessionKey: '' }).ok === false);
  expect('  records a known step', funnel.recordEvent({ step: 'landing_view', sessionKey: 's1' }).ok === true);

  funnel.recordEvent({ step: 'landing_view', sessionKey: 's2' });
  funnel.recordEvent({ step: 'landing_view', sessionKey: 's1' }); // same session, still one
  funnel.recordEvent({ step: 'marketplace_view', sessionKey: 's1' });

  const report = funnel.funnelReport({ days: 7 });
  const landing = report.steps.find((s) => s.step === 'landing_view');
  const marketplace = report.steps.find((s) => s.step === 'marketplace_view');
  expect('  counts unique sessions, not raw events', landing.sessions === 2);
  expect('  computes step-to-step conversion', marketplace.conversionFromPrevious === 50);
  expect('  identifies the biggest drop-off', report.biggestDropOff?.lost >= 1);

  // A raw session key must never be stored.
  const stored = scratchDb.prepare(`SELECT session_key FROM funnel_events LIMIT 1`).get()?.session_key;
  expect('  session keys are hashed at rest', stored !== 's1' && stored?.length === 32);
}

// --- API surface ----------------------------------------------------------
{
  const r = await req('/api/plans');
  expect('API: GET /api/plans -> 200', r.status === 200);
  expect('  exposes the plan catalogue', Array.isArray(r.body.plans) && r.body.plans.length >= 3);
  expect('  publishes the grace period', typeof r.body.graceDays === 'number');
}

{
  const r = await req('/api/track', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 'landing_view', sessionKey: 'api-test-session' }),
  });
  expect('API: POST /api/track accepts an event', r.status === 204);
  const bad = await req('/api/track', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 'made_up_step', sessionKey: 'x' }),
  });
  expect('  an unknown step is never a user-visible error', bad.status === 204);
}

{
  const signup = await req('/api/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessName: 'עסק בדיקה', contact: 'biz@example.com' }),
  });
  expect('API: signup -> 200', signup.status === 200);
  const key = signup.body.key;
  const tenantAuth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  const usage = await req('/api/account/usage', { headers: tenantAuth });
  expect('API: GET /api/account/usage -> 200', usage.status === 200);
  expect('  returns a quota with a real limit', usage.body.quota?.limit > 0);
  expect('  signup registered the contact for billing email', usage.body.contact?.email === 'biz@example.com');

  const prefs = await req('/api/account/notifications', {
    method: 'POST', headers: tenantAuth,
    body: JSON.stringify({ notifyWhatsapp: true, contactPhone: '0521112222' }),
  });
  expect('API: notification prefs update -> 200', prefs.status === 200);
  expect('  phone stored in E.164', prefs.body.contact?.phone === '972521112222');

  const noId = await req('/api/account/data-delete', {
    method: 'POST', headers: tenantAuth, body: JSON.stringify({ confirm: true }),
  });
  expect('API: erasure without an identifier -> 400', noId.status === 400);

  const noConfirm = await req('/api/account/data-delete', {
    method: 'POST', headers: tenantAuth, body: JSON.stringify({ phone: '0501234567' }),
  });
  expect('  erasure requires explicit confirmation', noConfirm.status === 400 && noConfirm.body.error === 'confirmation_required');

  const exp = await req('/api/account/data-export', {
    method: 'POST', headers: tenantAuth, body: JSON.stringify({ phone: '0509999999' }),
  });
  expect('API: data export -> 200 for an unknown customer', exp.status === 200 && exp.body.found === false);

  const unauth = await req('/api/account/usage');
  expect('  account endpoints require auth', unauth.status === 401);
}

{
  const margin = await req('/api/admin/margin', { headers: adminAuth });
  expect('API: GET /api/admin/margin -> 200', margin.status === 200 && Array.isArray(margin.body.tenants));

  const funnelRep = await req('/api/admin/funnel', { headers: adminAuth });
  expect('API: GET /api/admin/funnel -> 200', funnelRep.status === 200 && Array.isArray(funnelRep.body.steps));

  const backups = await req('/api/admin/backups', { headers: adminAuth });
  expect('API: GET /api/admin/backups -> 200', backups.status === 200 && typeof backups.body.enabled === 'boolean');

  const tenants = await req('/api/admin/tenants', { headers: adminAuth });
  expect('API: GET /api/admin/tenants -> 200', tenants.status === 200);
  expect('  flags tenants with no way to reach them', typeof tenants.body.unreachable === 'number');

  const notifications = await req('/api/admin/notifications', { headers: adminAuth });
  expect('API: GET /api/admin/notifications -> 200', notifications.status === 200 && !!notifications.body.config);

  for (const p of ['/api/admin/margin', '/api/admin/funnel', '/api/admin/backups', '/api/admin/tenants', '/api/admin/notifications']) {
    const r = await req(p);
    if (r.status !== 401) fail(`  ${p} requires admin auth`, `got ${r.status}`);
  }
  ok('  all new admin endpoints require admin auth');

  const run = await req('/api/admin/billing-run', { method: 'POST', headers: adminAuth });
  expect('API: POST /api/admin/billing-run -> 200', run.status === 200 && run.body.ok === true);
  expect('  the cycle reports what it scanned', typeof run.body.scanned === 'number');
}

{
  const health = await req('/health');
  expect('health: reports notification config', !!health.body.notifications);
  expect('  reports backup health', typeof health.body.backups?.healthy === 'boolean');
  expect('  reports quota enforcement', typeof health.body.usage?.enforced === 'boolean');
  expect('  reports the grace period', typeof health.body.billing?.graceDays === 'number');
  expect('  never leaks credentials', !JSON.stringify(health.body).includes(ADMIN_TOKEN));
}

scratchDb.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });

if (failures) {
  console.log(`\n${failures} business test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll business tests passed.');
