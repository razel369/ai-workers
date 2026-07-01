// Platform tests for AI Workers.
// Covers: health, invoice, admin key issuance, earnings, tips, marketplace.

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

console.log(`Testing ${BASE}\n`);

// 1. Health
{
  const r = await req('/health');
  expect('GET /health -> 200', r.status === 200);
  expect('  reports adminEnabled', typeof r.body.adminEnabled === 'boolean');
  expect('  channels array present', Array.isArray(r.body.channels));
}
{
  const r = await req('/health', {
    headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
  });
  expect('spoofed forwarded host ignored by default', r.status === 200 && !String(r.body.publicBaseUrl).includes('evil.example'));
}

// 2. Invoice
{
  const r = await req('/invoice');
  expect('GET /invoice -> 200 text', r.status === 200 && String(r.body).includes('INVOICE'));
  expect('  mentions AI WORKER TEMPLATES', String(r.body).includes('AI WORKER TEMPLATES'));
}

// 3. Invoice.txt
{
  const r = await req('/invoice.txt');
  expect('GET /invoice.txt -> 200', r.status === 200);
}

// 4. Admin issue key (with token)
{
  const r = await req('/admin/issue-key', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ channel: 'paypal', reference: 'PP-TXN-123', label: 'PayPal test' }),
  });
  expect('POST /admin/issue-key -> 200', r.status === 200);
  expect('  got a sk_ key', r.body?.key?.startsWith('sk_'));
}

