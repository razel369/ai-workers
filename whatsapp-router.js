// WhatsApp inbound routing: business phone → tenant worker → AI reply → outbound send.

import { runAction } from './integrations/runner.js';
import * as integrations from './integrations/index.js';
import * as waSession from './whatsapp-session.js';

function normalizeDigits(phone = '') {
  return String(phone).replace(/\D/g, '');
}

export function phoneRouteKey({ phoneNumberId, twilioTo, provider = 'meta' }) {
  if (phoneNumberId) return `meta:${phoneNumberId}`;
  if (twilioTo) return `twilio:${normalizeDigits(twilioTo)}`;
  return null;
}

export function registerWhatsAppRoute(platformDb, { phoneNumberId, twilioTo, tenantId, workerId, provider = 'meta' }) {
  const resolvedPhoneId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID || '';
  const phoneKey = phoneRouteKey({
    phoneNumberId: resolvedPhoneId || undefined,
    twilioTo,
    provider,
  });
  if (!phoneKey || !tenantId || !workerId) return { ok: false, error: 'route_fields_required' };
  platformDb.prepare(
    `INSERT OR REPLACE INTO whatsapp_routes (phone_key, tenant_id, worker_id, provider, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(phoneKey, tenantId, workerId, provider, new Date().toISOString());
  return { ok: true, phoneKey };
}

export function resolveWhatsAppRoute(platformDb, { phoneNumberId, twilioTo }) {
  const platformPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID || '';
  const defaultTenant = process.env.WHATSAPP_DEFAULT_TENANT_ID || '';
  const defaultWorker = process.env.WHATSAPP_DEFAULT_WORKER_ID || '';

  if (phoneNumberId && platformPhoneId && phoneNumberId === platformPhoneId && defaultTenant && defaultWorker) {
    return { tenantId: defaultTenant, workerId: defaultWorker, provider: 'meta' };
  }

  const phoneKey = phoneRouteKey({ phoneNumberId, twilioTo });
  if (!phoneKey) return null;
  const row = platformDb.prepare(
    `SELECT tenant_id AS tenantId, worker_id AS workerId, provider FROM whatsapp_routes WHERE phone_key = ?`
  ).get(phoneKey);
  return row ?? null;
}

async function sendWhatsAppReply(tenantId, route, to, text, phoneKey) {
  // Meta rejects free-form sends outside the 24h customer service window, and
  // hammering it there gets the tenant's number restricted. Check first.
  const plan = waSession.planOutbound({ phoneKey, customerPhone: to, purpose: 'reply' });
  if (plan.type === 'blocked') {
    return { ok: false, error: 'outside_24h_window', hint: plan.hint, window: plan.window };
  }

  const waRows = integrations.getIntegrationsByType(tenantId, 'whatsapp');
  const config = waRows[0]?.config;
  const merged = config?.accessToken || config?.phoneNumberId
    ? config
    : { provider: route.provider || 'meta', ...(config ?? {}) };

  const params = plan.type === 'template'
    ? { to, template: plan.name, language: plan.language, templateParams: plan.params, text }
    : { to, text };
  const result = await runAction('whatsapp', 'send', params, merged, { tenantId });
  if (result?.ok) waSession.recordOutbound({ phoneKey, customerPhone: to });
  return { ...result, messageType: plan.type };
}

export async function processWhatsAppInbound(platformDb, deps, inbound) {
  const { chatWithWorker, logAgentActions, getWorker } = deps;
  if (!inbound?.from) return { ok: false, error: 'missing_sender' };

  const route = resolveWhatsAppRoute(platformDb, {
    phoneNumberId: inbound.phoneNumberId,
    twilioTo: inbound.businessTo,
  });
  if (!route) {
    console.warn('[whatsapp] no route for', inbound.phoneNumberId || inbound.businessTo || '(unknown)');
    return { ok: false, error: 'no_route' };
  }

  const phoneKey = phoneRouteKey({
    phoneNumberId: inbound.phoneNumberId,
    twilioTo: inbound.businessTo,
    provider: route.provider,
  });
  // The inbound message opens a fresh 24h window for this customer.
  waSession.recordInbound({
    phoneKey, customerPhone: inbound.from,
    tenantId: route.tenantId, workerId: route.workerId,
  });

  const customerId = `wa:${normalizeDigits(inbound.from)}`;
  const userMessage = (inbound.text || '').trim() || '(הודעה ללא טקסט)';

  const worker = getWorker?.(route.tenantId, route.workerId);
  const chat = await chatWithWorker({
    tenantId: route.tenantId,
    workerId: route.workerId,
    userMessage,
    customerId,
    demoMode: !worker?.isActive,
  });

  if (!chat.ok) {
    return { ok: false, error: chat.error, status: chat.status, message: chat.message };
  }

  if (chat.toolCalls?.length && logAgentActions) {
    logAgentActions(route.tenantId, route.workerId, customerId, chat.toolCalls);
  }

  const replyText = (chat.reply || '').trim();
  if (!replyText) return { ok: true, replied: false, runtime: chat.runtime };

  const sendResult = await sendWhatsAppReply(route.tenantId, route, inbound.from, replyText.slice(0, 4096), phoneKey);
  if (!sendResult?.ok) {
    return {
      ok: false, error: sendResult?.error ?? 'send_failed', replied: false,
      runtime: chat.runtime, hint: sendResult?.hint,
    };
  }
  return {
    ok: true,
    replied: true,
    runtime: chat.runtime,
    sendOk: !!sendResult?.ok,
    stub: !!sendResult?.stub,
    messageId: sendResult?.messageId,
    messageType: sendResult?.messageType,
  };
}
