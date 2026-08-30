// E2E tests for the Workers feature (v0.5.0).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeShopifyShopHost, validateConfig } from './integrations/registry.js';
import { buildOAuthReturnUrl } from './url-security.js';
// payment-gated chat (mock + LLM-free), admin mark-paid, admin listing,
// per-tenant isolation, platform-provided AI (no BYOK).

const BASE = process.env.BASE_URL ?? 'http://localhost:8765';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token';
const BIT_WEBHOOK_SECRET = process.env.BIT_WEBHOOK_SECRET ?? process.env.PAYMENT_WEBHOOK_SECRET ?? '';
const PAYPAL_WEBHOOK_SECRET = process.env.PAYPAL_WEBHOOK_SECRET ?? process.env.PAYMENT_WEBHOOK_SECRET ?? '';
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

console.log(`Workers tests against ${BASE}\n`);

// 1. Marketplace HTML page
{
  const r = await req('/marketplace');
  expect('GET /marketplace -> 200', r.status === 200);
  expect('  serves Hebrew HTML', String(r.body).includes('שוק העובדים'));
  expect('  contains marketplace positioning', String(r.body).includes('קטלוג עובדים'));
  expect('  magic CTA present', String(r.body).includes('נסה עכשיו בחינם'));
}
{
  const r = await req('/builder');
  expect('GET /builder -> 200', r.status === 200);
}

// 2. Templates API
{
  const r = await req('/api/workers/templates');
  expect('GET /api/workers/templates -> 200', r.status === 200);
  expect('  has 15 templates', r.body.templates?.length >= 15);
  expect('  all have id/name/buyPriceIls', r.body.templates?.every((t) => t.id && t.name && t.buyPriceIls >= 0));
  expect('  sales-leads-il present', !!r.body.templates?.find((t) => t.id === 'sales-leads-il'));
  expect('  support-he present', !!r.body.templates?.find((t) => t.id === 'support-he'));
  expect('  data-entry present', !!r.body.templates?.find((t) => t.id === 'data-entry'));
  expect('  content-he present', !!r.body.templates?.find((t) => t.id === 'content-he'));
  expect('  real-estate-il present', !!r.body.templates?.find((t) => t.id === 'real-estate-il'));
  expect('  clinic-receptionist-he present', !!r.body.templates?.find((t) => t.id === 'clinic-receptionist-he'));
  expect('  restaurant-manager-he present', !!r.body.templates?.find((t) => t.id === 'restaurant-manager-he'));
  expect('  ecom-support-he present', !!r.body.templates?.find((t) => t.id === 'ecom-support-he'));
  expect('  property-manager-he present', !!r.body.templates?.find((t) => t.id === 'property-manager-he'));
  expect('  social-media-creator-he present', !!r.body.templates?.find((t) => t.id === 'social-media-creator-he'));
  expect('  hr-recruiter-he present', !!r.body.templates?.find((t) => t.id === 'hr-recruiter-he'));
  expect('  complaints-desk-he present', !!r.body.templates?.find((t) => t.id === 'complaints-desk-he'));
  expect('  legal-receptionist-he present', !!r.body.templates?.find((t) => t.id === 'legal-receptionist-he'));
  expect('  social-strategist-he present', !!r.body.templates?.find((t) => t.id === 'social-strategist-he'));
  expect('  market-research-he present', !!r.body.templates?.find((t) => t.id === 'market-research-he'));
  const hrTpl = r.body.templates?.find((t) => t.id === 'hr-recruiter-he');
  expect('  hr template has agent tools', hrTpl?.defaultTools?.includes('save_lead') && hrTpl?.defaultTools?.includes('book_meeting_link'));
  const complaintsTpl = r.body.templates?.find((t) => t.id === 'complaints-desk-he');
  expect('  complaints template has escalate tool', complaintsTpl?.defaultTools?.includes('escalate_to_human'));
  const socialTpl = r.body.templates?.find((t) => t.id === 'social-strategist-he');
  expect('  social strategist has image + webhook tools', socialTpl?.defaultTools?.includes('generate_image') && socialTpl?.defaultTools?.includes('notify_webhook'));
  const researchTpl = r.body.templates?.find((t) => t.id === 'market-research-he');
  expect('  market research has fetch_web_page', researchTpl?.defaultTools?.includes('fetch_web_page'));
}

// 3. Need a tenant API key to test private endpoints
let tenantKey = null;
let tenantId = null;
{
  const r = await req('/admin/issue-key', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ channel: 'paypal', reference: 'PP-WORKERS-TEST', label: 'Workers test tenant' }),
  });
  expect('admin issue-key for tenant -> 200', r.status === 200);
  tenantKey = r.body?.key;
  tenantId = r.body?.tenantId;
  expect('  got tenant key', !!tenantKey && tenantKey.startsWith('sk_'));
  expect('  got stable tenant id', !!tenantId && tenantId.startsWith('ten_'));
}
const auth = (extra = {}) => ({ authorization: 'Bearer ' + tenantKey, 'content-type': 'application/json', ...extra });
const primaryCustomerId = 'worker-tests-primary-customer';
const REVIEWED_SALES_KNOWLEDGE = `שם העסק: אקמי פתרונות בעמ
שירות: מערכת ניהול פניות ולידים לעסקים בישראל
שעות מכירות: ימים א עד ה משמונה בבוקר עד חמש אחר הצהריים
טלפון: 035551234
מחירים: הצעה מאושרת נמסרת רק על ידי נציג לאחר אפיון
הסלמה: בקשות משפטיות והחזרים עוברים לנציג אנושי`;

// 4. List workers (empty)
{
  const r = await req('/api/workers', { headers: auth() });
  expect('GET /api/workers -> 200', r.status === 200);
  expect('  empty list initially', Array.isArray(r.body.workers) && r.body.workers.length === 0);
}
{
  const r = await req('/api/mcp/discover?url=' + encodeURIComponent('http://127.0.0.1:1/mcp'), { headers: auth() });
  expect('MCP discover blocks localhost SSRF target', r.status === 400 && r.body.error === 'unsafe_url' && r.body.reason === 'private_network_blocked');
}
{
  const r = await req('/api/mcp/discover?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data'), { headers: auth() });
  expect('MCP discover blocks cloud metadata target', r.status === 400 && r.body.error === 'unsafe_url' && r.body.reason === 'private_network_blocked');
}
{
  const r = await req('/api/workers/learn-from-site', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ url: 'http://localhost/internal' }),
  });
  expect('learn-from-site blocks private network URLs', r.status === 400 && r.body.error === 'unsafe_url');
}

// 5. Buy a template (creates worker in pending_payment state)
let firstWorkerId = null;
let paddleWorkerId = null;
let activationRequestId = null;
let crossTenantId = null;
let crossTenantKey = null;
let crossTenantWorkerId = null;
{
  const r = await req('/api/workers/buy', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ templateId: 'sales-leads-il', paymentChannel: 'paypal', paymentReference: 'PP-X1' }),
  });
  expect('POST /api/workers/buy sales-leads-il -> 200', r.status === 200);
  expect('  returns workerId', !!r.body.workerId);
  expect('  template echoed', r.body.template?.id === 'sales-leads-il');
  firstWorkerId = r.body.workerId;
}
{
  const r = await req(`/api/workers/${firstWorkerId}`, {
    method: 'PATCH', headers: auth(),
    body: JSON.stringify({ mcpServers: [{ name: 'Localhost MCP', url: 'http://127.0.0.1:3000/mcp' }] }),
  });
  expect('worker update rejects unsafe MCP server URL', r.status === 400 && r.body.error === 'unsafe_mcp_server_url');
}
{
  const r = await req('/api/workers', { headers: auth() });
  expect('  list now has 1 worker', r.body.workers?.length === 1);
  expect('  worker status=pending_payment', r.body.workers?.[0]?.status === 'pending_payment');
  expect('  worker not isActive', r.body.workers?.[0]?.isActive === false);
}

// 6. Chat while pending_payment -> 402
{
  const r = await req(`/api/workers/${firstWorkerId}/chat`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ message: 'hello' }),
  });
  expect('chat while pending -> 402', r.status === 402);
  expect('  error=not_paid_or_paused', r.body.error === 'not_paid_or_paused');
}

// 6a. Preview uses a dedicated server-owned planning route.
{
  const r = await req(`/api/workers/${firstWorkerId}/test-agent`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ message: 'שלום', customerId: primaryCustomerId, demoMode: false, testMode: false }),
  });
  expect('dedicated preview while pending -> 200', r.status === 200);
  expect('  has reply', typeof r.body.reply === 'string' && r.body.reply.length > 5);
  expect('  qualityScore present', !!r.body.qualityScore?.labelHe);
}

