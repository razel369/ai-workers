import * as mcpClient from '../mcp-client.js';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
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

async function safeFetch(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS, deps = {}) {
  const validateUrl = deps.validateUrl || validatePublicHttpUrl;
  let currentUrl = String(url || '').trim();
  let method = String(init.method || 'GET').toUpperCase();
  let body = init.body == null
    ? null
    : Buffer.isBuffer(init.body)
      ? init.body
      : Buffer.from(String(init.body));
  let headers = { ...(init.headers || {}) };

  for (let redirect = 0; redirect <= 3; redirect++) {
    // Re-resolve and re-validate every hop, then pin the request to exactly the
    // public addresses that passed validation. This closes both redirect SSRF
    // and DNS-rebinding windows between validation and connection.
    const checked = await validateUrl(currentUrl);
    if (!checked.ok) return { ok: false, error: checked.error, status: 0, url: safeUrlForError(currentUrl) };
    const parsed = new URL(checked.url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const requestHeaders = { ...headers };
    if (body && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-length')) {
      requestHeaders['content-length'] = String(body.length);
    }

    const response = await new Promise((resolve) => {
      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: requestHeaders,
        lookup: pinnedLookup(checked.resolved),
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 500) {
            res.destroy();
            finish({ ok: false, error: 'response_too_large', status: res.statusCode || 0, url: checked.url });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish({
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
          location: res.headers.location,
          url: checked.url,
        }));
        res.on('error', (error) => finish({ ok: false, error: error.message, status: res.statusCode || 0, url: checked.url }));
      });
      req.on('error', (error) => resolve({ ok: false, error: error.message, status: 0, url: checked.url }));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      if (body) req.write(body);
      req.end();
    });

    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      let nextUrl;
      try {
        nextUrl = new URL(response.location, checked.url);
      } catch {
        return { ok: false, error: 'invalid_redirect', status: response.status, url: checked.url };
      }
      const redirectCheck = await validateUrl(nextUrl.toString());
      if (!redirectCheck.ok) {
        return { ok: false, error: redirectCheck.error, status: response.status, url: safeUrlForError(nextUrl.toString()) };
      }
      // Never forward tenant payloads, cookies, bearer tokens, or provider API
      // headers to a different origin. Rejecting is safer than trying to guess
      // which provider-specific headers are credentials.
      if (nextUrl.origin !== parsed.origin) {
        return { ok: false, error: 'cross_origin_redirect_blocked', status: response.status, url: checked.url };
      }
      currentUrl = redirectCheck.url;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
        headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['content-length', 'content-type'].includes(key.toLowerCase())));
      }
      continue;
    }
    return response;
  }
  return { ok: false, error: 'too_many_redirects', status: 0, url: safeUrlForError(currentUrl) };
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
  const requestId = crypto.randomUUID();

  try {
    switch (type) {
      case 'webhook':
        return action === 'test' || action === 'send'
          ? await testWebhook(config, params, ctx)
          : { ok: false, error: 'unknown_action' };
      case 'mcp':
        return action === 'test' ? await testMcp(config) : { ok: false, error: 'unknown_action' };
      case 'email_sendgrid':
        return await runAction('email', action, params, { ...config, provider: 'sendgrid' }, ctx);
      case 'email_smtp':
        return await runAction('email', action, params, { ...config, provider: 'smtp' }, ctx);
      case 'google_calendar':
        if (action === 'test') return await testCalendar(config);
        if (action === 'check_availability') return await checkCalendarAvailability(config, params);
        if (action === 'book_appointment') return await bookCalendarAppointment(config, params, ctx);
        return { ok: false, error: 'unknown_action' };
      case 'whatsapp':
        if (action === 'test') return testWhatsApp(config);
        if (action === 'send') return await sendWhatsAppStub(config, params, ctx);
        return { ok: false, error: 'unknown_action' };
      case 'email':
        if (action === 'test') return await testEmail(config);
        if (action === 'send') return await sendEmail(config, params, ctx);
        return { ok: false, error: 'unknown_action' };
      case 'crm_hubspot':
        if (action === 'test') return await testHubSpot(config);
        if (action === 'sync_lead') return await syncHubSpotLead(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'crm_pipedrive':
        if (action === 'test') return await testPipedrive(config);
        if (action === 'sync_lead') return await syncPipedriveLead(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'crm_monday':
        if (action === 'test') return await testMonday(config);
        if (action === 'sync_lead') return await syncMondayLead(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'shopify':
        if (action === 'test') return await testShopify(config);
        if (action === 'lookup_order') return await lookupShopifyOrder(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'woocommerce':
        if (action === 'test') return await testWooCommerce(config);
        if (action === 'lookup_order') return await lookupWooOrder(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'bit_notify':
        if (action === 'test') return await testBitNotify(config);
        if (action === 'notify') return await notifyBitWebhook(config, params);
        return { ok: false, error: 'unknown_action' };
      case 'google_sheets':
        if (action === 'test') return await testGoogleSheets(config);
        if (action === 'export') return await exportToSheetsWebhook(config, params, ctx);
        return { ok: false, error: 'unknown_action' };
      default:
        return { ok: false, error: 'unsupported_type', type };
    }
  } catch (e) {
    const candidateCode = String(e?.code ?? '').trim();
    const errorCode = /^[A-Z0-9_]{1,64}$/i.test(candidateCode) ? candidateCode : 'action_failed';
    console.error('[integrations] action failed', {
      type: String(type).slice(0, 64),
      action: String(action).slice(0, 64),
      errorCode,
      requestId,
    });
    return { ok: false, error: 'action_failed', requestId };
  }
}

async function testWebhook(config, params = {}, ctx = {}) {
  const url = config.url;
  if (!url && config.hookUrl) {
    return { ok: true, message: 'קישור Webhook מוכן — העתק ל-Zapier או Make', hookUrl: config.hookUrl, mode: 'inbound' };
  }
  if (!url) return { ok: false, error: 'url_required' };
  const headers = { 'content-type': 'application/json', 'user-agent': 'AI-Workers-Integration/1.0' };
  if (ctx.idempotencyKey) headers['x-idempotency-key'] = String(ctx.idempotencyKey).slice(0, 160);
  const r = await safeFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'ping', source: 'ai-workers', at: new Date().toISOString(), ...(params.payload ?? {}) }),
  });
  return r.ok
    ? { ok: true, message: `Webhook responded ${r.status}`, status: r.status }
    : { ok: false, error: r.error || `http_${r.status}`, status: r.status, url: safeUrlForError(url) };
}

