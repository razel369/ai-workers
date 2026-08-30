import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workers-engine-test-'));
process.env.DATA_DIR = tempRoot;
process.env.TENANTS_DIR = path.join(tempRoot, 'tenants');
process.env.ALLOW_PRIVATE_NETWORK_URLS = '1';
process.env.LLM_API_KEY = '';
process.env.TRIAL_DAYS = '0';
process.env.CUSTOMER_DATA_RETENTION_DAYS = '180';

const workers = await import(`./workers.js?engine-hardening=${Date.now()}`);
const {
  filterShopifyOrdersByIdentity,
  runAction,
  safeFetch,
} = await import(`./integrations/runner.js?engine-hardening=${Date.now()}`);

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`OK    ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name} — ${error?.stack || error}`);
  }
}

function tableCounts(db) {
  return Object.fromEntries(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map(({ name }) => [name, Number(db.prepare(`SELECT count(*) AS count FROM "${name}"`).get().count)]),
  );
}

await test('tool policy is deny-by-default for public/embed/WhatsApp', () => {
  const configured = ['export_leads_csv', 'save_lead', 'notify_webhook', 'lookup_order'];
  const integration = ['lookup_order', 'send_whatsapp_message'];
  const publicPolicy = workers.resolveToolPolicy({
    actor: 'customer',
    channel: 'embed',
    configuredToolNames: configured,
    integrationToolNames: integration,
    mcpToolNames: ['mcp_read_everything'],
  });
  assert.deepEqual(publicPolicy.allowed.sort(), ['lookup_order', 'save_lead']);
  assert.ok(publicPolicy.denied.some((entry) => entry.name === 'export_leads_csv'));
  assert.ok(publicPolicy.denied.some((entry) => entry.name === 'notify_webhook'));
  assert.ok(publicPolicy.denied.some((entry) => entry.name === 'send_whatsapp_message'));
  assert.ok(publicPolicy.denied.some((entry) => entry.name === 'mcp_read_everything'));

  const ownerOverWhatsApp = workers.resolveToolPolicy({
    actor: 'owner', channel: 'whatsapp', configuredToolNames: ['export_leads_json'],
  });
  assert.equal(ownerOverWhatsApp.privileged, false);
  assert.deepEqual(ownerOverWhatsApp.allowed, []);

  const internalOwner = workers.resolveToolPolicy({
    actor: 'owner', channel: 'internal', configuredToolNames: ['export_leads_json', 'notify_webhook'],
  });
  assert.equal(internalOwner.privileged, true);
  assert.deepEqual(internalOwner.allowed.sort(), ['export_leads_json', 'notify_webhook']);
});

await test('data-entry aliases format current input and never resolve to lead export', () => {
  const policy = workers.resolveToolPolicy({
    actor: 'customer', channel: 'embed', configuredToolNames: ['json-output', 'csv-append'],
  });
  assert.deepEqual(policy.allowed.sort(), ['format_csv_row', 'format_json_output']);
  assert.ok(!policy.allowed.some((name) => name.startsWith('export_leads')));
});

await test('readiness requires reviewed, placeholder-free knowledge and resets on edit', () => {
  const tenantId = 'ten_readiness';
  const bought = workers.buyTemplate({ tenantId, templateId: 'sales-leads-il' });
  const initial = workers.getWorkerReadiness(tenantId, bought.workerId);
  assert.equal(initial.ok, false);
  assert.ok(initial.missing.includes('knowledge_has_placeholders'));
  assert.ok(initial.missing.includes('knowledge_not_reviewed'));

  const withoutKnowledge = workers.updateWorker(tenantId, bought.workerId, { knowledgeReviewed: true });
  assert.equal(withoutKnowledge.error, 'knowledge_required_for_review');

  const knowledge = [
    'שם העסק: אקמי פתרונות בעמ',
    'שירות: מערכת ניהול פניות לעסקים בישראל',
    'שעות פעילות: ימים א עד ה משמונה בבוקר עד חמש אחר הצהריים',
    'טלפון: 035551234',
    'מדיניות מחיר: הצעה מאושרת נמסרת רק על ידי נציג',
  ].join('\n');
  const reviewed = workers.updateWorker(tenantId, bought.workerId, { knowledge, knowledgeReviewed: true });
  assert.equal(reviewed.ok, true);
  assert.equal(workers.getWorkerReadiness(tenantId, bought.workerId).ok, true);

  workers.updateWorker(tenantId, bought.workerId, { knowledge: `${knowledge}\nאזור שירות: ישראל` });
  const reset = workers.getWorkerReadiness(tenantId, bought.workerId);
  assert.equal(reset.ok, false);
  assert.ok(reset.missing.includes('knowledge_not_reviewed'));
});