// 6a1. workers enhancements — suggestions, health, smart knowledge, learn correction
{
  const tr = await req('/api/workers/templates');
  const clinic = tr.body.templates?.find((t) => t.id === 'clinic-receptionist-he');
  expect('template has suggestions', Array.isArray(clinic?.suggestions) && clinic.suggestions.length === 3);
  expect('  clinic suggestion includes appointment', clinic?.suggestions?.some((s) => /תור/.test(s)));
}
{
  const r = await req('/api/workers/smart-knowledge?templateId=clinic-receptionist-he&businessName=מרפאת%20שמש');
  expect('smart-knowledge -> 200', r.status === 200);
  expect('  includes business name', String(r.body.knowledge).includes('מרפאת שמש'));
  expect('  includes hours boilerplate', /שעות/.test(r.body.knowledge));
}
{
  const r = await req('/api/workers', { headers: auth() });
  expect('workers list includes health', r.body.workers?.[0]?.health?.labelHe?.length > 2);
}
{
  const r = await req(`/api/workers/${firstWorkerId}`, { headers: auth() });
  expect('get worker includes suggestions', Array.isArray(r.body.suggestions) && r.body.suggestions.length >= 1);
  expect('  get worker includes health', !!r.body.health?.labelHe);
}
{
  const r = await req(`/api/workers/${firstWorkerId}/learn-correction`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ userMessage: 'מה השעות?', original: 'לא יודע', corrected: 'א-ה 09:00-18:00' }),
  });
  expect('learn-correction -> 200', r.status === 200 && r.body.ok === true);
  const w = await req(`/api/workers/${firstWorkerId}`, { headers: auth() });
  expect('  knowledge contains correction', String(w.body.worker?.knowledge).includes('09:00-18:00'));
}
{
  const r = await fetch(BASE + `/api/workers/${firstWorkerId}/chat/stream`, {
    method: 'POST',
    headers: { ...auth(), accept: 'text/event-stream' },
    body: JSON.stringify({ message: 'שלום', customerId: primaryCustomerId, demoMode: true, testMode: true }),
  });
  const text = await r.text();
  expect('pending stream ignores client mode flags -> 402', r.status === 402);
  expect('  pending stream never starts SSE', !text.includes('event: token') && !text.includes('event: done'));
}
{
  // Weekly digest endpoint: returns KPIs + topics + recent activity
  const r = await req(`/api/workers/${firstWorkerId}/weekly-digest`, { headers: auth() });
  expect('weekly-digest -> 200', r.status === 200);
  expect('  digest has worker block', !!r.body.worker?.id);
  expect('  digest has KPIs', typeof r.body.kpis?.messagesThisWeek === 'number');
  expect('  digest has topTopics array', Array.isArray(r.body.topTopics));
  expect('  digest period is 7 days', r.body.period?.days === 7);
  const htmlR = await req(`/api/workers/${firstWorkerId}/weekly-digest.html`, { headers: auth() });
  expect('  digest html -> 200', htmlR.status === 200);
  expect('  digest html is RTL', /dir="rtl"/.test(htmlR.body));
  expect('  digest html includes worker name', htmlR.body.includes(r.body.worker.name));
}

// 6a2. public pre-signup template demo chat
{
  const r = await req('/api/public/demo-chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ templateId: 'support-he', message: 'שלום, מה אתה עושה?' }),
  });
  expect('public demo-chat -> 200', r.status === 200);
  expect('  has reply', typeof r.body.reply === 'string' && r.body.reply.length > 5);
  expect('  runtime=demo', r.body.runtime === 'demo');
}

// 6b. Customer submits payment/activation proof
{
  const reviewed = await req(`/api/workers/${firstWorkerId}`, {
    method: 'PATCH', headers: auth(),
    body: JSON.stringify({ knowledge: REVIEWED_SALES_KNOWLEDGE, knowledgeReviewed: true }),
  });
  expect('review business knowledge before activation', reviewed.status === 200 && reviewed.body.ok === true);
}
{
  const r = await req(`/api/workers/${firstWorkerId}/activation-request`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ channel: 'paypal', reference: 'PP-X1-PAID', contact: 'buyer@example.com', note: 'Paid for first worker' }),
  });
  expect('activation request -> 200', r.status === 200 && r.body.ok === true);
  expect('  request id returned', !!r.body.requestId);
  activationRequestId = r.body.requestId;
}
{
  const r = await req('/api/admin/activation-requests?status=pending', { headers: adminAuth });
  expect('admin list activation requests -> 200', r.status === 200);
  expect('  pending request visible', !!r.body.requests?.find((x) => x.id === activationRequestId));
}

// 7. Admin marks the worker paid
let mismatchedActivationRequestId = null;
{
  const otherTenant = await req('/admin/issue-key', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ channel: 'manual', reference: 'MISMATCH-REQ', label: 'Mismatched activation request tenant' }),
  });
  crossTenantId = otherTenant.body.tenantId;
  crossTenantKey = otherTenant.body.key;
  const otherAuth = { authorization: 'Bearer ' + otherTenant.body.key, 'content-type': 'application/json' };
  const otherBuy = await req('/api/workers/buy', {
    method: 'POST', headers: otherAuth,
    body: JSON.stringify({ templateId: 'support-he' }),
  });
  crossTenantWorkerId = otherBuy.body.workerId;
  const tenantClaim = await req(`/api/workers/${firstWorkerId}/whatsapp-route`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ provider: 'meta', phoneNumberId: 'meta-route-ownership-test' }),
  });
  expect('tenant cannot self-claim an unverified inbound WhatsApp route', tenantClaim.status === 403
    && tenantClaim.body.error === 'admin_provisioning_required');
  const firstRoute = await req('/api/admin/whatsapp-route', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({
      tenantId,
      workerId: firstWorkerId,
      provider: 'meta',
      phoneNumberId: 'meta-route-ownership-test',
    }),
  });
  expect('admin can provision a verified WhatsApp route', firstRoute.status === 200
    && firstRoute.body.ok === true
    && firstRoute.body.idempotent === false);
  const repeatedRoute = await req('/api/admin/whatsapp-route', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({
      tenantId,
      workerId: firstWorkerId,
      provider: 'meta',
      phoneNumberId: 'meta-route-ownership-test',
    }),
  });
  expect('same tenant and worker route provisioning is idempotent', repeatedRoute.status === 200
    && repeatedRoute.body.ok === true
    && repeatedRoute.body.idempotent === true);
  const takeover = await req('/api/admin/whatsapp-route', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({
      tenantId: otherTenant.body.tenantId,
      workerId: otherBuy.body.workerId,
      provider: 'meta',
      phoneNumberId: 'meta-route-ownership-test',
    }),
  });
  expect('cross-tenant WhatsApp route claim is rejected without replacing the owner', takeover.status === 409
    && takeover.body.error === 'route_already_claimed');
  const otherReq = await req(`/api/workers/${otherBuy.body.workerId}/activation-request`, {
    method: 'POST', headers: otherAuth,
    body: JSON.stringify({ channel: 'paypal', reference: 'OTHER-PAID', contact: 'other@example.com' }),
  });
  mismatchedActivationRequestId = otherReq.body.requestId;
  const r = await req('/api/admin/mark-worker-paid', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ workerId: firstWorkerId, tenantId, days: 30, paymentChannel: 'paypal', paymentReference: 'PP-X1-PAID', activationRequestId: mismatchedActivationRequestId }),
  });
  expect('admin mark-paid rejects mismatched activation request', r.status === 400 && r.body.error === 'activation_request_mismatch');
  const pending = await req('/api/admin/activation-requests?status=pending', { headers: adminAuth });
  expect('  mismatched activation request stays pending', !!pending.body.requests?.find((x) => x.id === mismatchedActivationRequestId));
  const firstWorker = await req(`/api/workers/${firstWorkerId}`, { headers: auth() });
  expect('  mismatched activation does not activate worker', firstWorker.body.worker?.isActive === false);
}
{
  const r = await req('/api/admin/mark-worker-paid', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ workerId: firstWorkerId, tenantId: 'ignored-for-now', days: 30, paymentChannel: 'paypal', paymentReference: 'PP-X1-PAID' }),
  });
  // The admin endpoint needs the stable tenantId issued with the key.
  expect('admin mark-paid wrong tenant -> fails', !r.body?.ok);
}
{
  const r = await req('/api/admin/mark-worker-paid', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ workerId: firstWorkerId, tenantId, days: 30, paymentChannel: 'paypal', paymentReference: 'PP-X1-PAID', activationRequestId }),
  });
  expect('admin mark-paid correct tenant -> ok', r.status === 200 && r.body?.ok === true);
  expect('  paidUntil set', !!r.body?.paidUntil);
  expect('  paidUntil is in future', new Date(r.body.paidUntil) > new Date());
  expect('  ready worker is not held for setup', r.body.activationPendingSetup === false && r.body.readiness?.ready === true);
}
{
  const r = await req('/api/admin/activation-requests?status=pending', { headers: adminAuth });
  expect('  activation request no longer pending', !r.body.requests?.find((x) => x.id === activationRequestId));
}
{
  const r = await req('/api/admin/audit-events?limit=30', { headers: adminAuth });
  const events = r.body.events ?? [];
  expect('admin audit includes mismatched activation request failure', events.some((e) => e.action === 'admin_mark_worker_paid' && e.status === 'failed' && e.metadata?.activationRequestId === mismatchedActivationRequestId));
  expect('admin audit includes failed mark-paid attempt', events.some((e) => e.action === 'admin_mark_worker_paid' && e.status === 'failed' && e.targetId === firstWorkerId));
  expect('admin audit includes successful mark-paid', events.some((e) => e.action === 'admin_mark_worker_paid' && e.status === 'ok' && e.targetId === firstWorkerId));
  expect('  mark-paid audit keeps activation id', events.some((e) => e.metadata?.activationRequestId === activationRequestId));
}