async function testMcp(config) {
  if (config.authMethod === 'platform' && config.preset) {
    return { ok: true, message: `שרת MCP (${config.name || config.preset}) מחובר`, mode: 'platform', preset: config.preset };
  }
  const checked = await validatePublicHttpUrl(config.url);
  if (!checked.ok) return { ok: false, error: checked.error };
  const headers = config.authHeader ? { authorization: config.authHeader } : {};
  const tools = await mcpClient.discoverMcpTools(checked.url, headers, { lookup: pinnedLookup(checked.resolved) });
  return { ok: true, message: `נמצאו ${tools.length} כלים`, toolCount: tools.length };
}

async function validateBookingLink(config) {
  const link = config.bookingLink || process.env.MEETING_BOOKING_URL || '';
  if (!link) return { ok: false, error: 'booking_link_required', link: '' };
  const checked = await validatePublicHttpUrl(link);
  if (!checked.ok) return { ok: false, error: checked.error, link: '' };
  return { ok: true, link: checked.url };
}

async function testCalendar(config) {
  if ((config.authMethod === 'oauth' && config.accessToken) || config.apiKey) {
    return {
      ok: false,
      stub: true,
      error: 'calendar_api_not_implemented',
      message: 'פרטי היומן נשמרו, אך קריאת Google Calendar חיה עדיין אינה ממומשת.',
      mode: 'api_scaffold',
    };
  }
  const checked = await validateBookingLink(config);
  if (!checked.ok) return checked;
  return {
    ok: true,
    message: config.bookingLink ? 'קישור הזמנה מוגדר' : 'משתמש ב-MEETING_BOOKING_URL גלובלי',
    bookingLink: checked.link,
  };
}

