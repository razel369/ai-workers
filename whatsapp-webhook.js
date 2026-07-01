// WhatsApp webhook — mounted from server.js when WHATSAPP_PROVIDER is set.
//
// Supported patterns:
//   - meta: Meta WhatsApp Business Cloud API
//   - twilio: Twilio WhatsApp sandbox / production number

const PROVIDER = process.env.WHATSAPP_PROVIDER ?? '';

function parseMetaPayload(body) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const msg = change?.value?.messages?.[0];
  if (!msg) return null;
  return {
    provider: 'meta',
    from: msg.from,
    messageId: msg.id,
    text: msg.text?.body ?? '',
    timestamp: msg.timestamp,
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
      return parseMetaPayload(body);
    } catch {
      return null;
    }
  }

  if (PROVIDER === 'twilio' || contentType?.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    const body = Object.fromEntries(params.entries());
    return parseTwilioPayload(body);
  }

  return null;
}

/**
 * Route handler stub — call from server.js when enabling WhatsApp.
 * @returns {boolean} true if handled
 */
export async function handleWhatsAppWebhook(req, res, url, { send, readBody }) {
  if (url.pathname !== '/api/webhooks/whatsapp') return false;
  if (!PROVIDER) {
    send(res, 503, { error: 'whatsapp_not_configured' });
    return true;
  }

  if (req.method === 'GET') return handleWhatsAppVerify(req, url, send, res);

  if (req.method === 'POST') {
    const inbound = await parseWhatsAppInbound(req, readBody);
    if (!inbound) {
      send(res, 400, { error: 'unparseable_payload' });
      return true;
    }
    // TODO: map inbound.from → tenant worker, call workers.chat(), reply via provider API
    console.log('[whatsapp-stub] inbound:', inbound.from, inbound.text?.slice(0, 80));
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
  };
}