// 7b. Paddle checkout + webhook auto-activation
{
  const buy = await req('/api/workers/buy', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ templateId: 'data-entry' }),
  });
  paddleWorkerId = buy.body.workerId;
  const blockedCfg = await req('/api/paddle/checkout', {
    method: 'POST', headers: auth(), body: JSON.stringify({ workerId: paddleWorkerId }),
  });
  expect('Paddle checkout blocks unreviewed placeholder knowledge', blockedCfg.status === 409
    && blockedCfg.body.error === 'worker_not_ready_for_checkout');
  const reviewed = await req(`/api/workers/${paddleWorkerId}`, {
    method: 'PATCH', headers: auth(),
    body: JSON.stringify({
      knowledge: 'מסמכי קלט נתמכים: חשבוניות, כרטיסי ביקור וטפסים. הפלט כולל JSON ושורת CSV, ושדות חסרים מסומנים כ-null.',
      knowledgeReviewed: true,
    }),
  });
  expect('review Paddle worker knowledge before checkout', reviewed.status === 200 && reviewed.body.ok === true);
  const cfg = await req('/api/paddle/checkout', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ workerId: paddleWorkerId }),
  });
  expect('POST /api/paddle/checkout -> 200', cfg.status === 200 && cfg.body.ok === true);
  expect('  returns client token + server-created transactionId', !!cfg.body.clientToken && cfg.body.transactionId?.startsWith('txn_'));
  expect('  checkout response exposes no tenant/worker customData authority', cfg.body.customData === undefined
    && cfg.body.priceId === undefined
    && !JSON.stringify(cfg.body).includes(tenantId));
  const invoice = await req(`/invoice/${paddleWorkerId}`);
  expect('  public worker invoice does not leak tenant id', invoice.status === 200 && !String(invoice.body).includes(tenantId));
  let dataEntryPriceId = 'pri_test_data_entry';
  try { dataEntryPriceId = JSON.parse(process.env.PADDLE_PRICE_MAP ?? '{}')['data-entry'] || dataEntryPriceId; } catch {}
  const secret = process.env.PADDLE_WEBHOOK_SECRET ?? '';
  if (secret) {
    const signedPaddleEvent = async (event, timestamp = Math.floor(Date.now() / 1000)) => {
      const body = JSON.stringify(event);
      const sig = crypto.createHmac('sha256', secret).update(`${timestamp}:${body}`).digest('hex');
      return req('/api/webhooks/paddle', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'paddle-signature': `ts=${timestamp};h1=${sig}` },
        body,
      });
    };
    const victimAuth = {
      authorization: 'Bearer ' + crossTenantKey,
      'content-type': 'application/json',
    };
    const victimBefore = await req(`/api/workers/${crossTenantWorkerId}`, { headers: victimAuth });
    expect('cross-tenant Paddle victim starts unchanged', victimBefore.status === 200
      && victimBefore.body.worker?.isActive === false
      && victimBefore.body.worker?.paused === false);

    const forgedTransaction = await signedPaddleEvent({
      event_id: 'evt_paddle_forged_transaction',
      event_type: 'transaction.completed',
      data: {
        id: 'txn_forged_unmapped',
        status: 'completed',
        currency_code: 'ILS',
        items: [{ price: { id: dataEntryPriceId }, quantity: 1 }],
        details: { totals: { total: '19900' } },
        custom_data: { worker_id: crossTenantWorkerId, tenant_id: crossTenantId },
      },
    });
    expect('forged Paddle custom_data cannot activate an unmapped cross-tenant worker', forgedTransaction.status === 400
      && forgedTransaction.body.error === 'paddle_target_unmapped');

    const forgedPause = await signedPaddleEvent({
      event_id: 'evt_paddle_forged_pause',
      event_type: 'subscription.paused',
      data: {
        id: 'sub_forged_unmapped',
        custom_data: { worker_id: crossTenantWorkerId, tenant_id: crossTenantId },
      },
    });
    expect('forged Paddle custom_data cannot suspend an unmapped cross-tenant worker', forgedPause.status === 400
      && forgedPause.body.error === 'paddle_target_unmapped');

    const forgedRefund = await signedPaddleEvent({
      event_id: 'evt_paddle_forged_refund',
      event_type: 'adjustment.updated',
      data: {
        id: 'adj_forged',
        action: 'refund',
        status: 'approved',
        transaction_id: 'txn_forged_unmapped',
        custom_data: { worker_id: crossTenantWorkerId, tenant_id: crossTenantId },
      },
    });
    expect('forged refund cannot suspend an unmapped cross-tenant worker', forgedRefund.status === 400
      && forgedRefund.body.error === 'paddle_target_unmapped');
    const victimAfterForgeries = await req(`/api/workers/${crossTenantWorkerId}`, { headers: victimAuth });
    expect('  forged Paddle lifecycle events leave victim tenant untouched', victimAfterForgeries.body.worker?.isActive === false
      && victimAfterForgeries.body.worker?.paused === false);

    const subscriptionBody = JSON.stringify({
      event_id: 'evt_paddle_subscription_test',
      event_type: 'subscription.created',
      data: {
        id: 'sub_test_1',
        transaction_id: cfg.body.transactionId,
        customer_id: 'ctm_test_authoritative',
        custom_data: { worker_id: crossTenantWorkerId, tenant_id: crossTenantId },
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const subscriptionSig = crypto.createHmac('sha256', secret).update(`${ts}:${subscriptionBody}`).digest('hex');
    const subscriptionWh = await req('/api/webhooks/paddle', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'paddle-signature': `ts=${ts};h1=${subscriptionSig}` },
      body: subscriptionBody,
    });
    expect('Paddle subscription event is accepted but ignored', subscriptionWh.status === 200
      && subscriptionWh.body.ignored === true
      && subscriptionWh.body.reason === 'activation_requires_completed_transaction');
    const pendingWorker = await req(`/api/workers/${paddleWorkerId}`, { headers: auth() });
    expect('  subscription event alone cannot activate worker', pendingWorker.body.worker?.isActive === false);

    const transactionBody = JSON.stringify({
      event_id: 'evt_paddle_transaction_test',
      event_type: 'transaction.completed',
      data: {
        id: cfg.body.transactionId,
        status: 'completed',
        subscription_id: 'sub_test_1',
        customer_id: 'ctm_test_authoritative',
        currency_code: 'ILS',
        items: [{ price: { id: dataEntryPriceId }, quantity: 1 }],
        details: { totals: { total: '19900' } },
        custom_data: { worker_id: crossTenantWorkerId, tenant_id: crossTenantId },
      },
    });
    const transactionSig = crypto.createHmac('sha256', secret).update(`${ts}:${transactionBody}`).digest('hex');
    const wh = await req('/api/webhooks/paddle', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'paddle-signature': `ts=${ts};h1=${transactionSig}` },
      body: transactionBody,
    });
    expect('completed Paddle transaction webhook -> 200', wh.status === 200 && wh.body.ok === true);
    expect('  completed exact-price transaction auto-activates worker', wh.body.autoActivated === true);
    const w = await req(`/api/workers/${paddleWorkerId}`, { headers: auth() });
    expect('  worker active after paddle', w.body.worker?.isActive === true);
    const victimAfterActivation = await req(`/api/workers/${crossTenantWorkerId}`, { headers: victimAuth });
    expect('  forged custom_data on mapped transaction cannot redirect activation', victimAfterActivation.body.worker?.isActive === false
      && victimAfterActivation.body.worker?.paused === false);
    const paidUntil = w.body.worker?.paidUntil;

    const replay = await req('/api/webhooks/paddle', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'paddle-signature': `ts=${ts};h1=${transactionSig}` },
      body: transactionBody,
    });
    const afterReplay = await req(`/api/workers/${paddleWorkerId}`, { headers: auth() });
    expect('  replayed Paddle transaction is idempotent', replay.status === 200
      && replay.body.alreadyRecorded === true
      && afterReplay.body.worker?.paidUntil === paidUntil);

    const mappedPause = await signedPaddleEvent({
      event_id: 'evt_paddle_mapped_pause',
      event_type: 'subscription.paused',
      data: {
        id: 'sub_test_1',
        customer_id: 'ctm_test_authoritative',
        custom_data: { worker_id: crossTenantWorkerId, tenant_id: crossTenantId },
      },
    });
    const pausedPaddleWorker = await req(`/api/workers/${paddleWorkerId}`, { headers: auth() });
    const victimAfterMappedPause = await req(`/api/workers/${crossTenantWorkerId}`, { headers: victimAuth });
    expect('mapped subscription pause suspends only its server-mapped worker', mappedPause.status === 200
      && mappedPause.body.suspended === true
      && pausedPaddleWorker.body.worker?.paused === true
      && victimAfterMappedPause.body.worker?.paused === false);
  }
}

