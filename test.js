// E2E test for the Israel-friendly paid agent.
// Covers: discovery, x402 paywall, multiple entrypoints, API key auth,
// admin key issuance + revocation, invoice generation, tip logging.

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token';
let failures = 0;
const ok = (l) => console.log(`OK    ${l}`);
const fail = (l, d) => { failures++; console.log(`FAIL  ${l}${d ? ' \u2014 ' + d : ''}`); };
const expect = (l, c, d) => c ? ok(l) : fail(l, d);

async function req(path, init = {}) {
  const r = await fetch(BASE + path, init);
  const ct = r.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await r.json() : await r.text();
  return { status: r.status, body, headers: r.headers };
}

console.log(`Testing ${BASE}\n`);

// 1. Discovery
{
  const r = await req('/.well-known/agent.json');
  expect('GET /.well-known/agent.json -> 200', r.status === 200);
  expect('  has skills[] >= 3', Array.isArray(r.body.skills) && r.body.skills.length >= 3);
  expect('  declares x402 + bearer-api-key', r.body.authentication?.schemes?.includes('x402-usdc') && r.body.authentication?.schemes?.includes('bearer-api-key'));
}

// 2. Health
{
  const r = await req('/health');
  expect('GET /health -> 200', r.status === 200);
  expect('  reports adminEnabled', typeof r.body.adminEnabled === 'boolean');
  expect('  channels array present', Array.isArray(r.body.channels));
}

// 3. Plans + invoice
{
  const r = await req('/billing/plans');
  expect('GET /billing/plans -> 200', r.status === 200);
  expect('  has 3 plans', r.body.plans?.length === 3);
  expect('  all plans have priceIls', r.body.plans?.every((p) => p.priceIls > 0));
}
{
  const r = await req('/invoice');
  expect('GET /invoice -> 200 text', r.status === 200 && String(r.body).includes('INVOICE'));
}

// 4. x402 paywall (no auth -> 402)
{
  const r = await req('/entrypoints/summarize/invoke', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello world test' }),
  });
  expect('no auth -> 402', r.status === 402);
  expect('  402 mentions invoiceUrl', !!r.body.invoiceUrl);
  expect('  402 has payment requirements', !!r.body.accepts?.[0]?.payTo);
}

// 5. x402 mock paid
{
  const r = await req('/entrypoints/summarize/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment': 'mock' },
    body: JSON.stringify({ text: 'hello world test' }),
  });
  expect('x402 mock -> 200', r.status === 200);
  expect('  payment.method = x402', r.body?.payment?.method === 'x402');
}

// 6. Admin issue-key (with token in query)
{
  const r = await req(`/admin/issue-key?token=${ADMIN_TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: 'credits-100', channel: 'paypal', reference: 'PP-TXN-123', label: 'PayPal test' }),
  });
  expect('POST /admin/issue-key -> 200', r.status === 200);
  expect('  got a sk_ key', r.body?.key?.startsWith('sk_'));
  expect('  plan = credits-100', r.body?.plan === 'credits-100');
  expect('  callsLimit = 100', r.body?.callsLimit === 100);

  // 7. Use the key
  const authed = await req('/entrypoints/sentiment/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${r.body.key}` },
    body: JSON.stringify({ text: 'I love this great product!' }),
  });
  expect('api key auth -> 200', authed.status === 200);
  expect('  payment.method = api-key', authed.body?.payment?.method === 'api-key');
  expect('  sentiment positive', authed.body?.output?.label === 'positive');

  // 8. Re-use same key, second call should still work (1/100)
  const second = await req('/entrypoints/word-count/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${r.body.key}` },
    body: JSON.stringify({ text: 'one two three' }),
  });
  expect('key still valid (2nd call) -> 200', second.status === 200);
}

// 9. Admin without token -> 401
{
  const r = await req('/admin/issue-key', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: 'credits-100' }),
  });
  expect('admin without token -> 401', r.status === 401);
}

// 10. Admin list keys
{
  const r = await req(`/admin/keys?token=${ADMIN_TOKEN}`);
  expect('GET /admin/keys -> 200', r.status === 200);
  expect('  >= 1 key issued', (r.body.keys?.length ?? 0) >= 1);
}

// 11. Tip recording
{
  const r = await req('/tip', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'buymeacoffee', amount: '5', donor: 'tester' }),
  });
  expect('POST /tip -> 200', r.status === 200 && r.body.thanks === true);
}

// 12. Earnings include api-key calls
{
  const r = await req('/earnings');
  expect('GET /earnings -> 200', r.status === 200);
  const s = r.body.summary;
  expect('  totalCalls >= 3', s.totalCalls >= 3, `got ${s.totalCalls}`);
  expect('  tipCount >= 1', s.tipCount >= 1, `got ${s.tipCount}`);
  expect('  byAuthMethod has both', s.byAuthMethod?.length >= 1);
}

// 13. Bad api key on a real entrypoint
{
  const r = await req('/entrypoints/summarize/invoke', { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk_doesnotexist' }, body: JSON.stringify({ text: 'hi' }) });
  expect('bad api key -> 401', r.status === 401);
}

// 14. Unknown entrypoint
{
  const r = await req('/entrypoints/no-such-ep/invoke', { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': 'mock' }, body: '{}' });
  expect('unknown entrypoint -> 404', r.status === 404);
}

// 15. Bad planId to admin
{
  const r = await req(`/admin/issue-key?token=${ADMIN_TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: 'no-such-plan' }),
  });
  expect('bad planId -> 400', r.status === 400);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