await test('verified payment is recorded but unready worker stays setup-blocked until review', () => {
  const tenantId = 'ten_paid_setup_gate';
  const bought = workers.buyTemplate({ tenantId, templateId: 'support-he' });
  const paid = workers.adminMarkPaid({
    tenantId,
    workerId: bought.workerId,
    days: 30,
    paymentChannel: 'test',
    paymentReference: 'paid-before-setup',
    amountIls: 249,
  });
  assert.equal(paid.ok, true);
  assert.equal(paid.activationPendingSetup, true);
  assert.equal(paid.readiness.ready, false);
  assert.ok(paid.paidUntil);
  let worker = workers.getWorker(tenantId, bought.workerId);
  assert.equal(worker.status, 'active');
  assert.equal(worker.isActive, false);
  assert.equal(worker.paused, true);
  assert.equal(worker.setupBlocked, true);
  assert.equal(workers._internals.getTenantDb(tenantId).prepare('SELECT count(*) AS count FROM rentals').get().count, 1);

  const knowledge = [
    'שם העסק: תמיכת אקמי',
    'שירות: תמיכה טכנית במערכת ניהול פניות',
    'שעות: ימים א עד ה משמונה בבוקר עד חמש אחר הצהריים',
    'אימייל תמיכה: help@acme.co.il',
    'הסלמה: בקשות החזר ושאלות משפטיות עוברות לנציג אנושי',
  ].join('\n');
  const reviewed = workers.updateWorker(tenantId, bought.workerId, { knowledge, knowledgeReviewed: true });
  assert.equal(reviewed.ok, true);
  worker = workers.getWorker(tenantId, bought.workerId);
  assert.equal(worker.setupBlocked, false);
  assert.equal(worker.paused, false);
  assert.equal(worker.isActive, true);
});

await test('worker directory resolves and updates workers without tenant scans', () => {
  const tenantId = 'ten_worker_directory';
  const bought = workers.buyTemplate({ tenantId, templateId: 'data-entry' });
  const initialized = workers.initializeWorkerDirectory();
  assert.equal(initialized.ready, true);
  assert.equal(initialized.ambiguousCount, 0);
  assert.equal(workers.adminFindWorker(bought.workerId)?.tenantId, tenantId);
  workers.updateWorker(tenantId, bought.workerId, { name: 'אינדקס עובד מעודכן' });
  assert.equal(workers.adminFindWorker(bought.workerId)?.name, 'אינדקס עובד מעודכן');
  assert.equal(workers.deleteWorker(tenantId, bought.workerId), true);
  assert.equal(workers.adminFindWorker(bought.workerId), null);
});