// 8b. Rotate API key without losing tenant data
{
  const r = await req('/api/account/rotate-key', { method: 'POST', headers: auth() });
  expect('rotate API key -> 200', r.status === 200 && r.body.ok === true);
  expect('  rotation preserves tenant id', r.body.tenantId === tenantId);
  const oldKey = tenantKey;
  tenantKey = r.body.key;
  const oldAuthCheck = await req('/api/workers', { headers: { authorization: 'Bearer ' + oldKey, 'content-type': 'application/json' } });
  expect('  old key revoked', oldAuthCheck.status === 401);
  const newAuthCheck = await req('/api/workers', { headers: auth() });
  expect('  new key still sees worker', newAuthCheck.status === 200 && newAuthCheck.body.workers?.some((w) => w.id === firstWorkerId));
}

// 8c. Admin can recover a lost tenant key without losing tenant data
{
  const oldKey = tenantKey;
  const r = await req('/api/admin/replace-tenant-key', {
    method: 'POST',
    headers: adminAuth,
    body: JSON.stringify({ tenantId, label: 'Recovered tenant key' }),
  });
  expect('admin replace tenant key -> 200', r.status === 200 && r.body.ok === true);
  expect('  replacement preserves tenant id', r.body.tenantId === tenantId);
  tenantKey = r.body.key;
  const oldAuthCheck = await req('/api/workers', { headers: { authorization: 'Bearer ' + oldKey, 'content-type': 'application/json' } });
  expect('  recovered old key revoked', oldAuthCheck.status === 401);
  const newAuthCheck = await req('/api/workers', { headers: auth() });
  expect('  recovered key sees worker', newAuthCheck.status === 200 && newAuthCheck.body.workers?.some((w) => w.id === firstWorkerId));
}
{
  const r = await req('/api/admin/audit-events?limit=40', { headers: adminAuth });
  const events = r.body.events ?? [];
  expect('admin audit includes tenant key recovery', events.some((e) => e.action === 'admin_replace_tenant_key' && e.status === 'ok' && e.targetId === tenantId));
  expect('  recovery audit does not expose recovered key', !JSON.stringify(events).includes(tenantKey));
}

// 8. List now shows active
{
  const r = await req('/api/workers', { headers: auth() });
  const w = r.body.workers?.find((worker) => worker.id === firstWorkerId);
  expect('worker status=active after payment', w?.status === 'active');
  expect('worker isActive=true', w?.isActive === true);
}

// 9. Get single worker config
{
  const r = await req(`/api/workers/${firstWorkerId}`, { headers: auth() });
  expect('GET /api/workers/:id -> 200', r.status === 200);
  expect('  persona non-empty', r.body.worker?.persona?.length > 50);
  expect('  tasks array non-empty', r.body.worker?.tasks?.length >= 3);
  expect('  starter worker name is Hebrew-first', /מוקדן|ישראלי/.test(r.body.worker?.name ?? ''));
  expect('  starter tasks are business-owner friendly Hebrew', /עברית|לאסוף/.test(r.body.worker?.tasks?.[0] ?? ''));
  expect('  reviewed business knowledge is present', String(r.body.worker?.knowledge).includes('אקמי פתרונות'));
  expect('  llm.provider = mock by default', r.body.worker?.llm?.provider === 'mock');
  expect('  llm.hasApiKey = false', r.body.worker?.llm?.hasApiKey === false);
  expect('  never returns apiKey value', r.body.worker?.llm?.apiKey === undefined);
  expect('  single worker exposes isActive=true', r.body.worker?.isActive === true);
  expect('  agentMode defaults to agent', r.body.worker?.agentMode === 'agent');
}

// 10. Update worker (Builder PATCH)
{
  const r = await req(`/api/workers/${firstWorkerId}`, {
    method: 'PATCH', headers: auth(),
    body: JSON.stringify({
      name: 'Daniel - Acme Corp',
      knowledge: 'Acme Corp sells verified workflow software in Israel. Pricing is confirmed by a representative after requirements review. Support contact: help@acme.co.il.',
      knowledgeReviewed: true,
      tasks: ['Greet', 'Qualify', 'Book meeting'],
    }),
  });
  expect('PATCH worker -> 200', r.status === 200 && r.body.ok === true);
}
{
  const r = await req(`/api/workers/${firstWorkerId}`, { headers: auth() });
  expect('  name updated', r.body.worker?.name === 'Daniel - Acme Corp');
  expect('  tasks updated', r.body.worker?.tasks?.length === 3);
  expect('  knowledge updated', r.body.worker?.knowledge?.includes('Acme Corp'));
}
{
  const r = await req(`/api/workers/${firstWorkerId}`, {
    method: 'PATCH', headers: auth(),
    body: JSON.stringify({ agentMode: 'agent', tools: ['save_lead', 'book_meeting_link', 'export_leads_csv'] }),
  });
  expect('PATCH agentMode + tools -> 200', r.status === 200 && r.body.ok === true);
}
{
  const r = await req('/api/workers/tools', { headers: auth() });
  expect('GET /api/workers/tools -> 200', r.status === 200);
  expect('  has save_lead tool', !!r.body.tools?.find((t) => t.name === 'save_lead'));
  expect('  save_lead has score param', !!r.body.tools?.find((t) => t.name === 'save_lead')?.parameters?.properties?.score);
}

// 11. Chat (mock runtime) — should succeed and produce a mock-flavored reply
{
  const r = await req(`/api/workers/${firstWorkerId}/chat`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ message: 'Who are you?', customerId: primaryCustomerId }),
  });
  expect('chat -> 200', r.status === 200);
  expect('  reply non-empty', r.body?.reply?.length > 20);
  expect('  runtime mock or mock_agent', r.body?.runtime === 'mock' || r.body?.runtime === 'mock_agent');
  expect('  reply mentions Daniel template', /Daniel|mock/i.test(r.body.reply));
  expect('  response has agentMode', r.body.agentMode === 'agent');
  expect('  response has agentSteps array', Array.isArray(r.body.agentSteps));
}

// 12. Messages list
{
  const missingCustomer = await req(`/api/workers/${firstWorkerId}/messages`, { headers: auth() });
  expect('GET messages requires customerId', missingCustomer.status === 400 && missingCustomer.body.error === 'customerId_required');
  const r = await req(`/api/workers/${firstWorkerId}/messages?customerId=${encodeURIComponent(primaryCustomerId)}`, { headers: auth() });
  expect('GET messages -> 200', r.status === 200);
  expect('  has only 2 persisted messages (demo/stream are planning-only)', r.body.messages?.length === 2);
  expect('  first role=user', r.body.messages?.[0]?.role === 'user');
  expect('  second role=assistant', r.body.messages?.[1]?.role === 'assistant');
}

// 13. Second chat — context preserved
{
  const r = await req(`/api/workers/${firstWorkerId}/chat`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ message: 'How much does it cost?', customerId: primaryCustomerId }),
  });
  expect('chat #2 -> 200', r.status === 200);
  expect('  pricing reply', /pricing|plan|quote|מחיר|quote/i.test(r.body.reply));
}
{
  const r = await fetch(BASE + `/api/workers/${firstWorkerId}/chat/stream`, {
    method: 'POST',
    headers: { ...auth(), accept: 'text/event-stream' },
    body: JSON.stringify({ message: 'בדיקת סטרים פעילה', customerId: 'live-sse-customer' }),
  });
  const text = await r.text();
  expect('active chat stream -> 200', r.status === 200);
  expect('  active SSE token events', text.includes('event: token'));
  expect('  active SSE done event', text.includes('event: done'));
}
{
  const r = await req(`/api/workers/${firstWorkerId}/test-agent`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ message: 'שלום, שמי יוסי, טלפון 050-9876543, מעוניין בפגישה', customerId: 'test-cust-1' }),
  });
  expect('test-agent -> 200', r.status === 200);
  expect('  test-agent returns toolCalls array', Array.isArray(r.body.toolCalls));
  expect('  test-agent returns agentSteps', Array.isArray(r.body.agentSteps) && r.body.agentSteps.length >= 1);
  expect('  mock agent runtime', r.body.runtime === 'mock_agent' || r.body.runtime === 'mock');
  const leads = await req(`/api/workers/${firstWorkerId}/leads`, { headers: auth() });
  expect('  test-agent may save lead', leads.status === 200);
}
{
  const r = await req(`/api/workers/${firstWorkerId}/messages?customerId=${encodeURIComponent(primaryCustomerId)}`, { headers: auth() });
  expect('  now 4 messages (test-agent is planning-only)', r.body.messages?.length === 4);
}
{
  const account = await req('/api/account', { headers: auth() });
  expect('monthly quota counts live and preview calls', account.status === 200
    && account.body.callsUsed === 5
    && account.body.callsRemaining === account.body.callsLimit - 5);
}

