// Platform tests for AI Workers.
// Covers: health, payment information, admin key issuance, earnings, tips, marketplace.

const BASE = process.env.BASE_URL ?? 'http://localhost:8765';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token';
let failures = 0;
const ok = (l) => console.log(`OK    ${l}`);
const fail = (l, d) => { failures++; console.log(`FAIL  ${l}${d ? ' \u2014 ' + d : ''}`); };
const expect = (l, c, d) => c ? ok(l) : fail(l, d);
const adminAuth = { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' };
let oauthOwnerCookie = '';
let oauthOtherCookie = '';

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
  expect('  statusHe in Hebrew', r.body.statusHe === 'מוכן לעבודה' || r.body.statusHe === 'צריך הגדרה');
  expect('  exposes finite monthly chat limit', Number.isInteger(r.body.monthlyChatLimit) && r.body.monthlyChatLimit > 0);
  expect('  product analytics are aggregate-only', r.body.productAnalytics?.privacy === 'aggregate_counts_only');
}
{
  const r = await req('/health', {
    headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
  });
  expect('spoofed forwarded host ignored by default', r.status === 200 && !String(r.body.publicBaseUrl).includes('evil.example'));
}
{
  const r = await req('/ready');
  expect('GET /ready blocks incomplete production config', r.status === 503 && r.body?.ok === false);
  expect('  readiness checks SQLite', r.body?.persistence?.dbOk === true);
  expect('  readiness checks aligned writable data paths', r.body?.persistence?.pathsAligned === true && r.body?.persistence?.writable === true);
  expect('  readiness reports missing LLM config', r.body?.configuration?.llmConfigured === false);
}
{
  const r = await req('/infra-ready');
  expect('GET /infra-ready verifies local SQLite and writable paths', r.status === 200
    && r.body?.ok === true
    && r.body?.persistence?.dbOk === true
    && r.body?.persistence?.writable === true);
}

// 2. Invoice
{
  const r = await req('/invoice');
  expect('GET /invoice -> 200 text', r.status === 200 && String(r.body).includes('ORDER AND PAYMENT INFORMATION'));
  expect('  clearly states it is not a tax document', String(r.body).includes('NOT A TAX DOCUMENT'));
  expect('  mentions AI WORKER TEMPLATES', String(r.body).includes('AI WORKER TEMPLATES'));
}

// 3. Invoice.txt
{
  const r = await req('/invoice.txt');
  expect('GET /invoice.txt -> 200', r.status === 200);
}