async function testBitNotify(config) {
  if (!config.bitPhone) return { ok: false, error: 'bit_phone_required' };
  if (config.notifyUrl) return testWebhook({ url: config.notifyUrl }, { payload: { type: 'bit_ping', bitPhone: config.bitPhone } });
  return { ok: false, stub: true, error: 'notify_url_required', message: 'מספר Bit נשמר, אך אין webhook פעיל לקבלת התראות.' };
}

async function testGoogleSheets(config) {
  if (config.exportWebhook) return testWebhook({ url: config.exportWebhook }, { payload: { type: 'sheets_ping' } });
  return { ok: false, stub: true, error: 'export_webhook_required', message: 'Google Sheets אינו מחובר; ייצוא CSV מקומי בלבד זמין לבעל העסק.' };
}

async function checkCalendarAvailability(config, params) {
  const checked = await validateBookingLink(config);
  if (checked.ok) {
    return {
      ok: true,
      slots: [],
      bookingLink: checked.link,
      mode: 'booking_link',
      message: 'לא נבדקה זמינות חיה; יש להפנות את הלקוח לקישור ההזמנה.',
    };
  }
  return {
    ok: false,
    stub: true,
    error: checked.error === 'booking_link_required' ? 'live_calendar_unavailable' : checked.error,
    slots: [],
    bookingLink: null,
    message: 'זמינות חיה ביומן אינה זמינה.',
  };
}