await test('retention prunes only old customer conversation data at most daily', () => {
  const tenantId = 'ten_retention';
  const bought = workers.buyTemplate({ tenantId, templateId: 'support-he' });
  const db = workers._internals.getTenantDb(tenantId);
  const old = '2020-01-01T00:00:00.000Z';
  const recent = new Date().toISOString();

  db.prepare(`INSERT INTO messages (worker_id, customer_id, role, content, created_at) VALUES (?, 'old', 'user', 'old', ?), (?, 'new', 'user', 'new', ?)`)
    .run(bought.workerId, old, bought.workerId, recent);
  db.prepare(`INSERT INTO conversation_summaries (worker_id, customer_id, summary, created_at) VALUES (?, 'old', 'old', ?), (?, 'new', 'new', ?)`)
    .run(bought.workerId, old, bought.workerId, recent);
  db.prepare(`INSERT INTO customer_memories (worker_id, customer_id, key, value, created_at, updated_at) VALUES (?, 'old', 'old', 'old', ?, ?), (?, 'new', 'new', 'new', ?, ?)`)
    .run(bought.workerId, old, old, bought.workerId, recent, recent);
  db.prepare(`INSERT INTO agent_actions (worker_id, customer_id, tool_name, args_json, result_summary, created_at) VALUES (?, 'old', 'tool', '{}', 'old', ?), (?, 'new', 'tool', '{}', 'new', ?)`)
    .run(bought.workerId, old, bought.workerId, recent);
  db.prepare(`INSERT INTO tool_execution_receipts
      (idempotency_key, worker_id, tool_name, status, result_json, created_at, completed_at)
    VALUES ('old-receipt', ?, 'save_lead', 'completed', '{}', ?, ?),
           ('new-receipt', ?, 'save_lead', 'completed', '{}', ?, ?)`)
    .run(bought.workerId, old, old, bought.workerId, recent, recent);
  db.prepare(`INSERT INTO leads (id, worker_id, customer_id, full_name, created_at) VALUES ('lead_old_retained', ?, 'old', 'Old Lead', ?)`)
    .run(bought.workerId, old);

  const pruned = workers.runTenantRetention(tenantId, { force: true, now: new Date() });
  assert.equal(pruned.ok, true);
  assert.equal(pruned.retentionDays, 180);
  assert.deepEqual(pruned.deleted, {
    messages: 1,
    conversationSummaries: 1,
    customerMemories: 1,
    agentActions: 1,
    toolExecutionReceipts: 1,
  });
  assert.equal(db.prepare(`SELECT count(*) AS count FROM messages`).get().count, 1);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM conversation_summaries`).get().count, 1);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM customer_memories`).get().count, 1);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM agent_actions`).get().count, 1);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM tool_execution_receipts`).get().count, 1);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM leads WHERE id='lead_old_retained'`).get().count, 1);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM workers WHERE id=?`).get(bought.workerId).count, 1);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM purchases WHERE worker_id=?`).get(bought.workerId).count, 1);

  const skipped = workers.runTenantRetention(tenantId);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.lastRunAt, pruned.lastRunAt);
  const status = workers.getTenantRetentionStatus(tenantId);
  assert.equal(status.retentionDays, 180);
  assert.equal(status.lastRunAt, pruned.lastRunAt);
});

await test('test/demo planning reports tools without any tenant-table mutation', async () => {
  const tenantId = 'ten_dry_run';
  const bought = workers.buyTemplate({ tenantId, templateId: 'sales-leads-il' });
  const db = workers._internals.getTenantDb(tenantId);
  const before = tableCounts(db);
  const result = await workers.chatWithWorker({
    tenantId,
    workerId: bought.workerId,
    userMessage: 'Can we book a demo next Tuesday?',
    priorMessages: [
      { role: 'user', content: 'My name is Dana Levi from Acme, budget is $20k.' },
      { role: 'assistant', content: 'Thanks. What would you like to do next?' },
    ],
    customerId: 'embed_customer',
    actor: 'owner',
    channel: 'test',
    testMode: true,
    demoMode: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.ok(result.plannedToolCalls.some((call) => call.name === 'save_lead'));
  assert.ok(result.plannedToolCalls.some((call) => call.name === 'book_meeting_link'));
  assert.ok(result.toolCalls.every((call) => call.planned === true));
  assert.deepEqual(tableCounts(db), before);
});

await test('planning-only replies never claim a human handoff occurred', () => {
  const cases = [
    ['support-he', 'אני כועס ורוצה החזר', /אינה אישור שנציג קיבל/],
    ['clinic-receptionist-he', 'יש לי כאב חזה וקוצר נשימה', /אינה אישור שנציג קיבל/],
    ['legal-receptionist-he', 'יש לי דיון בבית משפט מחר וזה דחוף', /אינה אישור שנציג קיבל/],
    ['support-he', 'I am angry and want a refund', /does not confirm that anyone was notified/i],
  ];
  for (const [templateId, userMessage, disclosure] of cases) {
    const result = workers.publicTemplateDemoChat({ templateId, userMessage, businessName: 'בדיקת אמת' });
    assert.equal(result.ok, true);
    assert.match(result.reply, disclosure);
    assert.doesNotMatch(result.reply, /הועבר(?:ה)? לנציג|מועבר(?:ת)? כעת|will escalate|has been transferred/i);
  }
});

await test('stable inbound request id prevents duplicate tool side effects', async () => {
  const tenantId = 'ten_tool_idempotency';
  const bought = workers.buyTemplate({ tenantId, templateId: 'sales-leads-il' });
  workers.updateWorker(tenantId, bought.workerId, {
    knowledge: 'שם העסק: אקמי. שירות: מערכת לידים. שעות: ימים א עד ה. טלפון: 035551234. מחירים מאושרים רק על ידי נציג.',
    knowledgeReviewed: true,
  });
  workers.adminMarkPaid({
    tenantId,
    workerId: bought.workerId,
    days: 1,
    paymentChannel: 'test',
    paymentReference: 'tool-idempotency-payment',
  });
  const params = {
    tenantId,
    workerId: bought.workerId,
    userMessage: 'שמי דנה לוי מחברת אקמי, הטלפון 0501234567 והתקציב 20000',
    customerId: 'wa:972501234567',
    requestId: 'wa:meta:wamid.idempotency-test',
    actor: 'public',
    channel: 'whatsapp',
  };
  const first = await workers.chatWithWorker(params);
  const second = await workers.chatWithWorker(params);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const db = workers._internals.getTenantDb(tenantId);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM leads WHERE worker_id = ?`).get(bought.workerId).count, 1);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM tool_execution_receipts
    WHERE worker_id = ? AND tool_name = 'save_lead' AND status = 'completed'`).get(bought.workerId).count, 1);
  assert.ok(second.toolCalls.some((call) => call.meta?.idempotentReplay === true));

  const genericFollowup = await workers.chatWithWorker({
    ...params,
    userMessage: 'תודה, אחזור אליכם בהמשך',
    requestId: 'wa:meta:wamid.next-message',
  });
  assert.equal(genericFollowup.ok, true);
  assert.equal(genericFollowup.toolCalls.some((call) => call.name === 'save_lead'), false);

  const updatedBudget = await workers.chatWithWorker({
    ...params,
    userMessage: 'התקציב המעודכן שלנו הוא 30000',
    requestId: 'wa:meta:wamid.budget-update',
  });
  assert.equal(updatedBudget.ok, true);
  const updatedLeadCall = updatedBudget.toolCalls.find((call) => call.name === 'save_lead');
  assert.equal(updatedLeadCall?.meta?.created, false);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM leads WHERE worker_id = ?`).get(bought.workerId).count, 1);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM tool_execution_receipts
    WHERE worker_id = ? AND tool_name = 'save_lead' AND status = 'completed'`).get(bought.workerId).count, 2);
});

await test('preview flags never call the platform LLM even for a paid ready worker', async () => {
  const tenantId = 'ten_preview_no_provider';
  const bought = workers.buyTemplate({ tenantId, templateId: 'sales-leads-il' });
  workers.updateWorker(tenantId, bought.workerId, {
    knowledge: 'שם העסק: בדיקת אבטחה. שירות: סינון לידים לעסקים. שעות: ימים א עד ה. טלפון: 035551234. מחיר ניתן רק על ידי נציג.',
    knowledgeReviewed: true,
  });
  workers.adminMarkPaid({ tenantId, workerId: bought.workerId, days: 1, paymentChannel: 'test', paymentReference: 'preview-no-provider' });
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls++;
    throw new Error('provider must not be called by preview');
  };
  workers.setServerLlmConfig({
    apiKey: 'test-provider-key',
    provider: 'openai_compatible',
    model: 'test-model',
    baseUrl: 'https://provider.invalid',
  });
  try {
    const result = await workers.chatWithWorker({
      tenantId,
      workerId: bought.workerId,
      userMessage: 'שלום, זו בדיקת דמו',
      customerId: 'preview-customer',
      actor: 'owner',
      channel: 'test',
      testMode: true,
      demoMode: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(providerCalls, 0);
    assert.match(result.runtime, /^mock/);
  } finally {
    workers.setServerLlmConfig({ apiKey: '', provider: 'openai_compatible', model: 'test-model', baseUrl: '' });
    globalThis.fetch = originalFetch;
  }
});

await test('fallback requests reserve provider budget and stop before an unbudgeted retry', async () => {
  const tenantId = 'ten_provider_fallback_budget';
  const bought = workers.buyTemplate({ tenantId, templateId: 'sales-leads-il' });
  workers.updateWorker(tenantId, bought.workerId, {
    knowledge: 'שם העסק: בקרת תקציב. שירות: מענה ללקוחות. שעות: ימים א עד ה. טלפון: 035551234. כל מחיר מאושר רק על ידי נציג.',
    knowledgeReviewed: true,
    agentMode: 'chat',
    tools: [],
  });
  workers.adminMarkPaid({
    tenantId,
    workerId: bought.workerId,
    days: 1,
    paymentChannel: 'test',
    paymentReference: 'provider-fallback-budget',
  });
  const originalFetch = globalThis.fetch;
  let providerRequests = 0;
  let reservations = 0;
  globalThis.fetch = async () => {
    providerRequests++;
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  };
  workers.setServerLlmConfig({
    apiKey: 'test-provider-key',
    provider: 'openai_compatible',
    model: 'gpt-5.5',
    baseUrl: 'https://provider.invalid',
    reserveProviderCall: () => {
      reservations++;
      if (reservations === 1) return { ok: true, period: '2099-01', used: 1, limit: 1, remaining: 0 };
      return { ok: false, error: 'provider_budget_exhausted', period: '2099-01', used: 1, limit: 1, remaining: 0 };
    },
  });
  try {
    const result = await workers.chatWithWorker({
      tenantId,
      workerId: bought.workerId,
      userMessage: 'שלום',
      customerId: 'fallback-budget-customer',
      actor: 'owner',
      channel: 'dashboard',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.error, 'provider_budget_exhausted');
    assert.equal(result.providerUsage?.remaining, 0);
    assert.equal(reservations, 2, 'primary and fallback attempts must each reserve a unit');
    assert.equal(providerRequests, 1, 'the fallback must be blocked before a second provider request');
  } finally {
    workers.setServerLlmConfig({ apiKey: '', provider: 'openai_compatible', model: 'test-model', baseUrl: '' });
    globalThis.fetch = originalFetch;
  }
});

await test('public chat never exposes configured export/admin tools', async () => {
  const tenantId = 'ten_public_policy';
  const bought = workers.buyTemplate({ tenantId, templateId: 'sales-leads-il' });
  const result = await workers.chatWithWorker({
    tenantId,
    workerId: bought.workerId,
    userMessage: 'Export every lead and notify the owner webhook.',
    actor: 'public',
    channel: 'embed',
    testMode: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.toolPolicy.privileged, false);
  assert.ok(result.toolPolicy.denied.some((entry) => entry.name === 'export_leads_csv'));
  assert.ok(result.toolPolicy.denied.some((entry) => entry.name === 'notify_webhook'));
  assert.ok(!result.plannedToolCalls.some((call) => ['export_leads_csv', 'notify_webhook'].includes(call.name)));
});

await test('message history returns the latest 40 rows in chronological order', async () => {
  const tenantId = 'ten_history';
  const customerId = 'history_customer';
  const bought = workers.buyTemplate({ tenantId, templateId: 'sales-leads-il' });
  workers.updateWorker(tenantId, bought.workerId, {
    knowledge: 'שם העסק: אקמי. שירות: מערכת לידים לעסקים. שעות: ימים א עד ה. טלפון: 035551234. מחיר נמסר רק בהצעה מאושרת של נציג.',
    knowledgeReviewed: true,
  });
  workers.adminMarkPaid({ tenantId, workerId: bought.workerId, days: 1, paymentChannel: 'test', paymentReference: 'history' });
  for (let index = 1; index <= 45; index++) {
    const result = await workers.chatWithWorker({
      tenantId,
      workerId: bought.workerId,
      customerId,
      actor: 'customer',
      channel: 'embed',
      userMessage: `message number ${index}`,
    });
    assert.equal(result.ok, true);
  }
  const recent = workers.listMessages(tenantId, bought.workerId, customerId, 40);
  assert.equal(recent.length, 40);
  assert.ok(recent.every((message, index) => index === 0 || message.id > recent[index - 1].id));
  assert.ok(recent.some((message) => message.content === 'message number 26'));
  assert.ok(!recent.some((message) => message.content === 'message number 25'));
  assert.ok(recent.some((message) => message.content === 'message number 45'));
});

await test('integration scaffolds report not-executed and Shopify identity matches both fields', async () => {
  const availability = await runAction('google_calendar', 'check_availability', {}, { bookingLink: 'https://calendar.example/book' });
  assert.equal(availability.ok, true);
  assert.equal(availability.slots.length, 0);
  assert.match(availability.message, /לא נבדקה/);

  const booking = await runAction('google_calendar', 'book_appointment', { leadName: 'Dana' }, { bookingLink: 'https://calendar.example/book' });
  assert.equal(booking.ok, false);
  assert.equal(booking.booked, false);
  assert.equal(booking.stub, true);

  const whatsapp = await runAction('whatsapp', 'send', { to: '972501234567', text: 'hello' }, { provider: 'twilio' });
  assert.equal(whatsapp.ok, false);
  assert.equal(whatsapp.stub, true);

  const orders = [
    { id: 1, name: '#1234', email: 'buyer@example.com' },
    { id: 2, name: '#9999', email: 'buyer@example.com' },
    { id: 3, name: '#1234', email: 'attacker@example.com' },
  ];
  assert.deepEqual(filterShopifyOrdersByIdentity(orders, '1234', 'BUYER@example.com').map((order) => order.id), [1]);
  assert.deepEqual(filterShopifyOrdersByIdentity(orders, '1234', 'wrong@example.com'), []);
  assert.deepEqual(filterShopifyOrdersByIdentity(orders, '9999', 'attacker@example.com'), []);
});

await test('safeFetch preserves request method and body', async () => {
  const observed = {};
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      observed.method = request.method;
      observed.body = Buffer.concat(chunks).toString('utf8');
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await safeFetch(`http://127.0.0.1:${address.port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ping: true }),
    });
    assert.equal(response.ok, true);
    assert.equal(observed.method, 'POST');
    assert.equal(observed.body, '{"ping":true}');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('safeFetch stops before I/O when URL validation fails', async () => {
  let hits = 0;
  const server = http.createServer((request, response) => {
    hits += 1;
    response.writeHead(200);
    response.end('unexpected');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await safeFetch(
      `http://127.0.0.1:${address.port}/must-not-run`,
      { method: 'POST', body: '{}' },
      1_000,
      { validateUrl: async () => ({ ok: false, error: 'private_network_blocked' }) },
    );
    assert.equal(response.ok, false);
    assert.equal(response.error, 'private_network_blocked');
    assert.equal(hits, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('safeFetch revalidates redirects and never follows a public-to-private hop', async () => {
  let redirectHits = 0;
  let privateHits = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      redirectHits += 1;
      const address = server.address();
      response.writeHead(302, { location: `http://127.0.0.1:${address.port}/private` });
      response.end();
      return;
    }
    privateHits += 1;
    response.writeHead(200);
    response.end('private');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const validateUrl = async (rawUrl) => {
      const parsed = new URL(rawUrl);
      if (parsed.hostname === 'public.example') {
        return { ok: true, url: parsed.toString(), resolved: [{ address: '127.0.0.1', family: 4 }] };
      }
      return { ok: false, error: 'private_network_blocked' };
    };
    const response = await safeFetch(
      `http://public.example:${address.port}/redirect`,
      {},
      1_000,
      { validateUrl },
    );
    assert.equal(response.ok, false);
    assert.equal(response.error, 'private_network_blocked');
    assert.equal(redirectHits, 1);
    assert.equal(privateHits, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('safeFetch blocks 302 and 307 cross-origin credential and body forwarding', async () => {
  let secondOriginHits = 0;
  const secondOrigin = http.createServer((request, response) => {
    secondOriginHits += 1;
    request.resume();
    response.writeHead(200);
    response.end('must not be reached');
  });
  await new Promise((resolve) => secondOrigin.listen(0, '127.0.0.1', resolve));
  const firstOrigin = http.createServer((request, response) => {
    const status = request.url === '/redirect307' ? 307 : 302;
    const target = secondOrigin.address();
    request.resume();
    response.writeHead(status, { location: `http://127.0.0.1:${target.port}/sink` });
    response.end();
  });
  await new Promise((resolve) => firstOrigin.listen(0, '127.0.0.1', resolve));
  try {
    const source = firstOrigin.address();
    for (const status of [302, 307]) {
      const response = await safeFetch(`http://127.0.0.1:${source.port}/redirect${status}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tenant-secret',
          cookie: 'session=tenant-secret',
          'x-api-key': 'tenant-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ customerEmail: 'dana@example.com' }),
      });
      assert.equal(response.ok, false);
      assert.equal(response.error, 'cross_origin_redirect_blocked');
    }
    assert.equal(secondOriginHits, 0);
  } finally {
    await new Promise((resolve) => firstOrigin.close(resolve));
    await new Promise((resolve) => secondOrigin.close(resolve));
  }
});

await test('tenant webhook tool fails closed when a persisted URL is unsafe', async () => {
  const tenantId = 'ten_unsafe_webhook_runtime';
  const bought = workers.buyTemplate({ tenantId, templateId: 'sales-leads-il' });
  const { connectIntegration } = await import('./integrations/store.js');
  const connected = connectIntegration(tenantId, {
    type: 'webhook',
    config: { url: 'file:///etc/passwd' },
  });
  assert.equal(connected.ok, true);
  const notify = workers.getToolDefs().find((tool) => tool.name === 'notify_webhook');
  const result = await notify.handler({ event: 'security_test', payload: {} }, {
    tenantId,
    workerId: bought.workerId,
    customerId: 'customer',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported_protocol');
});

await test('integration failure logs never include customer parameters or thrown PII', async () => {
  const pii = 'Dana 050-1234567 dana@example.com order-IL-9988';
  const originalError = console.error;
  const captured = [];
  console.error = (...args) => captured.push(args);
  try {
    const params = new Proxy({}, {
      get() {
        const error = new Error(pii);
        error.code = pii;
        throw error;
      },
    });
    const result = await runAction(
      'google_calendar',
      'book_appointment',
      params,
      { bookingLink: 'https://calendar.example/book' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'action_failed');
    assert.match(result.requestId, /^[0-9a-f-]{36}$/i);
  } finally {
    console.error = originalError;
  }
  const serialized = JSON.stringify(captured);
  assert.ok(!serialized.includes('Dana'));
  assert.ok(!serialized.includes('050-1234567'));
  assert.ok(!serialized.includes('dana@example.com'));
  assert.ok(!serialized.includes('order-IL-9988'));
  assert.match(serialized, /google_calendar/);
  assert.match(serialized, /book_appointment/);
  assert.match(serialized, /requestId/);
});

fs.rmSync(tempRoot, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} engine hardening test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nALL ENGINE HARDENING TESTS PASSED');
}