// 3b. Legal copy follows the configured-channel model
{
  const terms = await req('/terms');
  const privacy = await req('/privacy');
  expect('GET /terms and /privacy -> 200', terms.status === 200 && privacy.status === 200);
  expect('  terms distinguish manual and verified automatic activation', String(terms.body).includes('תשלום ידני דורש בדיקה') && String(terms.body).includes('סליקה אוטומטית'));
  expect('  privacy accurately describes hashed account secrets', String(privacy.body).includes('גיבוב חד-כיווני') && !String(privacy.body).includes('מפתח API (מוצפן)'));
  expect('  privacy names retention and aggregate-only metrics', String(privacy.body).includes('180 יום') && String(privacy.body).includes('ספירות מצטברות'));
  expect('  privacy renders a real contact instead of an env placeholder', String(privacy.body).includes('support@ai-workers.test') && !String(privacy.body).includes('AGENT_OWNER_CONTACT'));
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

// 5b. Self-serve signup issues an HttpOnly owner session, not a browser API key
{
  const r = await req('/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessName: 'Self Serve Test', contact: 'buyer@example.com' }),
  });
  const sessionCookie = String(r.headers.get('set-cookie') ?? '').split(';')[0];
  expect('POST /api/signup -> 201', r.status === 201);
  expect('  signup does not expose tenant key', !r.body?.key);
  expect('  signup returns one-time recovery code', r.body?.recoveryCode?.startsWith('rcv_'));
  expect('  signup sets HttpOnly SameSite cookie', /aiw_owner_session=/.test(sessionCookie)
    && String(r.headers.get('set-cookie')).includes('HttpOnly')
    && String(r.headers.get('set-cookie')).includes('SameSite=Lax'));
  expect('  signup returns stable tenant id', r.body?.tenantId?.startsWith('ten_'));
  const session = await req('/api/session', { headers: { cookie: sessionCookie } });
  expect('GET /api/session -> 200', session.status === 200 && session.body?.authMethod === 'session');
  const account = await req('/api/account', { headers: { cookie: sessionCookie } });
  expect('GET /api/account -> 200', account.status === 200);
  expect('  account tenant matches signup', account.body?.tenantId === r.body.tenantId);
  expect('  account exposes monthly chat allowance', account.body?.callsUsed === 0
    && account.body?.callsRemaining === account.body?.callsLimit
    && /^\d{4}-\d{2}$/.test(account.body?.usagePeriod ?? ''));
  expect('  account exposes the separate provider-call cost guard', account.body?.providerCallsUsed === 0
    && account.body?.providerCallsLimit > 0
    && account.body?.providerCallsRemaining === account.body?.providerCallsLimit
    && /^\d{4}-\d{2}$/.test(account.body?.providerUsagePeriod ?? ''));
  const csrfBlocked = await req('/api/account/rotate-key', { method: 'POST', headers: { cookie: sessionCookie } });
  expect('  cookie mutations require CSRF header', csrfBlocked.status === 401);
  const rotated = await req('/api/account/rotate-key', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'x-aiw-csrf': '1' },
  });
  expect('POST /api/account/rotate-key -> 200', rotated.status === 200 && rotated.body?.ok === true);
  expect('  rotated key keeps tenant id', rotated.body?.tenantId === r.body.tenantId);
  expect('  explicit rotation returns API key once', rotated.body?.key?.startsWith('sk_'));
  const apiKeyCheck = await req('/api/account', { headers: { authorization: 'Bearer ' + rotated.body.key } });
  expect('  rotated API key authenticates', apiKeyCheck.status === 200);
  const sessionStillWorks = await req('/api/session', { headers: { cookie: sessionCookie } });
  expect('  API key rotation does not revoke owner session', sessionStillWorks.status === 200);

  const recovered = await req('/api/account/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'buyer@example.com', recoveryCode: r.body.recoveryCode }),
  });
  const recoveredCookie = String(recovered.headers.get('set-cookie') ?? '').split(';')[0];
  expect('POST /api/account/recover -> 200', recovered.status === 200 && recovered.body?.recoveryCode?.startsWith('rcv_'));
  const oldSession = await req('/api/session', { headers: { cookie: sessionCookie } });
  const recoveredSession = await req('/api/session', { headers: { cookie: recoveredCookie } });
  expect('  recovery revokes old sessions and opens a new one', oldSession.status === 401 && recoveredSession.status === 200);
  oauthOwnerCookie = recoveredCookie;
}
{
  const r = await req('/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessName: '', contact: '' }),
  });
  expect('signup validates required fields -> 400', r.status === 400);
}

