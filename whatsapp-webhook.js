// Signed WhatsApp inbound webhooks for Meta Cloud API and Twilio.

import crypto from 'node:crypto';

const PROVIDER = String(process.env.WHATSAPP_PROVIDER ?? '').trim().toLowerCase();

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (!left.length || left.length !== right.length) return false;
  try { return crypto.timingSafeEqual(left, right); }
  catch { return false; }
}

function metaPayloads(body) {
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      for (const msg of value?.messages ?? []) {
        out.push({
          provider: 'meta',
          from: msg.from,
          messageId: msg.id,
          text: msg.text?.body ?? '',
          timestamp: msg.timestamp,
          phoneNumberId: value?.metadata?.phone_number_id ?? null,
          businessTo: value?.metadata?.display_phone_number ?? null,
          raw: msg,
        });
      }
    }
  }
  return out;
}

function twilioPayload(body) {
  if (!body?.From) return [];
  return [{
    provider: 'twilio',
    from: String(body.From).replace('whatsapp:', ''),
    messageId: body.MessageSid,
    text: body.Body ?? '',
    timestamp: null,
    businessTo: String(body.To ?? '').replace('whatsapp:', '') || null,
    raw: body,
  }];
}

function providerFor(contentType = '') {
  if (PROVIDER) return PROVIDER;
  if (contentType.includes('application/json')) return 'meta';
  if (contentType.includes('application/x-www-form-urlencoded')) return 'twilio';
  return '';
}

export function verifyMetaSignature(rawBody, signatureHeader, secret = process.env.WHATSAPP_APP_SECRET ?? '') {
  if (!secret) return { ok: false, error: 'meta_app_secret_not_configured' };
  const supplied = String(signatureHeader ?? '');
  if (!supplied.startsWith('sha256=')) return { ok: false, error: 'meta_signature_missing' };
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(supplied, expected) ? { ok: true } : { ok: false, error: 'meta_signature_mismatch' };
}

export function verifyTwilioSignature(rawBody, signatureHeader, webhookUrl, authToken = process.env.TWILIO_AUTH_TOKEN ?? '') {
  if (!authToken) return { ok: false, error: 'twilio_auth_token_not_configured' };
  if (!signatureHeader) return { ok: false, error: 'twilio_signature_missing' };
  const params = new URLSearchParams(String(rawBody ?? ''));
  let signed = String(webhookUrl ?? '');
  for (const key of [...new Set([...params.keys()])].sort()) {
    for (const value of params.getAll(key)) signed += key + value;
  }
  const expected = crypto.createHmac('sha1', authToken).update(signed).digest('base64');
  return safeEqual(String(signatureHeader), expected) ? { ok: true } : { ok: false, error: 'twilio_signature_mismatch' };
}

export function parseWhatsAppPayloads(raw, contentType = '', provider = providerFor(contentType)) {
  if (!raw) return [];
  if (provider === 'meta') {
    try { return metaPayloads(JSON.parse(raw)); }
    catch { return []; }
  }
  if (provider === 'twilio') {
    return twilioPayload(Object.fromEntries(new URLSearchParams(raw).entries()));
  }
  return [];
}

/** Backward-compatible parser used by focused tests. */
export async function parseWhatsAppInbound(req, readBody, bodyLimit = 65536) {
  const { text: raw, contentType } = await readBody(req, bodyLimit);
  return parseWhatsAppPayloads(raw, contentType)[0] ?? null;
}

/** GET — Meta webhook verification. */
export function handleWhatsAppVerify(req, url, send, res) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expected = process.env.WHATSAPP_VERIFY_TOKEN ?? '';
  if (mode === 'subscribe' && expected && challenge && safeEqual(token, expected)) {
    send(res, 200, challenge, { 'content-type': 'text/plain; charset=utf-8' });
    return true;
  }
  send(res, 403, { error: 'verify_failed' });
  return true;
}

/** @returns {Promise<boolean>} true if handled */
export async function handleWhatsAppWebhook(req, res, url, {
  send,
  readBody,
  processInbound,
  claimInbound,
  completeInbound,
  publicBaseUrl,
}) {
  if (url.pathname !== '/api/webhooks/whatsapp') return false;
  if (!PROVIDER) {
    send(res, 503, { error: 'whatsapp_not_configured' });
    return true;
  }
  if (req.method === 'GET') return handleWhatsAppVerify(req, url, send, res);
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  const { text: raw, contentType, tooLarge } = await readBody(req, 128 * 1024);
  if (tooLarge) {
    send(res, 413, { error: 'payload_too_large' });
    return true;
  }
  const incomingProvider = providerFor(contentType);
  if (incomingProvider !== PROVIDER) {
    send(res, 400, { error: 'provider_mismatch' });
    return true;
  }

  const verified = PROVIDER === 'meta'
    ? verifyMetaSignature(raw, req.headers['x-hub-signature-256'])
    : verifyTwilioSignature(
      raw,
      req.headers['x-twilio-signature'],
      new URL(req.url, publicBaseUrl || 'http://localhost').toString(),
    );
  if (!verified.ok) {
    const missingConfig = verified.error.endsWith('_not_configured');
    send(res, missingConfig ? 503 : 401, { error: 'invalid_whatsapp_signature', reason: verified.error });
    return true;
  }

  const messages = parseWhatsAppPayloads(raw, contentType, PROVIDER);
  if (!messages.length) {
    send(res, 200, { ok: true, ignored: true, reason: 'no_message' });
    return true;
  }

  const results = [];
  let duplicates = 0;
  for (const inbound of messages) {
    if (!inbound.messageId) {
      results.push({ ok: false, error: 'message_id_required' });
      continue;
    }
    const claim = claimInbound ? claimInbound(inbound) : { mode: 'process' };
    if (!claim) {
      duplicates++;
      continue;
    }
    inbound.claim = claim === true ? { mode: 'process' } : claim;
    try {
      const result = typeof processInbound === 'function'
        ? await processInbound(inbound)
        : { ok: false, error: 'processor_not_configured' };
      const status = Number(result?.status ?? 0);
      const permanentFailure = result?.ok === false && status >= 400 && status < 500;
      const retryable = result?.ok === false && !permanentFailure;
      completeInbound?.(inbound, !retryable, result);
      results.push({ received: inbound.messageId, ...result, retryable });
    } catch (error) {
      console.error('[whatsapp] inbound error:', error?.message ?? error);
      completeInbound?.(inbound, false, { ok: false, error: 'processing_failed' });
      results.push({ received: inbound.messageId, ok: false, error: 'processing_failed' });
    }
  }

  const retryableFailures = results.filter((result) => result.retryable === true);
  send(res, retryableFailures.length ? 500 : 200, {
    ok: retryableFailures.length === 0,
    processed: results.length,
    duplicates,
    results,
    ...(results.length === 1 ? results[0] : {}),
  });
  return true;
}

export function whatsappConfigStatus() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || '';
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID || '';
  const signatureReady = PROVIDER === 'meta'
    ? !!process.env.WHATSAPP_APP_SECRET
    : PROVIDER === 'twilio' ? !!process.env.TWILIO_AUTH_TOKEN : false;
  return {
    enabled: !!PROVIDER,
    provider: PROVIDER || null,
    verifyTokenSet: !!process.env.WHATSAPP_VERIFY_TOKEN,
    signatureReady,
    metaReady: !!(token && phoneId && process.env.WHATSAPP_APP_SECRET),
    twilioReady: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
  };
}
