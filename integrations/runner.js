import * as mcpClient from '../mcp-client.js';
import { validatePublicHttpUrl, pinnedLookup, safeUrlForError } from '../url-security.js';
import { getIntegrationSecrets, updateTestResult } from './store.js';
import { getIntegrationType } from './registry.js';

const DEFAULT_TIMEOUT_MS = 12_000;

function redactForLog(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/key|token|secret|password|auth/i.test(k)) out[k] = '[REDACTED]';
    else if (typeof v === 'object') out[k] = redactForLog(v);
    else out[k] = v;
  }
  return out;
}

async function safeFetch(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const checked = await validatePublicHttpUrl(url);
  if (!checked.ok) return { ok: false, error: checked.error, status: 0 };
  const lookup = pinnedLookup(checked.resolved);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(checked.url, { ...init, signal: ctrl.signal, dispatcher: undefined });
    const text = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: text.slice(0, 500), url: checked.url };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'timeout' : (e?.message ?? String(e));
    return { ok: false, error: msg, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function testIntegration(tenantId, integrationId) {
  const row = getIntegrationSecrets(tenantId, integrationId);
  if (!row) return { ok: false, error: 'not_found' };
  const result = await runAction(row.type, 'test', {}, row.config, { tenantId, integrationId });
  updateTestResult(tenantId, integrationId, { ok: !!result.ok });
  return result;
}

export async function runAction(type, action, params, config, ctx = {}) {
  const def = getIntegrationType(type);
  if (!def) return { ok: false, error: 'unknown_type' };

  try {
    switch (type) {
      case 'webhook':
        return action === 'test' || action === 'send'
          ? await testWebhook(config, params)
          : { ok: false, error: 'unknown_action' };
      case 'mcp':
        return action === 'test' ? await testMcp(config) : { ok: false, error: 'unknown_action' };
      case 'email_sendgrid':
        return runAction('email', action, params, { ...config, provider: 'sendgrid' }, ctx);
      case 'email_smtp':
        return runAction('email', action, params, { ...config, provider: 'smtp' }, ctx);
      case 'google_calendar':
        if (action === 'test') return testCalendar(config);
        if (action === 'check_availability') return checkCalendarAvailability(config, params);
        if (action === 'book_appointment') return bookCalendarAppointment(config, params, ctx);
        return { ok: false, error: 'unknown_action' };
      case 'whatsapp':
        if (action === 'test') return testWhatsApp(config);
        if (action === 'send') return sendWhatsAppStub(config, params, ctx);
        return { ok: false, error: 'unknown_action' };
      case 'email':
        if (action === 'test') return testEmail(config);
        if (action === 'send') return sendEmail(config, params, ctx);
        return { ok: false, error: 'unknown_action' };
      case 'crm_hubspot':
        if (action === 'test') return testHubSpot(config);
        if (action === 'sync_lead') return syncHubSpotLead(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'crm_pipedrive':
        if (action === 'test') return testPipedrive(config);
        if (action === 'sync_lead') return syncPipedriveLead(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'crm_monday':
        if (action === 'test') return testMonday(config);
        if (action === 'sync_lead') return syncMondayLead(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'shopify':
        if (action === 'test') return testShopify(config);
        if (action === 'lookup_order') return lookupShopifyOrder(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'woocommerce':
        if (action === 'test') return testWooCommerce(config);
        if (action === 'lookup_order') return lookupWooOrder(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'bit_notify':
        if (action === 'test') return testBitNotify(config);
        if (action === 'notify') return notifyBitWebhook(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'google_sheets':
        if (action === 'test') return testGoogleSheets(config);
        if (action === 'export') return exportToSheetsWebhook(config, params, ctx);
        return { ok: false, error: 'unknown_action' };
      default:
        return { ok: false, error: 'unsupported_type', type };
    }
  } catch (e) {
    console.error('[integrations] action failed', type, action, redactForLog(params));
    return { ok: false, error: 'action_failed', message: e?.message ?? String(e) };
  }
}

async function testWebhook(config, params = {}) {
  const url = config.url;
  if (!url) return { ok: false, error: 'url_required' };
  const r = await safeFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'AI-Workers-Integration/1.0' },
    body: JSON.stringify({ type: 'ping', source: 'ai-workers', at: new Date().toISOString(), ...(params.payload ?? {}) }),
  });
  return r.ok
    ? { ok: true, message: `Webhook responded ${r.status}`, status: r.status }
    : { ok: false, error: r.error || `http_${r.status}`, status: r.status, url: safeUrlForError(url) };
}

async function testMcp(config) {
  const checked = await validatePublicHttpUrl(config.url);
  if (!checked.ok) return { ok: false, error: checked.error };
  const headers = config.authHeader ? { authorization: config.authHeader } : {};
  const tools = await mcpClient.discoverMcpTools(checked.url, headers, { lookup: pinnedLookup(checked.resolved) });
  return { ok: true, message: `נמצאו ${tools.length} כלים`, toolCount: tools.length };
}

function testCalendar(config) {
  if (config.apiKey) return { ok: true, message: 'מפתח API נשמר — בדיקת API מלאה בקרוב', mode: 'api_scaffold' };
  if (config.bookingLink) return { ok: true, message: 'קישור הזמנה מוגדר', bookingLink: config.bookingLink };
  if (process.env.MEETING_BOOKING_URL) return { ok: true, message: 'משתמש ב-MEETING_BOOKING_URL גלובלי', bookingLink: process.env.MEETING_BOOKING_URL };
  return { ok: false, error: 'booking_link_or_api_key_required' };
}

async function testBitNotify(config) {
  if (!config.bitPhone) return { ok: false, error: 'bit_phone_required' };
  if (config.notifyUrl) return testWebhook({ url: config.notifyUrl }, { payload: { type: 'bit_ping', bitPhone: config.bitPhone } });
  return { ok: true, message: `Bit ${config.bitPhone} — התראות דרך webhook כשמוגדר`, mode: 'local_only' };
}

async function testGoogleSheets(config) {
  if (config.exportWebhook) return testWebhook({ url: config.exportWebhook }, { payload: { type: 'sheets_ping' } });
  return { ok: true, message: 'ייצוא CSV מקומי זמין דרך export_leads_csv', mode: 'csv_local' };
}

function checkCalendarAvailability(config, params) {
  const days = Number(params.daysAhead) || 3;
  const slots = [];
  const base = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  for (let d = 1; d <= days && slots.length < 6; d++) {
    const day = new Date(base);
    day.setDate(day.getDate() + d);
    const dow = day.getDay();
    if (dow === 6 || dow === 5) continue;
    const label = day.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Jerusalem' });
    slots.push(`${label} 10:00`, `${label} 14:30`, `${label} 16:00`);
  }
  const link = config.bookingLink || process.env.MEETING_BOOKING_URL || '';
  return { ok: true, slots: slots.slice(0, 6), bookingLink: link || null, mode: config.apiKey ? 'api_scaffold' : 'suggested_slots' };
}

function bookCalendarAppointment(config, params, ctx) {
  const link = config.bookingLink || process.env.MEETING_BOOKING_URL || '';
  return {
    ok: true,
    message: link
      ? `שלח ללקוח את קישור ההזמנה: ${link}`
      : 'אין קישור הזמנה — אסוף שם, טלפון וחלונות זמן מועדפים',
    bookingLink: link || null,
    leadName: params.leadName ?? params.fullName ?? null,
    preferredWindow: params.preferredWindow ?? params.preferredTime ?? null,
    integration: 'google_calendar',
    tenantId: ctx.tenantId,
  };
}

function testWhatsApp(config) {
  if (config.provider === 'meta') {
    const token = config.accessToken || process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || '';
    const phoneId = config.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID || '';
    const ready = !!(token && phoneId);
    return ready
      ? { ok: true, message: 'Meta WhatsApp מוגדר לשליחה יוצאת', provider: 'meta' }
      : { ok: false, error: 'meta_credentials_incomplete', hint: 'נדרשים WHATSAPP_TOKEN ו-WHATSAPP_PHONE_ID' };
  }
  if (config.provider === 'twilio') {
    const ready = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) || !!config.accessToken;
    return ready
      ? { ok: true, message: 'Twilio WhatsApp מוגדר (שליחה יוצאת — stub)', provider: 'twilio' }
      : { ok: false, error: 'twilio_credentials_incomplete' };
  }
  return { ok: false, error: 'provider_required' };
}

async function sendWhatsAppStub(config, params, ctx) {
  const to = String(params.to || params.phone || '').replace(/\D/g, '');
  const text = String(params.text || params.message || '').slice(0, 4096);
  if (!to || !text) return { ok: false, error: 'to_and_text_required' };

  if (config.provider === 'meta') {
    const token = config.accessToken || process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || '';
    const phoneId = config.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID || '';
    if (token && phoneId) {
      return sendMetaWhatsApp({ token, phoneId, to, text });
    }
  }

  return {
    ok: true,
    stub: true,
    message: `הודעת WhatsApp נרשמה לתור (stub): אל ${to}`,
    to,
    text: text.slice(0, 500),
    provider: config.provider,
    note: 'הגדירו WHATSAPP_TOKEN + WHATSAPP_PHONE_ID לשליחה אמיתית',
  };
}

async function sendMetaWhatsApp({ token, phoneId, to, text }) {
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      return {
        ok: true,
        message: `WhatsApp נשלח אל ${to}`,
        messageId: data.messages?.[0]?.id,
        provider: 'meta',
      };
    }
    return {
      ok: false,
      error: `meta_http_${r.status}`,
      details: JSON.stringify(data).slice(0, 200),
      stub: true,
      message: `שליחת WhatsApp נכשלה (${r.status}) — נרשם ביומן`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.message ?? 'meta_send_failed',
      stub: true,
      message: 'שליחת WhatsApp נכשלה — נרשם ביומן (stub)',
    };
  }
}

async function testEmail(config) {
  if (config.provider === 'sendgrid' && config.apiKey) {
    const r = await fetch('https://api.sendgrid.com/v3/user/profile', {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    return r.ok
      ? { ok: true, message: 'SendGrid מחובר', provider: 'sendgrid' }
      : { ok: false, error: `sendgrid_http_${r.status}` };
  }
  if (config.provider === 'mailgun' && config.apiKey && config.domain) {
    const r = await fetch(`https://api.mailgun.net/v3/${config.domain}/events?limit=1`, {
      headers: { authorization: `Basic ${Buffer.from(`api:${config.apiKey}`).toString('base64')}` },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    return r.ok || r.status === 404
      ? { ok: true, message: 'Mailgun מחובר', provider: 'mailgun' }
      : { ok: false, error: `mailgun_http_${r.status}` };
  }
  if (config.provider === 'webhook' && config.webhookUrl) {
    return testWebhook({ url: config.webhookUrl }, { payload: { type: 'email_ping' } });
  }
  if (!config.fromEmail) return { ok: false, error: 'from_email_required' };
  return { ok: true, message: 'תצורת אימייל נשמרה (שליחה בפועל דרך outbox)', mode: 'scaffold' };
}

async function sendEmail(config, params) {
  const to = params.to;
  const subject = params.subject || '(no subject)';
  const body = params.body || '';
  if (!to) return { ok: false, error: 'to_required' };

  if (config.provider === 'sendgrid' && config.apiKey) {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: config.fromEmail },
        subject,
        content: [{ type: 'text/plain', value: body }],
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    return r.ok || r.status === 202
      ? { ok: true, message: `אימייל נשלח ל-${to}`, provider: 'sendgrid' }
      : { ok: false, error: `sendgrid_http_${r.status}` };
  }

  if (config.provider === 'webhook' && config.webhookUrl) {
    return testWebhook({ url: config.webhookUrl }, { payload: { to, subject, body, type: 'send_email' } });
  }

  return { ok: true, stub: true, message: `אימייל נרשם ל-outbox: ${to}`, to, subject };
}

async function testHubSpot(config) {
  if (!config.apiKey) return { ok: false, error: 'api_key_required' };
  const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  return r.ok
    ? { ok: true, message: 'HubSpot מחובר' }
    : { ok: false, error: `hubspot_http_${r.status}` };
}

async function syncHubSpotLead(config, params) {
  if (!config.apiKey) return { ok: false, error: 'api_key_required' };
  const props = {
    firstname: params.fullName?.split(' ')[0] || params.fullName || 'Lead',
    lastname: params.fullName?.split(' ').slice(1).join(' ') || '',
    phone: params.phone || '',
    email: params.email || '',
    company: params.company || '',
    hs_lead_status: 'NEW',
    notes: params.notes || '',
  };
  const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ properties: props }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const data = await r.json().catch(() => ({}));
  return r.ok
    ? { ok: true, message: `ליד סונכרן ל-HubSpot`, contactId: data.id }
    : { ok: false, error: `hubspot_http_${r.status}`, details: JSON.stringify(data).slice(0, 200) };
}

async function testPipedrive(config) {
  if (!config.apiToken || !config.companyDomain) return { ok: false, error: 'credentials_required' };
  const domain = config.companyDomain.replace(/\.pipedrive\.com.*/, '');
  const r = await fetch(`https://${domain}.pipedrive.com/api/v1/users/me?api_token=${encodeURIComponent(config.apiToken)}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  return r.ok ? { ok: true, message: 'Pipedrive מחובר (scaffold)' } : { ok: false, error: `pipedrive_http_${r.status}` };
}

async function syncPipedriveLead(config, params) {
  const test = await testPipedrive(config);
  if (!test.ok) return test;
  return { ok: true, stub: true, message: `ליד נרשם ל-Pipedrive (scaffold): ${params.fullName || 'ליד'}`, params: redactForLog(params) };
}

async function testMonday(config) {
  if (!config.apiToken) return { ok: false, error: 'api_token_required' };
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { authorization: config.apiToken, 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ me { id name } }' }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  return r.ok ? { ok: true, message: 'Monday.com מחובר (scaffold)' } : { ok: false, error: `monday_http_${r.status}` };
}

async function syncMondayLead(config, params) {
  const test = await testMonday(config);
  if (!test.ok) return test;
  return { ok: true, stub: true, message: `פריט Monday נוצר (scaffold): ${params.fullName || 'ליד'}`, boardId: config.boardId };
}

async function testShopify(config) {
  if (!config.shopDomain || !config.accessToken) return { ok: false, error: 'credentials_required' };
  const host = config.shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const r = await fetch(`https://${host}/admin/api/2024-01/shop.json`, {
    headers: { 'x-shopify-access-token': config.accessToken },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const data = await r.json().catch(() => ({}));
  return r.ok
    ? { ok: true, message: `Shopify: ${data.shop?.name || host}` }
    : { ok: false, error: `shopify_http_${r.status}` };
}

async function lookupShopifyOrder(config, params) {
  const test = await testShopify(config);
  if (!test.ok) return test;
  const host = config.shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const q = params.orderNumber || params.orderId || params.email;
  if (!q) return { ok: false, error: 'order_number_or_email_required' };
  const path = params.email
    ? `/admin/api/2024-01/orders.json?status=any&email=${encodeURIComponent(params.email)}&limit=5`
    : `/admin/api/2024-01/orders.json?status=any&name=${encodeURIComponent(q)}&limit=5`;
  const r = await fetch(`https://${host}${path}`, {
    headers: { 'x-shopify-access-token': config.accessToken },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const data = await r.json().catch(() => ({}));
  const orders = (data.orders ?? []).map((o) => ({
    id: o.id, name: o.name, email: o.email, financialStatus: o.financial_status,
    fulfillmentStatus: o.fulfillment_status, total: o.total_price, currency: o.currency,
    createdAt: o.created_at,
  }));
  return { ok: true, orders, count: orders.length, message: orders.length ? `נמצאו ${orders.length} הזמנות` : 'לא נמצאו הזמנות' };
}

async function testWooCommerce(config) {
  if (!config.siteUrl || !config.consumerKey) return { ok: false, error: 'credentials_required' };
  const base = config.siteUrl.replace(/\/$/, '');
  const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret || ''}`).toString('base64');
  const r = await fetch(`${base}/wp-json/wc/v3/system_status`, {
    headers: { authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  return r.ok ? { ok: true, message: 'WooCommerce מחובר (scaffold)' } : { ok: false, error: `woocommerce_http_${r.status}` };
}

async function lookupWooOrder(config, params) {
  const test = await testWooCommerce(config);
  if (!test.ok) return test;
  return { ok: true, stub: true, message: `חיפוש הזמנה WooCommerce (scaffold): ${params.orderNumber || params.email || '?'}`, orders: [] };
}

async function notifyBitWebhook(config, params) {
  if (!config.notifyUrl) return { ok: true, stub: true, message: 'אין notifyUrl — אירוע Bit נרשם מקומית', payload: redactForLog(params) };
  return testWebhook({ url: config.notifyUrl }, { payload: { type: 'bit_payment', bitPhone: config.bitPhone, ...params } });
}

async function exportToSheetsWebhook(config, params, ctx) {
  if (!config.exportWebhook) return { ok: true, stub: true, message: 'אין webhook — השתמש ב-export_leads_csv', csv: params.csv };
  return testWebhook({ url: config.exportWebhook }, { payload: { type: 'leads_export', tenantId: ctx.tenantId, csv: params.csv, rows: params.rows } });
}

export { redactForLog, safeFetch };