// 14. Per-tenant isolation: another tenant cannot see this worker
let otherTenantKey = null;
{
  const r = await req('/admin/issue-key', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ channel: 'bit', reference: 'BIT-OTHER', label: 'Other tenant' }),
  });
  otherTenantKey = r.body.key;
  expect('issue second tenant key', !!otherTenantKey);
}
{
  const r = await req(`/api/workers/${firstWorkerId}`, { headers: { authorization: 'Bearer ' + otherTenantKey, 'content-type': 'application/json' } });
  expect('other tenant GET -> 404 (isolation)', r.status === 404);
}
{
  const r = await req(`/api/workers`, { headers: { authorization: 'Bearer ' + otherTenantKey, 'content-type': 'application/json' } });
  expect('other tenant list -> empty', r.body.workers?.length === 0);
}

// 15. No auth -> 401
{
  const r = await req('/api/workers');
  expect('GET /api/workers without auth -> 401', r.status === 401);
}
{
  const r = await req('/api/workers', { headers: { authorization: 'Bearer not-a-real-key' } });
  expect('GET /api/workers with non-sk key -> 401', r.status === 401);
}

// 16. Admin listing across all tenants
{
  const r = await req('/api/admin/workers', { headers: adminAuth });
  expect('admin list workers -> 200', r.status === 200);
  expect('  at least 1 worker visible', r.body.workers?.length >= 1);
}

// 17. Delete workers
{
  const r = await req(`/api/workers/${firstWorkerId}`, { method: 'DELETE', headers: auth() });
  expect('DELETE worker -> 200', r.status === 200 && r.body.ok === true);
}
if (paddleWorkerId) {
  const r = await req(`/api/workers/${paddleWorkerId}`, { method: 'DELETE', headers: auth() });
  expect('DELETE paddle worker -> 200', r.status === 200 && r.body.ok === true);
}
{
  const r = await req(`/api/workers/${firstWorkerId}`, { headers: auth() });
  expect('  subsequent GET -> 404', r.status === 404);
}
{
  const r = await req('/api/workers', { headers: auth() });
  expect('  list back to empty', r.body.workers?.length === 0);
}

// 18. Create from template via POST /api/workers (Builder "new" flow)
let newWorkerId = null;
{
  const r = await req('/api/workers', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      templateId: 'data-entry',
      name: 'Acme Data Clerk',
      persona: 'You extract structured fields from text.',
      tasks: ['Identify doc type', 'Extract fields', 'Return JSON'],
      knowledge: 'Schema: {customer, amount, date}',
      llm: { provider: 'mock', model: '', baseUrl: '' },
    }),
  });
  expect('POST /api/workers (new) -> 200', r.status === 200);
  newWorkerId = r.body.workerId;
}
{
  const r = await req(`/api/workers/${newWorkerId}`, { headers: auth() });
  expect('  name from builder applied', r.body.worker?.name === 'Acme Data Clerk');
  expect('  persona from builder applied', r.body.worker?.persona?.includes('extract structured'));
  expect('  tasks from builder applied', r.body.worker?.tasks?.length === 3);
}

// 19. Workers HTML pages serve the SPA
{
  const r = await req('/workers/anything/here');
  expect('GET /workers/foo/bar -> 200 HTML', r.status === 200);
  expect('  serves same SPA', String(r.body).includes('שוק העובדים'));
}

// 21. Unknown template id -> 400
{
  const r = await req('/api/workers/buy', { method: 'POST', headers: auth(), body: JSON.stringify({ templateId: 'nope' }) });
  expect('buy unknown template -> 400', r.status === 400);
  expect('  error=unknown_template', r.body.error === 'unknown_template');
}

// 22. Media tools (mock mode — no GOOGLE_AI_API_KEY in test env)
{
  const r = await req('/api/workers/tools', { headers: auth() });
  expect('  has generate_image tool', !!r.body.tools?.find((t) => t.name === 'generate_image'));
  expect('  has generate_video tool', !!r.body.tools?.find((t) => t.name === 'generate_video'));
}
let mediaWorkerId = null;
{
  const r = await req('/api/workers', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      templateId: 'social-media-creator-he',
      name: 'Social Test',
      tools: ['generate_image', 'generate_video'],
      agentMode: 'agent',
      knowledge: 'שם המותג: Social Test. קהל היעד: עסקים בישראל. קול המותג: מקצועי וידידותי. כל פרסום דורש אישור מפורש של בעל העסק.',
      knowledgeReviewed: true,
    }),
  });
  expect('POST social-media-creator-he -> 200', r.status === 200);
  mediaWorkerId = r.body.workerId;
}
{
  const r = await req('/api/admin/mark-worker-paid', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ workerId: mediaWorkerId, tenantId, days: 30 }),
  });
  expect('mark media worker paid -> ok', r.status === 200 && r.body?.ok === true);
}
{
  const r = await req(`/api/workers/${mediaWorkerId}/test-agent`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ message: 'צור תמונה לפוסט אינסטגרם על קפה בתל אביב', customerId: 'media-test' }),
  });
  expect('test-agent image request -> 200', r.status === 200);
  expect('  image tool is planned without execution', (r.body.toolCalls ?? []).some((t) => (
    t.name === 'generate_image' && t.planned === true && t.meta?.dryRun === true
  )));
  expect('  customer reply hides dry-run traces', !/dry-run|planned agent actions|trace|mock/i.test(r.body.reply ?? ''));
}
{
  const r = await req('/api/workers/buy', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ templateId: 'content-he' }),
  });
  const w = r.body.workerId;
  await req('/api/admin/mark-worker-paid', { method: 'POST', headers: adminAuth, body: JSON.stringify({ workerId: w, tenantId, days: 30 }) });
  const cfg = await req(`/api/workers/${w}`, { headers: auth() });
  expect('content-he has generate_image in default tools', (cfg.body.worker?.tools ?? []).includes('generate_image'));
}
{
  const blocked = await req(`/api/workers/${mediaWorkerId}/test-agent`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ message: 'generate nude nsfw image', customerId: 'nsfw-test' }),
  });
  const toolRes = (blocked.body.toolCalls ?? []).find((t) => t.name === 'generate_image');
  const blockedStep = (blocked.body.agentSteps ?? []).find((step) => step.phase === 'blocked' && step.reason === 'unsafe_media_request');
  expect('NSFW prompt blocked with no generation plan', blocked.status === 200 && !toolRes && !!blockedStep);
}
{
  const { generateImage, isMediaMockMode } = await import('./google-media.js');
  expect('google-media mock mode without API key', isMediaMockMode());
  const img = await generateImage({ prompt: 'קפה ישראלי', aspectRatio: '1:1' });
  expect('  mock generateImage returns dataUrl svg', !!img.mock && String(img.dataUrl).includes('image/svg'));
}

