// E2E audit script — runs against production and reports what works / breaks.
const base = process.argv[2] || 'https://paid-agent-demo-production.up.railway.app';

(async () => {
  const results = [];
  const log = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(40)} ${detail || ''}`);
  };

  console.log(`\n=== Auditing ${base} ===\n`);

  // 1. signup
  const s = await fetch(base + '/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'audit@demo.com', name: 'Audit Test', businessName: 'Audit Co', contact: '0501234567' }),
  }).then(r => r.json());
  log('signup', !!s.key, `key=${s.key?.slice(0, 15) || s.error}`);
  if (!s.key) { console.log('\nSTOPPED — cannot continue without auth'); process.exit(1); }
  const auth = 'Bearer ' + s.key;

  // 2. buy
  const buy = await fetch(base + '/api/workers/buy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ templateId: 'sales-leads-il', paymentChannel: 'paypal', paymentReference: 'AUDIT-001' }),
  }).then(r => r.json());
  log('buy worker', !!buy.workerId, `id=${buy.workerId || buy.error}`);
  const wid = buy.workerId;

  // 3. demo chat (no payment required)
  const chat = await fetch(base + '/api/workers/' + wid + '/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ message: 'שלום, אני מעוניין במוצר שלכם', demoMode: true }),
  }).then(r => r.json());
  log('demo chat (paid)', !!chat.reply, `runtime=${chat.runtime} | ${(chat.reply || '').slice(0, 60)}`);
  // Without demoMode it should 402 (not paid)
  // Note: with TRIAL_DAYS>0 in env, new workers are created active for the trial,
  // so this only checks that non-trial setups would block — informational, not strict.
  const chatPaid = await fetch(base + '/api/workers/' + wid + '/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ message: 'hi' }),
  }).then(r => r.json());
  const trialOk = chatPaid.error === 'payment_required' || (chatPaid.ok && chatPaid.runtime);
  log('paid chat returns response', trialOk, `status=${chatPaid.status} runtime=${chatPaid.runtime || chatPaid.error}`);

  // 4. weekly digest
  const digest = await fetch(base + '/api/workers/' + wid + '/weekly-digest', { headers: { authorization: auth } }).then(r => r.json());
  log('weekly-digest GET', !!digest.worker?.name, `headline="${digest.headline}" kpis=${Object.keys(digest.kpis || {}).length}`);

  const htmlR = await fetch(base + '/api/workers/' + wid + '/weekly-digest.html', { headers: { authorization: auth } });
  const html = await htmlR.text();
  log('weekly-digest.html RTL', htmlR.status === 200 && html.includes('dir="rtl"'), `len=${html.length}`);

  // POST without webhook returns 400
  const noWebhook = await fetch(base + '/api/workers/' + wid + '/weekly-digest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ channel: 'webhook' }),
  }).then(r => r.json());
  log('weekly-digest POST no webhook -> 400', noWebhook.error === 'no_webhook_configured', JSON.stringify(noWebhook).slice(0, 80));

  // 5. insights
  const insights = await fetch(base + '/api/workers/' + wid + '/insights', { headers: { authorization: auth } }).then(r => r.json());
  log('insights', !!insights.worker?.name, `counts=${JSON.stringify(insights.counts)}`);

  // 6. catalog
  const catalog = await fetch(base + '/api/integrations/catalog', { headers: { authorization: auth } }).then(r => r.json());
  log('integrations catalog', Array.isArray(catalog.catalog) && catalog.catalog.length > 0, `count=${catalog.catalog?.length}`);

  // 7. webhook connect
  const wh = await fetch(base + '/api/integrations/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ type: 'webhook' }),
  }).then(r => r.json());
  log('webhook connect', !!wh.integration?.id, `hookUrl=${wh.integration?.config?.hookUrl?.slice(0, 40) || wh.error}`);
  const hookUrl = wh.integration?.config?.hookUrl;
  if (hookUrl) {
    // Test the hook with a fake event
    const parts = hookUrl.match(/\/api\/hooks\/([^/]+)\/([a-f0-9]+)/);
    if (parts) {
      const hookTest = await fetch(base + parts[0], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'test_event', message: 'audit' }),
      }).then(r => r.json());
      log('webhook receives events', hookTest.ok === true, JSON.stringify(hookTest));
    }
  }

  // Now with webhook configured, POST digest should try to send
  const digestWithWebhook = await fetch(base + '/api/workers/' + wid + '/weekly-digest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ channel: 'webhook' }),
  }).then(r => r.json());
  log('weekly-digest POST with webhook -> 200', digestWithWebhook.ok === true, JSON.stringify(digestWithWebhook).slice(0, 100));

  // 8. account + admin
  const account = await fetch(base + '/api/account', { headers: { authorization: auth } }).then(r => r.json());
  log('account endpoint', !!account.tenantId, `tenantId=${account.tenantId?.slice(0, 12)}`);

  // 9. marketplace UI
  const mp = await fetch(base + '/marketplace');
  const mpText = await mp.text();
  log('marketplace UI loads', mp.status === 200 && mpText.includes('תבניות'), `status=${mp.status} len=${mpText.length}`);

  // 10. embed.js
  const embed = await fetch(base + '/embed.js');
  const embedText = await embed.text();
  log('embed.js loads', embed.status === 200 && embedText.includes('aiw-embed-root'), `len=${embedText.length}`);

  console.log(`\n=== Summary ===`);
  const failed = results.filter(r => !r.ok);
  console.log(`Passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log(`Failed:`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });