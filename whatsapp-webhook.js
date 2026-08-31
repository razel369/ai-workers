// WhatsApp webhook — mounted from server.js when WHATSAPP_PROVIDER is set.
//
// Supported patterns:
//   - meta: Meta WhatsApp Business Cloud API
//   - twilio: Twilio WhatsApp sandbox / production number
//
// Inbound POSTs are authenticated before the body is trusted. This endpoint is
// public and drives real LLM spend and real customer replies, so an unsigned
// POST could previously make any worker answer anyone at the tenant's cost, and
// forge messages into a business's conversation history.
//
//   Meta:   X-Hub-Signature-256 = HMAC-SHA256(app secret, raw body)
//   Twilio: X-Twilio-Signature  = base64(HMAC-SHA1(auth token, url + sorted params))
//
// ENV:
//   WHATSAPP_APP_SECRET       # Meta app secret — required to verify signatures
//   TWILIO_AUTH_TOKEN         # doubles as the Twilio signing key
//   WHATSAPP_ALLOW_UNSIGNED=1 # local testing escape hatch only

import crypto from 'node:crypto';

const PROVIDER = process.env.WHATSAPP_PROVIDER ?? '';
const ALLOW_UNSIGNED = process.env.WHATSAPP_ALLOW_UNSIGNED === '1';

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function verifyMetaSignature(rawBody, headerValue) {
  const secret = (process.env.WHATSAPP_APP_SECRET ?? '').trim();
  if (!secret) return { ok: ALLOW_UNSIGNED, reason: 'app_secret_not_configured' };
  const provided = String(headerValue ?? '');
  if (!provided.startsWith('sha256=')) return { ok: false, reason: 'missing_signature' };
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
  return { ok: safeEqual(provided, expected), reason: 'signature_mismatch' };
}

/**
 * Twilio signs the full request URL concatenated with the POST parameters
 * sorted by key. The URL must be the public one the request arrived at, not
 * the internal one, so the caller passes it in.
 */
export function verifyTwilioSignature(publicUrl, params, headerValue) {
  const token = (process.env.TWILIO_AUTH_TOKEN ?? '').trim();
  if (!token) return { ok: ALLOW_UNSIGNED, reason: 'auth_token_not_configured' };
  const provided = String(headerValue ?? '');
  if (!provided) return { ok: false, reason: 'missing_signature' };
  let payload = String(publicUrl);
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  const expected = crypto.createHmac('sha1', token).update(payload, 'utf8').digest('base64');
  return { ok: safeEqual(provided, expected), reason: 'signature_mismatch' };
}

function parseMetaPayload(body) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const msg = value?.messages?.[0];
  if (!msg) return null;
  return {
    provider: 'meta',
    from: msg.from,
    messageId: msg.id,
    text: msg.text?.body ?? '',
    timestamp: msg.timestamp,
    phoneNumberId: value?.metadata?.phone_number_id ?? null,
    businessTo: value?.metadata?.display_phone_number ?? null,
    raw: msg,
  };
}

function parseTwilioPayload(body) {
  if (!body?.From) return null;
  return {
    provider: 'twilio',
    from: body.From.replace('whatsapp:', ''),
    messageId: body.MessageSid,
    text: body.Body ?? '',
    timestamp: null,
    businessTo: body.To?.replace('whatsapp:', '') ?? null,
    raw: body,
  };
}

/**
 * GET — Meta webhook verification (hub.mode, hub.verify_token, hub.challenge).
 */
export function handleWhatsAppVerify(req, url, send, res) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expected = process.env.WHATSAPP_VERIFY_TOKEN ?? '';

  if (mode === 'subscribe' && token && token === expected && challenge) {
    send(res, 200, challenge, { 'content-type': 'text/plain; charset=utf-8' });
    return true;
  }
  send(res, 403, { error: 'verify_failed' });
  return true;
}

/**
 * POST — inbound message webhook (Meta JSON or Twilio form-urlencoded).
 * Returns normalized inbound message or null.
 */
export async function parseWhatsAppInbound(req, readBody, bodyLimit = 65536) {
  const { text: raw, contentType } = await readBody(req, bodyLimit);
  if (!raw) return null;

  if (PROVIDER === 'meta' || contentType?.includes('application/json')) {
    try {
      const body = JSON.parse(raw);
      const parsed = parseMetaPayload(body);
      return parsed ? { ...parsed, rawBody: raw } : null;
    } catch {
      return null;
    }
  }

  if (PROVIDER === 'twilio' || contentType?.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    const body = Object.fromEntries(params.entries());
    const parsed = parseTwilioPayload(body);
    return parsed ? { ...parsed, rawBody: raw, formParams: body } : null;
  }

  return null;
}

/**
 * Route handler stub — call from server.js when enabling WhatsApp.
 * @returns {boolean} true if handled
 */
export async function handleWhatsAppWebhook(req, res, url, { send, readBody, processInbound, publicUrl }) {
  if (url.pathname !== '/api/webhooks/whatsapp') return false;
  if (!PROVIDER) {
    send(res, 503, { error: 'whatsapp_not_configured' });
    return true;
  }

  if (req.method === 'GET') return handleWhatsAppVerify(req, url, send, res);

  if (req.method === 'POST') {
    const inbound = await parseWhatsAppInbound(req, readBody);
    if (!inbound) {
      send(res, 200, { ok: true, ignored: true, reason: 'no_message' });
      return true;
    }

    // Authenticate before doing anything that costs money or writes history.
    const verdict = inbound.provider === 'twilio'
      ? verifyTwilioSignature(publicUrl ?? url.href, inbound.formParams ?? {}, req.headers['x-twilio-signature'])
      : verifyMetaSignature(inbound.rawBody ?? '', req.headers['x-hub-signature-256']);
    if (!verdict.ok) {
      console.warn(`[whatsapp] rejected unsigned/invalid webhook: ${verdict.reason}`);
      send(res, 401, { error: 'invalid_signature', reason: verdict.reason });
      return true;
    }

    if (typeof processInbound === 'function') {
      try {
        const result = await processInbound(inbound);
        send(res, 200, { ok: true, received: inbound.messageId, ...result });
      } catch (e) {
        console.error('[whatsapp] inbound error:', e?.message ?? e);
        send(res, 500, { ok: false, error: 'processing_failed' });
      }
      return true;
    }
    console.log('[whatsapp] inbound (no processor):', inbound.from, inbound.text?.slice(0, 80));
    send(res, 200, { ok: true, stub: true, received: inbound.messageId });
    return true;
  }

  send(res, 405, { error: 'method_not_allowed' });
  return true;
}

export function whatsappConfigStatus() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || '';
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID || '';
  return {
    enabled: !!PROVIDER,
    provider: PROVIDER || null,
    verifyTokenSet: !!process.env.WHATSAPP_VERIFY_TOKEN,
    metaReady: !!(token && phoneId),
    twilioReady: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    signatureVerification: PROVIDER === 'twilio'
      ? (process.env.TWILIO_AUTH_TOKEN ? 'enforced' : 'NOT CONFIGURED')
      : (process.env.WHATSAPP_APP_SECRET ? 'enforced' : 'NOT CONFIGURED'),
    allowUnsigned: ALLOW_UNSIGNED,
  };
}