// Integrations hub
{
  const r = await req('/api/integrations/catalog');
  expect('GET /api/integrations/catalog -> 200', r.status === 200);
  expect('  catalog has webhook + mcp', (r.body.catalog ?? []).some((c) => c.type === 'webhook') && (r.body.catalog ?? []).some((c) => c.type === 'mcp'));
  expect('  Hebrew labels present', (r.body.catalog ?? []).every((c) => c.labelHe && c.descriptionHe));
  expect('  Shopify normalizer canonicalizes a valid shop', normalizeShopifyShopHost(' HTTPS://Demo-Store.MyShopify.com/ ') === 'demo-store.myshopify.com');
}
{
  const r = await req('/api/integrations', { headers: auth() });
  expect('GET /api/integrations empty -> 200', r.status === 200 && Array.isArray(r.body.integrations));
}
let integrationId = null;
{
  const r = await req('/api/integrations', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      type: 'google_calendar',
      config: { bookingLink: 'https://cal.com/demo-clinic' },
    }),
  });
  expect('POST calendar integration -> 201/200', r.status === 201 || r.status === 200);
  integrationId = r.body.id || r.body.integration?.id;
  expect('  integration id returned', !!integrationId);
  expect('  secrets not in list response', !JSON.stringify(r.body).includes('cal.com') || r.body.integration?.config?.bookingLink === 'https://cal.com/demo-clinic');
}
{
  const r = await req('/api/integrations', { headers: auth() });
  const row = (r.body.integrations ?? []).find((i) => i.type === 'google_calendar');
  expect('  calendar connected in list', !!row && row.status === 'connected');
  expect('  booking link visible (non-secret)', row?.config?.bookingLink === 'https://cal.com/demo-clinic');
}
{
  const r = await req(`/api/integrations/${integrationId}/test`, { method: 'POST', headers: auth() });
  expect('POST integration test calendar -> 200', r.status === 200 && r.body.ok === true);
}
{
  const r = await req('/api/integrations/connect', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ type: 'webhook' }),
  });
  expect('POST connect webhook generates hookUrl -> 201/200', r.status === 201 || r.status === 200);
  expect('  hookUrl returned', !!r.body.hookUrl || !!r.body.integration?.config?.hookUrl);
}
{
  const r = await req('/api/integrations/connect', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ type: 'shopify', config: { shopDomain: 'attacker.example', accessToken: 'tenant-shop-token' } }),
  });
  expect('POST Shopify connect rejects custom host', r.status === 400 && r.body.error === 'invalid_shop_domain');
}
{
  const r = await req('/api/integrations', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      type: 'shopify',
      config: { authMethod: 'oauth', shopDomain: 'store.myshopify.com.attacker.example', accessToken: 'tenant-shop-token' },
    }),
  });
  expect('POST direct Shopify integration cannot bypass host validation', r.status === 400 && r.body.error === 'invalid_shop_domain');
}
{
  const r = await req('/api/integrations/connect', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      type: 'shopify',
      config: { shopDomain: 'HTTPS://Manual-Store.MyShopify.com/', accessToken: 'tenant-shop-token' },
    }),
  });
  expect('POST Shopify connect accepts canonical myshopify.com host', (r.status === 200 || r.status === 201) && r.body.integration?.config?.shopDomain === 'manual-store.myshopify.com');
}
{
  const apiKeyStart = await req('/api/integrations/oauth/start', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ type: 'shopify', extra: { shop: ' HTTPS://OAuth-Store.MyShopify.com/ ' } }),
  });
  expect('tenant API key cannot initiate browser OAuth account linking', apiKeyStart.status === 401
    && apiKeyStart.body.error === 'owner_session_required');
}
{
  const r = await req('/api/integrations/catalog');
  expect('  catalog has authMethod on items', (r.body.catalog ?? []).every((c) => c.authMethod && c.connectLabelHe));
}
{
  const r = await req('/api/integrations', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ type: 'webhook', config: { url: 'http://127.0.0.1/hook' } }),
  });
  expect('POST webhook blocks private URL', r.status === 400 && (r.body.error === 'unsafe_url' || r.body.reason));
}
{
  const cases = [
    {
      name: 'metadata webhook URL',
      path: '/api/integrations/connect',
      type: 'webhook',
      config: { url: 'http://169.254.169.254/latest/meta-data' },
      field: 'url',
    },
    {
      name: 'WooCommerce siteUrl',
      path: '/api/integrations/connect',
      type: 'woocommerce',
      config: { siteUrl: 'http://127.0.0.1:8080', consumerKey: 'ck_test', consumerSecret: 'cs_test' },
      field: 'siteUrl',
    },
    {
      name: 'IPv6 unique-local bookingLink',
      path: '/api/integrations/connect',
      type: 'google_calendar',
      config: { bookingLink: 'http://[fc00::1]/book' },
      field: 'bookingLink',
    },
    {
      name: 'IPv6 link-local bookingLink',
      path: '/api/integrations',
      type: 'google_calendar',
      config: { bookingLink: 'http://[fe80::1]/book' },
      field: 'bookingLink',
    },
    {
      name: 'Bit notifyUrl alias',
      path: '/api/integrations',
      type: 'bit_notify',
      config: { notifyUrl: 'http://169.254.169.254/notify', bitPhone: '972501234567' },
      field: 'notifyUrl',
    },
    {
      name: 'Google Sheets exportWebhook runtime alias',
      path: '/api/integrations',
      type: 'google_sheets',
      config: { exportWebhook: 'http://127.0.0.1/export' },
      field: 'exportWebhook',
    },
    {
      name: 'provider baseUrl alias',
      path: '/api/integrations/connect',
      type: 'mcp',
      config: { authMethod: 'oauth', baseUrl: 'http://127.0.0.1/base' },
      field: 'baseUrl',
    },
  ];
  for (const item of cases) {
    const r = await req(item.path, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ type: item.type, config: item.config }),
    });
    expect(
      `POST integration rejects ${item.name} before persistence`,
      r.status === 400 && r.body.error === 'unsafe_url' && r.body.field === item.field,
      JSON.stringify(r.body),
    );
  }
}
{
  const r = await req(`/api/integrations/${integrationId}`, { method: 'DELETE', headers: auth() });
  expect('DELETE integration -> 200', r.status === 200 && r.body.ok === true);
}
{
  const r = await req('/health');
  expect('health reports integrations catalog count', typeof r.body.integrationsCatalog === 'number' && r.body.integrationsCatalog >= 10);
  expect('health reports whatsapp status', r.body.whatsapp && typeof r.body.whatsapp.enabled === 'boolean');
  expect('health reports payment config', r.body.payment && typeof r.body.payment.autoVerifyEnabled === 'boolean');
  expect('health statusHe in Hebrew', r.body.statusHe === 'צריך הגדרה' || r.body.statusHe === 'מוכן לעבודה');
}
{
  const r = await req(`/invoice/${mediaWorkerId}`);
  expect('GET /invoice/:workerId -> 200 html', r.status === 200 && String(r.body).includes('חשבונית'));
  expect('  order summary is not presented as a tax invoice', String(r.body).includes('סיכום הזמנה') && String(r.body).includes('אינו חשבונית מס'));
  expect('  order summary mentions VAT placeholder', String(r.body).includes('מע"מ'));
  expect('  active order summary reflects active access', String(r.body).includes('פעיל עד'));
}
{
  const r = await req('/embed.js');
  expect('GET /embed.js -> 200 js', r.status === 200 && String(r.body).includes('aiw-embed-root'));
  expect('  embed script never reads a tenant data-key', !String(r.body).includes("getAttribute('data-key')") && !String(r.body).includes("'Bearer ' + apiKey"));
}
{
  const origin = 'https://customer-site.example';
  const cfg = await req(`/api/embed/config?workerId=${mediaWorkerId}`, {
    headers: { origin },
  });
  expect('GET /api/embed/config -> 200', cfg.status === 200 && cfg.body.workerId === mediaWorkerId);
  expect('  embed config reflects Origin CORS', cfg.headers.get('access-control-allow-origin') === origin);
  const deniedOrigin = await req(`/api/embed/config?workerId=${mediaWorkerId}`, { headers: { origin: 'https://evil.example' } });
  expect('  embed config rejects unlisted origin', deniedOrigin.status === 403);

  const session = await req('/api/embed/session', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: mediaWorkerId }),
  });
  expect('POST /api/embed/session -> scoped token', session.status === 201 && session.body?.sessionToken?.startsWith('emb_'));
  const noSession = await req('/api/embed/chat', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'שלום', customerId: 'wa:0500000000' }),
  });
  expect('  embed chat rejects missing scoped session', noSession.status === 401);
  const chat = await req('/api/embed/chat', {
    method: 'POST',
    headers: { origin, authorization: 'Embed ' + session.body.sessionToken, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'שלום', customerId: 'wa:0500000000', workerId: 'wk_wrong' }),
  });
  expect('  scoped embed chat ignores caller identity/scope fields', chat.status === 200 && typeof chat.body?.reply === 'string');
  expect('  public embed response omits internal trace and customer id', !chat.body?.customerId && !chat.body?.agentSteps && !chat.body?.toolCalls);
  const wrongOrigin = await req('/api/embed/chat', {
    method: 'POST',
    headers: { origin: 'https://evil.example', authorization: 'Embed ' + session.body.sessionToken, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'שלום' }),
  });
  expect('  scoped embed token is origin-bound', wrongOrigin.status === 403);

  const secondChat = await req('/api/embed/chat', {
    method: 'POST',
    headers: { origin, authorization: 'Embed ' + session.body.sessionToken, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'בדיקת שימוש שנייה' }),
  });
  const sessionCapped = await req('/api/embed/chat', {
    method: 'POST',
    headers: { origin, authorization: 'Embed ' + session.body.sessionToken, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'ניסיון לרוקן מכסה' }),
  });
  expect('  embed session has a separate hourly abuse budget', secondChat.status === 200
    && sessionCapped.status === 429
    && sessionCapped.body.error === 'embed_abuse_limited');

  const moreSessions = [];
  for (let index = 0; index < 3; index++) {
    moreSessions.push(await req('/api/embed/session', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: mediaWorkerId }),
    }));
  }
  expect('  forged allowed Origin cannot issue unlimited sessions', moreSessions[0].status === 201
    && moreSessions[1].status === 201
    && moreSessions[2].status === 429
    && moreSessions[2].body.error === 'embed_abuse_limited');
}
{
  const r = await req('/api/webhooks/bit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': BIT_WEBHOOK_SECRET },
    body: JSON.stringify({ workerId: 'wk_nonexistent' }),
  });
  expect('bit webhook rejects missing worker', r.status === 400);
}
let paypalWebhookWorkerId = null;
let paypalFirstPaidUntil = null;
{
  const created = await req('/api/workers', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      templateId: 'sales-leads-il',
      name: 'PayPal Signature Worker',
      tools: [],
      knowledge: REVIEWED_SALES_KNOWLEDGE,
      knowledgeReviewed: true,
    }),
  });
  paypalWebhookWorkerId = created.body.workerId;
  expect('create pending PayPal webhook worker', created.status === 200 && !!paypalWebhookWorkerId);
  const pendingSummary = await req(`/invoice/${paypalWebhookWorkerId}`);
  expect('  pending order summary does not claim active access', pendingSummary.status === 200
    && String(pendingSummary.body).includes('ממתין לאימות תשלום')
    && !String(pendingSummary.body).includes('שכירות חודשית · פעיל עד'));
}
{
  const forged = await req('/api/webhooks/paypal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': 'wrong-paypal-signature' },
    body: JSON.stringify({ workerId: paypalWebhookWorkerId, tenantId, payment_status: 'Completed', txn_id: 'FORGED-PAYPAL' }),
  });
  expect('PayPal webhook rejects invalid signature', forged.status === 401 && forged.body.error === 'invalid_webhook_secret');
  const worker = await req(`/api/workers/${paypalWebhookWorkerId}`, { headers: auth() });
  expect('  invalid PayPal signature cannot activate worker', worker.body.worker?.status !== 'active' && !worker.body.worker?.paidUntil);
}
{
  const notCompleted = await req('/api/webhooks/paypal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': PAYPAL_WEBHOOK_SECRET },
    body: JSON.stringify({ workerId: paypalWebhookWorkerId, tenantId, event_type: 'PAYMENT.CAPTURE.DENIED', id: 'DENIED-PAYPAL' }),
  });
  expect('PayPal webhook ignores signed non-completed event', notCompleted.status === 200 && notCompleted.body.ignored === true);
  const worker = await req(`/api/workers/${paypalWebhookWorkerId}`, { headers: auth() });
  expect('  signed non-completed PayPal event cannot activate worker', worker.body.worker?.status !== 'active' && !worker.body.worker?.paidUntil);
}
{
  const wrongAmount = await req('/api/webhooks/paypal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': PAYPAL_WEBHOOK_SECRET },
    body: JSON.stringify({
      workerId: paypalWebhookWorkerId,
      tenantId,
      payment_status: 'Completed',
      txn_id: 'WRONG-AMOUNT-PAYPAL',
      mc_gross: '1.00',
      mc_currency: 'ILS',
    }),
  });
  expect('PayPal webhook rejects a signed amount mismatch', wrongAmount.status === 400 && wrongAmount.body.error === 'payment_amount_mismatch');
  const worker = await req(`/api/workers/${paypalWebhookWorkerId}`, { headers: auth() });
  expect('  amount mismatch cannot activate worker', worker.body.worker?.status !== 'active' && !worker.body.worker?.paidUntil);
}
{
  const verified = await req('/api/webhooks/paypal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': PAYPAL_WEBHOOK_SECRET },
    body: JSON.stringify({
      workerId: paypalWebhookWorkerId,
      tenantId,
      payment_status: 'Completed',
      txn_id: 'VERIFIED-PAYPAL',
      mc_gross: '249.00',
      mc_currency: 'ILS',
    }),
  });
  expect('PayPal webhook activates only after verified signature', verified.status === 200 && verified.body.ok === true && verified.body.autoActivated === true);
  const worker = await req(`/api/workers/${paypalWebhookWorkerId}`, { headers: auth() });
  expect('  verified completed PayPal event activates worker', worker.body.worker?.status === 'active' && !!worker.body.worker?.paidUntil);
  paypalFirstPaidUntil = worker.body.worker?.paidUntil;
}
{
  const renewalPayload = new URLSearchParams({
    workerId: paypalWebhookWorkerId,
    tenantId,
    payment_status: 'Completed',
    txn_id: 'VERIFIED-PAYPAL-RENEWAL',
    mc_gross: '249.00',
    mc_currency: 'ILS',
  }).toString();
  const renewed = await req('/api/webhooks/paypal', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-webhook-secret': PAYPAL_WEBHOOK_SECRET },
    body: renewalPayload,
  });
  expect('PayPal form webhook renews an already-active worker', renewed.status === 200 && renewed.body.autoRenewed === true);
  const afterRenewal = await req(`/api/workers/${paypalWebhookWorkerId}`, { headers: auth() });
  const renewedPaidUntil = afterRenewal.body.worker?.paidUntil;
  expect('  early renewal extends paidUntil', new Date(renewedPaidUntil) > new Date(paypalFirstPaidUntil));

  const replay = await req('/api/webhooks/paypal', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-webhook-secret': PAYPAL_WEBHOOK_SECRET },
    body: renewalPayload,
  });
  const afterReplay = await req(`/api/workers/${paypalWebhookWorkerId}`, { headers: auth() });
  expect('  replayed transaction is idempotent', replay.status === 200
    && replay.body.alreadyRecorded === true
    && afterReplay.body.worker?.paidUntil === renewedPaidUntil);

  const adminReplay = await req('/api/admin/mark-worker-paid', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({
      workerId: paypalWebhookWorkerId,
      tenantId,
      days: 30,
      paymentChannel: 'PayPal',
      paymentReference: 'VERIFIED-PAYPAL-RENEWAL',
      amountIls: 249,
    }),
  });
  const afterAdminReplay = await req(`/api/workers/${paypalWebhookWorkerId}`, { headers: auth() });
  expect('  same PayPal reference stays idempotent across admin/webhook paths and channel casing',
    adminReplay.status === 200
      && adminReplay.body.alreadyRecorded === true
      && afterAdminReplay.body.worker?.paidUntil === renewedPaidUntil);
}
{
  const created = await req('/api/workers', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ templateId: 'sales-leads-il', name: 'Duplicate Reference Worker', tools: [] }),
  });
  const duplicateReferenceWorkerId = created.body.workerId;
  const activation = await req(`/api/workers/${duplicateReferenceWorkerId}/activation-request`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      channel: 'paypal',
      reference: 'VERIFIED-PAYPAL',
      contact: 'duplicate-reference@example.com',
    }),
  });
  const duplicateRequestId = activation.body.requestId;
  const rejected = await req('/api/webhooks/paypal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': PAYPAL_WEBHOOK_SECRET },
    body: JSON.stringify({
      workerId: duplicateReferenceWorkerId,
      tenantId,
      payment_status: 'Completed',
      txn_id: 'VERIFIED-PAYPAL',
      mc_gross: '249.00',
      mc_currency: 'ILS',
    }),
  });
  expect('PayPal reference reuse on another worker is rejected', rejected.status === 400
    && rejected.body.error === 'payment_reference_already_used');
  const pending = await req('/api/admin/activation-requests?status=pending', { headers: adminAuth });
  expect('  failed webhook keeps activation request pending', !!pending.body.requests?.find((x) => x.id === duplicateRequestId));
  const worker = await req(`/api/workers/${duplicateReferenceWorkerId}`, { headers: auth() });
  expect('  failed webhook cannot activate duplicate-reference worker', worker.body.worker?.isActive === false);
}
{
  const victimAuth = { authorization: 'Bearer ' + crossTenantKey, 'content-type': 'application/json' };
  const before = await req(`/api/workers/${crossTenantWorkerId}`, { headers: victimAuth });
  const beforePaidUntil = before.body.worker?.paidUntil;
  const rejected = await req('/api/webhooks/paypal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': PAYPAL_WEBHOOK_SECRET },
    body: JSON.stringify({
      workerId: crossTenantWorkerId,
      tenantId: crossTenantId,
      payment_status: 'Completed',
      txn_id: 'VERIFIED-PAYPAL',
      mc_gross: '249.00',
      mc_currency: 'ILS',
    }),
  });
  expect('global PayPal ledger rejects cross-tenant reuse', rejected.status === 400
    && rejected.body.error === 'payment_reference_already_used');
  const after = await req(`/api/workers/${crossTenantWorkerId}`, { headers: victimAuth });
  expect('  cross-tenant PayPal replay cannot change entitlement', after.body.worker?.paidUntil === beforePaidUntil);
}
{
  const created = await req('/api/workers', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({
      templateId: 'sales-leads-il',
      name: 'Bit Ledger Worker',
      tools: [],
      knowledge: REVIEWED_SALES_KNOWLEDGE,
      knowledgeReviewed: true,
    }),
  });
  const bitWorkerId = created.body.workerId;
  expect('create pending Bit ledger worker', created.status === 200 && !!bitWorkerId);
  const paid = await req('/api/webhooks/bit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': BIT_WEBHOOK_SECRET },
    body: JSON.stringify({
      workerId: bitWorkerId,
      tenantId,
      reference: 'GLOBAL-BIT-REFERENCE',
      amount: 249,
    }),
  });
  expect('verified Bit reference activates its bound target', paid.status === 200 && paid.body.ok === true);
  const replay = await req('/api/webhooks/bit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': BIT_WEBHOOK_SECRET },
    body: JSON.stringify({
      workerId: bitWorkerId,
      tenantId,
      reference: 'GLOBAL-BIT-REFERENCE',
      amount: 249,
    }),
  });
  expect('same-target Bit replay is idempotent', replay.status === 200
    && replay.body.ok === true
    && replay.body.alreadyRecorded === true);

  const victimAuth = { authorization: 'Bearer ' + crossTenantKey, 'content-type': 'application/json' };
  const before = await req(`/api/workers/${crossTenantWorkerId}`, { headers: victimAuth });
  const beforePaidUntil = before.body.worker?.paidUntil;
  const rejected = await req('/api/webhooks/bit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': BIT_WEBHOOK_SECRET },
    body: JSON.stringify({
      workerId: crossTenantWorkerId,
      tenantId: crossTenantId,
      reference: 'GLOBAL-BIT-REFERENCE',
      amount: 249,
    }),
  });
  expect('global Bit ledger rejects cross-tenant reuse', rejected.status === 400
    && rejected.body.error === 'payment_reference_already_used');
  const after = await req(`/api/workers/${crossTenantWorkerId}`, { headers: victimAuth });
  expect('  cross-tenant Bit replay cannot change entitlement', after.body.worker?.paidUntil === beforePaidUntil);
}
{
  const workerBefore = await req(`/api/workers/${paypalWebhookWorkerId}`, { headers: auth() });
  const originalPaidUntil = workerBefore.body.worker?.paidUntil;
  const tenantDbPath = path.join(process.env.TENANTS_DIR ?? 'data/tenants', tenantId, 'workers.db');
  const tenantDb = new DatabaseSync(tenantDbPath);
  try {
    tenantDb.prepare(`UPDATE workers SET status = 'active', paid_until = NULL WHERE id = ?`).run(paypalWebhookWorkerId);
    const legacySummary = await req(`/invoice/${paypalWebhookWorkerId}`);
    expect('  legacy active worker without paidUntil is shown as active', legacySummary.status === 200
      && String(legacySummary.body).includes('פעיל ללא תאריך סיום (רשומת legacy)')
      && !String(legacySummary.body).includes('ממתין לאימות תשלום'));
    const legacyChat = await req(`/api/workers/${paypalWebhookWorkerId}/chat`, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ message: 'בדיקת entitlement ישן', customerId: 'legacy-entitlement' }),
    });
    expect('  legacy active worker can answer a normal chat', legacyChat.status === 200 && !!legacyChat.body.reply);
    const legacyStream = await req(`/api/workers/${paypalWebhookWorkerId}/chat/stream`, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ message: 'בדיקת stream ישן', customerId: 'legacy-entitlement-stream' }),
    });
    expect('  legacy active worker can answer a stream chat', legacyStream.status === 200 && String(legacyStream.body).includes('event: done'));

    tenantDb.prepare(`UPDATE workers SET status = 'active', paid_until = ? WHERE id = ?`)
      .run('2020-01-01T00:00:00.000Z', paypalWebhookWorkerId);
    const expiredSummary = await req(`/invoice/${paypalWebhookWorkerId}`);
    expect('  expired worker is shown as expired', expiredSummary.status === 200
      && String(expiredSummary.body).includes('התוקף הסתיים'));
    const expiredChat = await req(`/api/workers/${paypalWebhookWorkerId}/chat`, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ message: 'בדיקת entitlement שפג', customerId: 'expired-entitlement' }),
    });
    expect('  expired worker cannot answer a paid chat', expiredChat.status === 402);
  } finally {
    tenantDb.prepare(`UPDATE workers SET status = 'active', paid_until = ? WHERE id = ?`)
      .run(originalPaidUntil, paypalWebhookWorkerId);
    tenantDb.close();
  }
}

