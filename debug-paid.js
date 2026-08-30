// Debug: check if paid chat actually enforces payment_required.
const target = process.argv[2] || process.env.BASE_URL;
if (!target) {
  console.error('Missing target. Pass an explicit URL: node debug-paid.js https://YOUR_DOMAIN');
  console.error('Or set BASE_URL explicitly before running this destructive debug flow.');
  process.exit(64);
}

let base;
try {
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('target must use http or https');
  base = url.toString().replace(/\/+$/, '');
} catch (error) {
  console.error(`Invalid debug target: ${error.message}`);
  process.exit(64);
}

(async () => {
  const s = await fetch(base + '/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'paid-debug@demo.com', name: 'Paid Debug', businessName: 'X', contact: '0501234567' }),
  }).then(r => r.json());
  const auth = 'Bearer ' + s.key;
  const buy = await fetch(base + '/api/workers/buy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ templateId: 'sales-leads-il', paymentChannel: 'paypal', paymentReference: 'DEBUG' }),
  }).then(r => r.json());
  console.log('worker status, paidUntil:');
  const w = await fetch(base + '/api/workers/' + buy.workerId, { headers: { authorization: auth } }).then(r => r.json());
  console.log('  status:', w.worker?.status, '| paidUntil:', w.worker?.paidUntil, '| isActive:', w.worker?.isActive);
  const r = await fetch(base + '/api/workers/' + buy.workerId + '/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ message: 'hi' }),
  });
  console.log('chat without demoMode:', r.status, await r.text().then(t => t.slice(0, 200)));
})();