async function bookCalendarAppointment(config, params, ctx) {
  const checked = await validateBookingLink(config);
  const link = checked.ok ? checked.link : '';
  return {
    ok: false,
    booked: false,
    stub: true,
    error: link ? 'customer_confirmation_required' : (checked.error === 'booking_link_required' ? 'calendar_not_configured' : checked.error),
    message: link
      ? `התור לא נקבע. יש לשלוח ללקוח את קישור ההזמנה ולאשר רק לאחר השלמת ההזמנה: ${link}`
      : 'התור לא נקבע: אין חיבור יומן פעיל. יש לאסוף פרטים ולהעביר לאדם.',
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
      ? { ok: false, stub: true, error: 'twilio_send_not_implemented', message: 'פרטי Twilio נשמרו, אך שליחה יוצאת עדיין אינה ממומשת.', provider: 'twilio' }
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
    ok: false,
    error: 'whatsapp_send_not_implemented',
    stub: true,
    message: `הודעת WhatsApp לא נשלחה; מסלול הספק אינו ממומש עבור ${to}.`,
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
  return { ok: false, stub: true, error: 'email_send_not_implemented', message: 'תצורת אימייל נשמרה, אך שליחה בפועל אינה ממומשת.', mode: 'scaffold' };
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

  return { ok: false, stub: true, error: 'email_send_not_implemented', message: `האימייל לא נשלח; נדרשת אינטגרציית שליחה פעילה עבור ${to}.`, to, subject };
}

async function testHubSpot(config) {
  const token = config.accessToken || config.apiKey;
  if (!token) return { ok: false, error: 'oauth_or_api_required', messageHe: 'חבר עם HubSpot דרך כפתור ההתחברות' };
  const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  return r.ok
    ? { ok: true, message: 'HubSpot מחובר' }
    : { ok: false, error: `hubspot_http_${r.status}` };
}

async function syncHubSpotLead(config, params) {
  const token = config.accessToken || config.apiKey;
  if (!token) return { ok: false, error: 'oauth_or_api_required' };
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
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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
  return { ok: false, stub: true, error: 'pipedrive_sync_not_implemented', message: `החיבור נבדק, אך הליד לא נשלח ל-Pipedrive: ${params.fullName || 'ליד'}`, params: redactForLog(params) };
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
  return { ok: false, stub: true, error: 'monday_sync_not_implemented', message: `החיבור נבדק, אך לא נוצר פריט ב-Monday: ${params.fullName || 'ליד'}`, boardId: config.boardId };
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

export function filterShopifyOrdersByIdentity(orders, orderNumber, email) {
  const requestedOrder = String(orderNumber || '').trim().replace(/^#/, '').toLowerCase();
  const requestedEmail = String(email || '').trim().toLowerCase();
  if (!requestedOrder || !requestedEmail) return [];
  return (Array.isArray(orders) ? orders : []).filter((order) => {
    const orderEmail = String(order?.email || order?.customer?.email || '').trim().toLowerCase();
    const possibleOrderNumbers = [order?.name, order?.order_number, order?.number]
      .filter((value) => value !== undefined && value !== null)
      .map((value) => String(value).trim().replace(/^#/, '').toLowerCase());
    return orderEmail === requestedEmail && possibleOrderNumbers.includes(requestedOrder);
  });
}

async function lookupShopifyOrder(config, params) {
  const test = await testShopify(config);
  if (!test.ok) return test;
  const host = config.shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const orderNumber = String(params.orderNumber || params.orderId || '').trim();
  const requestedEmail = String(params.email || '').trim().toLowerCase();
  if (!orderNumber || !requestedEmail) {
    return { ok: false, error: 'order_number_and_email_required', orders: [] };
  }
  const path = `/admin/api/2024-01/orders.json?status=any&name=${encodeURIComponent(orderNumber)}&limit=5`;
  const r = await fetch(`https://${host}${path}`, {
    headers: { 'x-shopify-access-token': config.accessToken },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const data = await r.json().catch(() => ({}));
  const matching = filterShopifyOrdersByIdentity(data.orders, orderNumber, requestedEmail);
  if (!matching.length && (data.orders ?? []).length) {
    return { ok: false, error: 'order_identity_mismatch', orders: [], count: 0, message: 'פרטי האימות אינם תואמים להזמנה.' };
  }
  const orders = matching.map((o) => ({
    id: o.id, name: o.name, emailVerified: true, financialStatus: o.financial_status,
    fulfillmentStatus: o.fulfillment_status, total: o.total_price, currency: o.currency,
    createdAt: o.created_at,
  }));
  return { ok: true, orders, count: orders.length, message: orders.length ? `נמצאו ${orders.length} הזמנות` : 'לא נמצאו הזמנות' };
}

async function testWooCommerce(config) {
  if (!config.siteUrl || !config.consumerKey) return { ok: false, error: 'credentials_required' };
  const base = config.siteUrl.replace(/\/$/, '');
  const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret || ''}`).toString('base64');
  const r = await safeFetch(`${base}/wp-json/wc/v3/system_status`, {
    headers: { authorization: `Basic ${auth}` },
  });
  return r.ok
    ? { ok: true, message: 'WooCommerce מחובר (scaffold)' }
    : { ok: false, error: r.error || `woocommerce_http_${r.status}`, status: r.status };
}

async function lookupWooOrder(config, params) {
  const test = await testWooCommerce(config);
  if (!test.ok) return test;
  return { ok: false, stub: true, error: 'woocommerce_lookup_not_implemented', message: `חיפוש WooCommerce לא בוצע עבור ${params.orderNumber || '?'}.`, orders: [] };
}

async function notifyBitWebhook(config, params) {
  if (!config.notifyUrl) return { ok: false, stub: true, error: 'notify_url_required', message: 'אירוע Bit לא נשלח: אין notifyUrl.', payload: redactForLog(params) };
  return testWebhook({ url: config.notifyUrl }, { payload: { type: 'bit_payment', bitPhone: config.bitPhone, ...params } });
}

async function exportToSheetsWebhook(config, params, ctx) {
  if (!config.exportWebhook) return { ok: false, stub: true, error: 'export_webhook_required', message: 'לא בוצע ייצוא ל-Google Sheets; אין exportWebhook.', csv: params.csv };
  return testWebhook({ url: config.exportWebhook }, { payload: { type: 'leads_export', tenantId: ctx.tenantId, csv: params.csv, rows: params.rows } });
}

export { redactForLog, safeFetch };