// Monthly allowance is enforced on live and preview chat routes. Admin can set
// a tenant-specific cap without making dashboard reads consume that cap.
{
  const before = await req('/api/account', { headers: auth() });
  const used = Number(before.body?.callsUsed ?? 0);
  expect('live chat usage is tracked per tenant/month', before.status === 200 && used >= 4);
  const setLimit = await req('/api/admin/set-tenant-chat-limit', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ tenantId, limit: used }),
  });
  expect('admin can set a finite tenant chat limit', setLimit.status === 200
    && setLimit.body.limit === used
    && setLimit.body.remaining === 0);
  const blocked = await req(`/api/workers/${paypalWebhookWorkerId}/chat`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ message: 'הודעה מעבר למכסה', customerId: 'quota-boundary', demoMode: true, testMode: true }),
  });
  expect('client mode flags cannot bypass the monthly limit', blocked.status === 402
    && blocked.body.error === 'quota_exceeded'
    && blocked.body.used === used
    && blocked.body.limit === used);
  const previewBlocked = await req(`/api/workers/${paypalWebhookWorkerId}/test-agent`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ message: 'ניסיון דמו מעבר למכסה', customerId: 'quota-preview-boundary' }),
  });
  expect('dedicated preview route is also quota-bound', previewBlocked.status === 402
    && previewBlocked.body.error === 'quota_exceeded');
}

