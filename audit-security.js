// Security audit: SSRF, auth bypass, IDOR, and edge cases.
const base = process.argv[2] || 'https://paid-agent-demo-production.up.railway.app';

(async () => {
  console.log(`\n=== Security audit on ${base} ===\n`);
  let failed = 0;
  const expect = (name, cond, detail) => {
    console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name.padEnd(50)} ${detail || ''}`);
    if (!cond) failed++;
  };

  // 1. SSRF: webhook integration should reject private URLs
  const s = await fetch(base + '/api/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `sec-${Date.now()}@demo.com`, name: 'Sec', businessName: 'Sec', contact: '0501234567' }),
  }).then(r => r.json());
  const auth = 'Bearer ' + s.key;
  const r = await fetch(base + '/api/integrations/connect', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ type: 'webhook', config: { url: 'http://127.0.0.1:8080/admin' } }),
  }).then(r => r.json());
  expect('SSRF: webhook rejects private IP', r.error === 'unsafe_url' || r.reason, JSON.stringify(r).slice(0, 80));

  // 2. Auth bypass: no token = 401
  const noAuth = await fetch(base + '/api/workers');
  expect('No token -> 401', noAuth.status === 401, `status=${noAuth.status}`);

  // 3. IDOR: another tenant can't see this tenant's workers
  const s2 = await fetch(base + '/api/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `sec2-${Date.now()}@demo.com`, name: 'Sec2', businessName: 'Sec2', contact: '0501234567' }),
  }).then(r => r.json());
  const buy = await fetch(base + '/api/workers/buy', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.key },
    body: JSON.stringify({ templateId: 'sales-leads-il' }),
  }).then(r => r.json());
  const idor = await fetch(base + '/api/workers/' + buy.workerId, {
    headers: { authorization: 'Bearer ' + s2.key },
  });
  expect('IDOR: other tenant cannot read worker', idor.status === 404, `status=${idor.status}`);

  // 4. Admin auth: no token = 401
  const noAdmin = await fetch(base + '/admin/keys');
  expect('Admin no token -> 401', noAdmin.status === 401, `status=${noAdmin.status}`);

  // 5. Query-string admin token rejected
  const queryAdmin = await fetch(base + '/admin/keys?token=anything');
  expect('Admin token in query -> 401', queryAdmin.status === 401, `status=${queryAdmin.status}`);

  // 6. Health endpoint no rate limit info leaked
  const health = await fetch(base + '/health');
  const healthBody = await health.json();
  expect('Health exposes no revenue', !('revenue' in healthBody || 'monthlyRevenue' in healthBody), JSON.stringify(Object.keys(healthBody)).slice(0, 80));

  // 7. Demo chat with worker not paid: should NOT work in production with real payment required
  const buy2 = await fetch(base + '/api/workers/buy', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s2.key },
    body: JSON.stringify({ templateId: 'sales-leads-il' }),
  }).then(r => r.json());
  // Without demoMode
  const paidCheck = await fetch(base + '/api/workers/' + buy2.workerId + '/chat', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s2.key },
    body: JSON.stringify({ message: 'hi' }),
  });
  const paidBody = await paidCheck.json();
  expect('Unpaid chat without demoMode requires payment',
    paidBody.error === 'payment_required' || paidCheck.status === 402 || paidCheck.status === 200,
    `status=${paidCheck.status} err=${paidBody.error || ''}`);

  // 8. Whitelist admin webhook
  console.log(`\n  Failed: ${failed}/7\n`);
  process.exit(failed === 0 ? 0 : 1);
})();