// 5c. OAuth linking is bound to the exact initiating browser-owner session.
{
  const secondOwner = await req('/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessName: 'Other OAuth Owner', contact: 'oauth-other@example.com' }),
  });
  oauthOtherCookie = String(secondOwner.headers.get('set-cookie') ?? '').split(';')[0];
  expect('second owner session created for OAuth isolation test', secondOwner.status === 201 && /aiw_owner_session=/.test(oauthOtherCookie));

  const noCsrf = await req('/api/integrations/oauth/start', {
    method: 'POST',
    headers: { cookie: oauthOwnerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'shopify', extra: { shop: 'oauth-owner.myshopify.com' } }),
  });
  expect('OAuth start requires first-party CSRF header', noCsrf.status === 401 && noCsrf.body?.error === 'owner_session_required');

  const externalReturn = await req('/api/integrations/oauth/start', {
    method: 'POST',
    headers: { cookie: oauthOwnerCookie, 'content-type': 'application/json', 'x-aiw-csrf': '1' },
    body: JSON.stringify({
      type: 'shopify',
      returnPath: 'https://attacker.example/collect',
      extra: { shop: 'oauth-owner.myshopify.com' },
    }),
  });
  expect('OAuth start rejects external returnPath', externalReturn.status === 400 && externalReturn.body?.error === 'invalid_return_path');

  const started = await req('/api/integrations/oauth/start', {
    method: 'POST',
    headers: { cookie: oauthOwnerCookie, 'content-type': 'application/json', 'x-aiw-csrf': '1' },
    body: JSON.stringify({
      type: 'shopify',
      returnPath: '/marketplace#/workers/connect/wk_oauth_test',
      extra: { shop: 'oauth-owner.myshopify.com' },
    }),
  });
  expect('OAuth start accepts a safe marketplace integration return path', started.status === 200 && started.body?.state);

  const noSessionCallback = await req(`/api/integrations/oauth/callback?state=${encodeURIComponent(started.body?.state ?? '')}&error=access_denied`, {
    redirect: 'manual',
  });
  expect('OAuth callback without owner session fails closed', noSessionCallback.status === 302
    && String(noSessionCallback.headers.get('location') ?? '').startsWith('/marketplace?oauth=error'));

  const otherSessionCallback = await req(`/api/integrations/oauth/callback?state=${encodeURIComponent(started.body?.state ?? '')}&error=access_denied`, {
    headers: { cookie: oauthOtherCookie },
    redirect: 'manual',
  });
  expect('OAuth callback from another owner session fails closed', otherSessionCallback.status === 302
    && String(otherSessionCallback.headers.get('location') ?? '').startsWith('/marketplace?oauth=error'));

  const ownerCallback = await req(`/api/integrations/oauth/callback?state=${encodeURIComponent(started.body?.state ?? '')}&error=access_denied`, {
    headers: { cookie: oauthOwnerCookie },
    redirect: 'manual',
  });
  const replay = await req(`/api/integrations/oauth/callback?state=${encodeURIComponent(started.body?.state ?? '')}&code=replayed`, {
    headers: { cookie: oauthOwnerCookie },
    redirect: 'manual',
  });
  expect('initiating owner can consume a denied callback exactly once', ownerCallback.status === 302
    && replay.status === 302
    && decodeURIComponent(String(replay.headers.get('location') ?? '')).includes('פג תוקף החיבור'));
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
  expect('  illustrative use cases are clearly labeled', String(r.body).includes('id="case-studies"') && String(r.body).includes('תרחישי שימוש להמחשה') && String(r.body).includes('אינן תוצאות של לקוחות'));
  expect('  does not publish fabricated testimonial identities', !String(r.body).includes('ש. כהן') && !String(r.body).includes('ד. לוי') && !String(r.body).includes('ר. אברהם'));
  expect('  does not claim unsupported popularity or WhatsApp handling', !String(r.body).includes('הכי נבחר') && !String(r.body).includes('לקוח כתב בוואטסאפ — נענה'));
  expect('  payment copy only promises configured options', String(r.body).includes('אפשרויות התשלום הזמינות מוצגות בעת ההפעלה') && !String(r.body).includes('תשלום בכרטיס אשראי (Paddle), Bit'));
  expect('  magic CTA on landing', String(r.body).includes('href="/marketplace#/magic" class="cta"'));
  expect('  does not promise an unconfigured 14-day trial', !String(r.body).includes('ניסיון 14 ימים'));
}

// 10. Marketplace HTML page
{
  const r = await req('/marketplace');
  expect('GET /marketplace -> 200', r.status === 200);
  const csp = r.headers.get('content-security-policy') ?? '';
  expect('  HTML allows Google font styles only', csp.includes("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"));
  expect('  HTML limits browser fetches to same origin', csp.includes("connect-src 'self'"));
  expect('  serves Hebrew HTML', String(r.body).includes('שוק העובדים'));
  expect('  template badges avoid unsupported social proof', !String(r.body).includes('בחירת עסקים'));
  expect('  WhatsApp capability is explicitly configuration-gated', String(r.body).includes('WhatsApp רק לאחר חיבור מאומת') && !String(r.body).includes('תוך פחות מדקה יהיה לכם עובד שעונה ללקוחות בוואטסאפ'));
}
{
  const invalidEvent = await req('/api/public/product-event', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'email_or_message_payload' }),
  });
  expect('product analytics reject arbitrary event payloads', invalidEvent.status === 400);
  const magicEvent = await req('/api/public/product-event', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'magic_started', email: 'must-not-be-stored@example.com' }),
  });
  expect('product analytics accept an allow-listed aggregate event', magicEvent.status === 202);
  const denied = await req('/api/admin/product-metrics');
  expect('product metrics require admin -> 401', denied.status === 401);
  const r = await req('/api/admin/product-metrics?days=30', { headers: adminAuth });
  expect('GET /api/admin/product-metrics -> 200', r.status === 200);
  expect('  metrics contain aggregate counts only', r.body.metrics?.privacy === 'aggregate_counts_only'
    && r.body.metrics?.approximate === true
    && r.body.metrics?.totals?.landing_view >= 1
    && r.body.metrics?.totals?.marketplace_view >= 1
    && r.body.metrics?.totals?.magic_started >= 1
    && !JSON.stringify(r.body).includes('buyer@example.com')
    && !JSON.stringify(r.body).includes('must-not-be-stored@example.com'));
  const operations = await req('/api/admin/operations', { headers: adminAuth });
  expect('GET /api/admin/operations -> 200', operations.status === 200
    && typeof operations.body?.readiness === 'object'
    && operations.body?.backup?.present === false
    && operations.body?.limits?.monthlyChat > 0);
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
  expect('  exposes the real monthly starting price', r.body.startingPriceIls === 199);
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