{
  expect('OAuth return URL puts query before hash',
    buildOAuthReturnUrl('/marketplace#/workers/connect/wk_abc', 'oauth=success&type=google_calendar')
    === '/marketplace?oauth=success&type=google_calendar#/workers/connect/wk_abc');
  const wa = validateConfig('whatsapp', { ownerNotifyPhone: '0501234567' });
  expect('whatsapp connect accepts phone-only config', wa.ok === true && wa.config.provider === 'meta');
}

// Public hook/media misses must never create tenant directories or databases.
{
  const unknownTenant = 'ten_unknown_public_lookup_123456';
  const unknownDir = path.join(process.env.TENANTS_DIR ?? 'data/tenants', unknownTenant);
  fs.rmSync(unknownDir, { recursive: true, force: true });
  const hook = await req(`/api/hooks/${unknownTenant}/abcdef0123456789`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const media = await req(`/api/media/public/${unknownTenant}/med_abcdef0123456789.png`);
  expect('unknown public hook is rejected without tenant DB creation', hook.status === 403 && !fs.existsSync(unknownDir));
  expect('unknown public media is 404 without tenant directory creation', media.status === 404 && !fs.existsSync(unknownDir));
}
{
  const r = await req('/api/integrations/connect', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ type: 'whatsapp', config: { ownerNotifyPhone: '0507654321' } }),
  });
  expect('POST whatsapp connect with phone only -> 201/200', r.status === 201 || r.status === 200);
}
{
  // Weekly digest POST channel=web records the digest locally (no webhook required)
  const webPost = await req(`/api/workers/${mediaWorkerId}/weekly-digest`, {
    method: 'POST', headers: auth(), body: JSON.stringify({ channel: 'web' }),
  });
  expect('  POST digest channel=web -> 200', webPost.status === 200 && webPost.body.ok === true);
  expect('  digest records lastSentAt', !!webPost.body.sentAt);
  const r2 = await req(`/api/workers/${mediaWorkerId}/weekly-digest`, { headers: auth() });
  expect('  digest lastSentAt is set', !!r2.body.lastSentAt);
}
{
  // Sanitize customer-facing reply — meta-commentary from weak LLM must be replaced
  // with a polite Hebrew fallback so the customer never sees the model's internal
  // monologue ("User Safety: safe", English reasoning traces, etc.).
  const sanitize = (text, worker) => {
    const META = [
      /^user safety[:\s]/i, /^safety[:\s]/i,
      /^okay[, ]+the user is/i, /^sure[, ]+here'?s/i,
      /^based on the (conversation|message|context)/i,
      /^i'?d be happy to help/i, /^as an? (ai|assistant|language model)/i,
    ];
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    if (trimmed.length < 220 && META.some((re) => re.test(trimmed))) return true;
    const hebrew = (trimmed.match(/[\u0590-\u05FF]/g) || []).length;
    const total = trimmed.replace(/\s/g, '').length;
    return total > 40 && hebrew / total < 0.15;
  };
  const fallback = (worker) => {
    const name = String(worker?.name || '').trim();
    const biz = name.split(' — ').pop()?.trim() || 'העסק';
    return `תודה שפנית אלינו ל${biz}. קיבלנו את ההודעה שלך ונחזור אליך בהקדם.`;
  };
  const worker = { name: 'מזכיר/ה רפואי/ת — מרפאת שיניים' };
  expect('sanitize flags "User Safety: safe"', sanitize('User Safety: safe', worker) === true);
  expect('sanitize flags "Okay, the user is..."', sanitize('Okay, the user is saying something.', worker) === true);
  expect('sanitize flags English-only reply', sanitize('Hello, how can I help you today with your inquiry about our services?', worker) === true);
  expect('sanitize keeps good Hebrew reply', sanitize('שלום! איך אוכל לעזור לך היום?', worker) === false);
  expect('sanitize keeps Hebrew with safety note', sanitize('חשוב! פנו לרופא באופן מיידי.', worker) === false);
  expect('fallback contains biz name', fallback(worker).includes('מרפאת שיניים'));
}
console.log(`\n${failures === 0 ? 'All worker tests passed.' : `${failures} worker test(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
