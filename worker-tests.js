// E2E tests for the Workers feature (v0.5.0).
// Covers: template listing, marketplace HTML, buy flow, builder CRUD,
// payment-gated chat (mock + LLM-free), admin mark-paid, admin listing,
// per-tenant isolation, platform-provided AI (no BYOK).

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

console.log(`Workers tests against ${BASE}\n`);

// 1. Marketplace HTML page
{
  const r = await req('/marketplace');
  expect('GET /marketplace -> 200', r.status === 200);
  expect('  serves Hebrew HTML', String(r.body).includes('שוק העובדים'));
  expect('  contains marketplace positioning', String(r.body).includes('קטלוג עובדים'));
}
{
  const r = await req('/builder');
  expect('GET /builder -> 200', r.status === 200);
}

// 2. Templates API
{
  const r = await req('/api/workers/templates');
  expect('GET /api/workers/templates -> 200', r.status === 200);
  expect('  has 9 templates', r.body.templates?.length >= 9);
  expect('  all have id/name/buyPriceIls', r.body.templates?.every((t) => t.id && t.name && t.buyPriceIls > 0));
  expect('  sales-leads-il present', !!r.body.templates?.find((t) => t.id === 'sales-leads-il'));
  expect('  support-he present', !!r.body.templates?.find((t) => t.id === 'support-he'));
  expect('  data-entry present', !!r.body.templates?.find((t) => t.id === 'data-entry'));
  expect('  content-he present', !!r.body.templates?.find((t) => t.id === 'content-he'));
  expect('  real-estate-il present', !!r.body.templates?.find((t) => t.id === 'real-estate-il'));
  expect('  clinic-receptionist-he present', !!r.body.templates?.find((t) => t.id === 'clinic-receptionist-he'));
  expect('  restaurant-manager-he present', !!r.body.templates?.find((t) => t.id === 'restaurant-manager-he'));
  expect('  ecom-support-he present', !!r.body.templates?.find((t) => t.id === 'ecom-support-he'));
  expect('  property-manager-he present', !!r.body.templates?.find((t) => t.id === 'property-manager-he'));
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
let activationRequestId = null;
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
  expect('  error=payment_required', r.body.error === 'payment_required');
}

// 6b. Customer submits payment/activation proof
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
  const otherAuth = { authorization: 'Bearer ' + otherTenant.body.key, 'content-type': 'application/json' };
  const otherBuy = await req('/api/workers/buy', {
    method: 'POST', headers: otherAuth,
    body: JSON.stringify({ templateId: 'support-he' }),
  });
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
  const w = r.body.workers?.[0];
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
  expect('  starter knowledge asks for business basics', /שם העסק/.test(r.body.worker?.knowledge ?? ''));
  expect('  llm.provider = mock by default', r.body.worker?.llm?.provider === 'mock');
  expect('  llm.hasApiKey = false', r.body.worker?.llm?.hasApiKey === false);
  expect('  never returns apiKey value', r.body.worker?.llm?.apiKey === undefined);
  expect('  single worker exposes isActive=true', r.body.worker?.isActive === true);
}

// 10. Update worker (Builder PATCH)
{
  const r = await req(`/api/workers/${firstWorkerId}`, {
    method: 'PATCH', headers: auth(),
    body: JSON.stringify({ name: 'Daniel - Acme Corp', knowledge: 'Acme Corp sells widgets in Israel. Pricing starts at 1000 ILS/month.', tasks: ['Greet', 'Qualify', 'Book meeting'] }),
  });
  expect('PATCH worker -> 200', r.status === 200 && r.body.ok === true);
}
{
  const r = await req(`/api/workers/${firstWorkerId}`, { headers: auth() });
  expect('  name updated', r.body.worker?.name === 'Daniel - Acme Corp');
  expect('  tasks updated', r.body.worker?.tasks?.length === 3);
  expect('  knowledge updated', r.body.worker?.knowledge?.includes('Acme Corp'));
}

// 11. Chat (mock runtime) — should succeed and produce a mock-flavored reply
{
  const r = await req(`/api/workers/${firstWorkerId}/chat`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ message: 'Who are you?' }),
  });
  expect('chat -> 200', r.status === 200);
  expect('  reply non-empty', r.body?.reply?.length > 20);
  expect('  runtime=mock', r.body?.runtime === 'mock');
  expect('  reply mentions Daniel template', /Daniel|mock/i.test(r.body.reply));
}

// 12. Messages list
{
  const r = await req(`/api/workers/${firstWorkerId}/messages`, { headers: auth() });
  expect('GET messages -> 200', r.status === 200);
  expect('  has 2 messages (user + assistant)', r.body.messages?.length === 2);
  expect('  first role=user', r.body.messages?.[0]?.role === 'user');
  expect('  second role=assistant', r.body.messages?.[1]?.role === 'assistant');
}

// 13. Second chat — context preserved
{
  const r = await req(`/api/workers/${firstWorkerId}/chat`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ message: 'How much does it cost?' }),
  });
  expect('chat #2 -> 200', r.status === 200);
  expect('  pricing reply', /pricing|plan|quote|מחיר|quote/i.test(r.body.reply));
}
{
  const r = await req(`/api/workers/${firstWorkerId}/messages`, { headers: auth() });
  expect('  now 4 messages', r.body.messages?.length === 4);
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

// 17. Delete worker
{
  const r = await req(`/api/workers/${firstWorkerId}`, { method: 'DELETE', headers: auth() });
  expect('DELETE worker -> 200', r.status === 200 && r.body.ok === true);
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

console.log(`\n${failures === 0 ? 'All worker tests passed.' : `${failures} worker test(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