// 5. Admin without token -> 401
{
  const r = await req('/admin/issue-key', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect('admin without token -> 401', r.status === 401);
}
{
  const r = await req(`/admin/issue-key?token=${ADMIN_TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect('admin query token rejected -> 401', r.status === 401);
}
{
  const r = await req('/earnings', {
    headers: { authorization: 'Bearer wrong-admin-token', 'x-forwarded-for': '203.0.113.99' },
  });
  expect('spoofed forwarded IP invalid admin -> 401', r.status === 401);
}

// 5b. Self-serve signup issues a tenant key without admin access
{
  const r = await req('/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessName: 'Self Serve Test', contact: 'buyer@example.com' }),
  });
  expect('POST /api/signup -> 200', r.status === 200);
  expect('  signup returns tenant key', r.body?.key?.startsWith('sk_'));
  expect('  signup returns stable tenant id', r.body?.tenantId?.startsWith('ten_'));
  const account = await req('/api/account', { headers: { authorization: 'Bearer ' + r.body.key } });
  expect('GET /api/account -> 200', account.status === 200);
  expect('  account tenant matches signup', account.body?.tenantId === r.body.tenantId);
  const rotated = await req('/api/account/rotate-key', { method: 'POST', headers: { authorization: 'Bearer ' + r.body.key } });
  expect('POST /api/account/rotate-key -> 200', rotated.status === 200 && rotated.body?.ok === true);
  expect('  rotated key keeps tenant id', rotated.body?.tenantId === r.body.tenantId);
  const oldKeyCheck = await req('/api/account', { headers: { authorization: 'Bearer ' + r.body.key } });
  expect('  old key revoked after rotation', oldKeyCheck.status === 401);
}
{
  const r = await req('/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessName: '', contact: '' }),
  });
  expect('signup validates required fields -> 400', r.status === 400);
}

// 6. Admin list keys
{
  const r = await req('/admin/keys', { headers: adminAuth });
  expect('GET /admin/keys -> 200', r.status === 200);
  expect('  >= 1 key issued', (r.body.keys?.length ?? 0) >= 1);
}
{
  const r = await req('/api/admin/replace-tenant-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: 'ten_missing' }),
  });
  expect('replace tenant key without admin -> 401', r.status === 401);
}
{
  const r = await req('/api/admin/replace-tenant-key', {
    method: 'POST',
    headers: adminAuth,
    body: JSON.stringify({ tenantId: 'ten_missing' }),
  });
  expect('replace unknown tenant -> 400', r.status === 400 && r.body.error === 'unknown_tenant');
}
{
  const r = await req('/api/admin/audit-events');
  expect('audit events without admin -> 401', r.status === 401);
}
{
  const r = await req('/api/admin/audit-events?limit=20', { headers: adminAuth });
  expect('audit events with admin -> 200', r.status === 200);
  const events = r.body.events ?? [];
  expect('  records failed admin auth', events.some((e) => e.action === 'admin_auth_failed' && e.status === 'denied'));
  expect('  ignores spoofed forwarded IP by default', !events.some((e) => e.ip === '203.0.113.99'));
  expect('  records key issuance', events.some((e) => e.action === 'admin_issue_key' && e.targetType === 'tenant'));
  expect('  records failed tenant recovery', events.some((e) => e.action === 'admin_replace_tenant_key' && e.status === 'failed'));
  expect('  audit metadata does not expose issued key', !JSON.stringify(events).includes('sk_'));
}

// 7. Tip recording
{
  const r = await req('/tip', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'buymeacoffee', amount: '5', donor: 'tester' }),
  });
  expect('POST /tip -> 200', r.status === 200 && r.body.thanks === true);
}

// 8. Earnings endpoint
{
  const r = await req('/earnings');
  expect('GET /earnings without admin -> 401', r.status === 401);
}
{
  const r = await req('/earnings', { headers: adminAuth });
  expect('GET /earnings -> 200', r.status === 200);
  expect('  workerStats defined', typeof r.body.workerStats === 'object');
  expect('  tipCount >= 1', (r.body.summary?.tipCount ?? 0) >= 1);
  expect('  no wildcard CORS header', !r.headers.has('access-control-allow-origin'));
  expect('  frame protection header set', r.headers.get('x-frame-options') === 'DENY');
  const csp = r.headers.get('content-security-policy') ?? '';
  expect('  CSP blocks object embedding', csp.includes("object-src 'none'"));
  expect('  CSP blocks framing', csp.includes("frame-ancestors 'none'"));
  expect('  HSTS header set', r.headers.get('strict-transport-security')?.includes('max-age=31536000'));
}

// 9. Dashboard
{
  const r = await req('/');
  expect('GET / -> 200 HTML', r.status === 200);
  expect('  mentions Hebrew branding', String(r.body).includes('עובדי AI'));
  expect('  links to marketplace', String(r.body).includes('/marketplace'));
}

// 10. Marketplace HTML page
{
  const r = await req('/marketplace');
  expect('GET /marketplace -> 200', r.status === 200);
  const csp = r.headers.get('content-security-policy') ?? '';
  expect('  HTML allows Google font styles only', csp.includes("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"));
  expect('  HTML limits browser fetches to same origin', csp.includes("connect-src 'self'"));
  expect('  serves Hebrew HTML', String(r.body).includes('שוק העובדים'));
}

// 11. Templates API
{
  const r = await req('/api/workers/templates');
  expect('GET /api/workers/templates -> 200', r.status === 200);
  expect('  has 10+ templates', r.body.templates?.length >= 10);
}
{
  const r = await req('/api/public/stats');
  expect('GET /api/public/stats -> 200', r.status === 200);
  expect('  exposes template count', r.body.templateCount >= 10);
  expect('  does not expose revenue', r.body.monthlyRevenueIls === undefined && r.body.totalUsdcReceived === undefined);
}

// 12. Earnings CSV
{
  const r = await req('/earnings.csv');
  expect('GET /earnings.csv without admin -> 401', r.status === 401);
}
{
  const r = await req('/earnings.csv', { headers: adminAuth });
  expect('GET /earnings.csv -> 200', r.status === 200);
}

// 13. 404 for unknown route
{
  const r = await req('/no-such-route');
  expect('unknown route -> 404', r.status === 404);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
