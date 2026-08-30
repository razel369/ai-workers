// WhatsApp inbound routing: business phone → tenant worker → AI reply → outbound send.

import { runAction } from './integrations/runner.js';
import * as integrations from './integrations/index.js';

function normalizeDigits(phone = '') {
  return String(phone).replace(/\D/g, '');
}

export function phoneRouteKey({ phoneNumberId, twilioTo, provider = 'meta' }) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (normalizedProvider === 'meta') {
    const normalizedPhoneId = String(phoneNumberId || '').trim();
    return normalizedPhoneId ? `meta:${normalizedPhoneId}` : null;
  }
  if (normalizedProvider === 'twilio') {
    const normalizedTo = normalizeDigits(twilioTo);
    return normalizedTo ? `twilio:${normalizedTo}` : null;
  }
  return null;
}

export function registerWhatsAppRoute(platformDb, { phoneNumberId, twilioTo, tenantId, workerId, provider = 'meta' }) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!['meta', 'twilio'].includes(normalizedProvider)) {
    return { ok: false, error: 'invalid_provider', status: 400 };
  }
  const phoneKey = phoneRouteKey({
    phoneNumberId,
    twilioTo,
    provider: normalizedProvider,
  });
  if (!phoneKey || !tenantId || !workerId) {
    return { ok: false, error: 'route_fields_required', status: 400 };
  }

  // The phone key is the ownership boundary. Never use REPLACE here: SQLite
  // implements it as delete + insert, which would let a different tenant take
  // over an existing public WhatsApp endpoint.
  const inserted = platformDb.prepare(
    `INSERT INTO whatsapp_routes (phone_key, tenant_id, worker_id, provider, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(phone_key) DO NOTHING`
  ).run(phoneKey, tenantId, workerId, normalizedProvider, new Date().toISOString());
  if (Number(inserted.changes ?? 0) === 1) {
    return { ok: true, phoneKey, created: true, idempotent: false };
  }

  const existing = platformDb.prepare(
    `SELECT tenant_id AS tenantId, worker_id AS workerId, provider
       FROM whatsapp_routes
      WHERE phone_key = ?`
  ).get(phoneKey);
  if (existing?.tenantId === tenantId
      && existing?.workerId === workerId
      && existing?.provider === normalizedProvider) {
    return { ok: true, phoneKey, created: false, idempotent: true };
  }

  return { ok: false, error: 'route_already_claimed', status: 409 };
}

export function resolveWhatsAppRoute(platformDb, { phoneNumberId, twilioTo, provider }) {
  const normalizedProvider = String(provider || (phoneNumberId ? 'meta' : twilioTo ? 'twilio' : '')).trim().toLowerCase();
  if (!['meta', 'twilio'].includes(normalizedProvider)) return null;
  const phoneKey = phoneRouteKey({ phoneNumberId, twilioTo, provider: normalizedProvider });
  if (!phoneKey) return null;
  const row = platformDb.prepare(
    `SELECT tenant_id AS tenantId, worker_id AS workerId, provider
       FROM whatsapp_routes
      WHERE phone_key = ? AND provider = ?`
  ).get(phoneKey, normalizedProvider);
  return row ?? null;
}

async function sendWhatsAppReply(tenantId, route, to, text) {
  const waRows = integrations.getIntegrationsByType(tenantId, 'whatsapp');
  const config = waRows[0]?.config;
  const merged = config?.accessToken || config?.phoneNumberId
    ? config
    : { provider: route.provider || 'meta', ...(config ?? {}) };
  return runAction('whatsapp', 'send', { to, text }, merged, { tenantId });
}

export async function processWhatsAppInbound(platformDb, deps, inbound) {
  const { chatWithWorker, logAgentActions, getWorker, persistInboundOutcome } = deps;
  const sendReply = deps.sendReply || sendWhatsAppReply;
  if (!inbound?.from) return { ok: false, error: 'missing_sender', status: 400 };

  const cached = inbound.claim?.mode === 'send' ? inbound.claim.cached : null;
  const route = cached?.tenantId && cached?.workerId
    ? { tenantId: cached.tenantId, workerId: cached.workerId, provider: cached.provider || inbound.provider }
    : resolveWhatsAppRoute(platformDb, {
      phoneNumberId: inbound.phoneNumberId,
      twilioTo: inbound.businessTo,
      provider: inbound.provider,
    });
  if (!route) {
    console.warn('[whatsapp] no route for', inbound.phoneNumberId || inbound.businessTo || '(unknown)');
    return { ok: false, error: 'no_route', status: 404 };
  }

  const customerId = cached?.customerId || `wa:${normalizeDigits(inbound.from)}`;
  const userMessage = (inbound.text || '').trim() || '(הודעה ללא טקסט)';
  let chat;
  let replyText;
  if (cached?.replyText) {
    chat = { ok: true, runtime: cached.runtime || 'cached' };
    replyText = cached.replyText;
  } else {
    const worker = getWorker?.(route.tenantId, route.workerId);
    if (!worker?.isActive) {
      return { ok: false, error: 'worker_not_active', status: 402 };
    }
    chat = await chatWithWorker({
      tenantId: route.tenantId,
      workerId: route.workerId,
      userMessage,
      customerId,
      requestId: `wa:${inbound.provider}:${inbound.messageId}`,
      demoMode: false,
      actor: 'public',
      channel: 'whatsapp',
    });

    if (!chat.ok) {
      return { ok: false, error: chat.error, status: chat.status, message: chat.message };
    }

    if (chat.toolCalls?.length && logAgentActions) {
      logAgentActions(route.tenantId, route.workerId, customerId, chat.toolCalls);
    }

    replyText = (chat.reply || '').trim();
    if (!replyText) return { ok: true, replied: false, runtime: chat.runtime };
    persistInboundOutcome?.(inbound, {
      tenantId: route.tenantId,
      workerId: route.workerId,
      customerId,
      provider: route.provider || inbound.provider,
      replyText: replyText.slice(0, 4096),
      runtime: chat.runtime || '',
    });
  }

  const sendResult = await sendReply(route.tenantId, route, inbound.from, replyText.slice(0, 4096));
  if (!sendResult?.ok) {
    return { ok: false, error: 'send_failed', status: 503, replied: false, runtime: chat.runtime, outcomeCached: true };
  }
  return {
    ok: true,
    replied: true,
    runtime: chat.runtime,
    sendOk: !!sendResult?.ok,
    stub: !!sendResult?.stub,
    messageId: sendResult?.messageId,
    resumed: !!cached,
  };
}
