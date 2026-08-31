// Paddle Billing — Merchant of Record checkout + webhooks (no extra npm deps).

import crypto from 'node:crypto';
import * as workers from './workers.js';
import { autoActivateWorker } from './payment-webhooks.js';
import * as registry from './tenant-registry.js';
import * as notify from './notify.js';
import { notifyTenant } from './billing-lifecycle.js';

const PADDLE_API_KEY = (process.env.PADDLE_API_KEY ?? '').trim();
const PADDLE_CLIENT_TOKEN = (process.env.PADDLE_CLIENT_TOKEN ?? '').trim();
const PADDLE_WEBHOOK_SECRET = (process.env.PADDLE_WEBHOOK_SECRET ?? '').trim();
const PADDLE_ENVIRONMENT = (process.env.PADDLE_ENVIRONMENT ?? 'sandbox').trim().toLowerCase();
const PADDLE_DEFAULT_PRICE_ID = (process.env.PADDLE_PRICE_ID ?? '').trim();
const DEFAULT_RENT_DAYS = Number(process.env.DEFAULT_RENT_DAYS ?? 30);

if (process.env.NODE_ENV === 'production') {
  if (!PADDLE_WEBHOOK_SECRET) console.warn('[startup] PADDLE_WEBHOOK_SECRET not set — paddle webhook endpoint will reject all requests');
  if (!PADDLE_API_KEY) console.warn('[startup] PADDLE_API_KEY not set — paddle checkout disabled');
}

function parsePriceMap() {
  const raw = process.env.PADDLE_PRICE_MAP ?? '';
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

const PRICE_MAP = parsePriceMap();

export function paddleEnabled() {
  return Boolean(PADDLE_CLIENT_TOKEN && PADDLE_DEFAULT_PRICE_ID);
}

export function paddleConfigStatus() {
  const env = PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  const sandboxInProd = env === 'sandbox' && process.env.NODE_ENV === 'production';
  return {
    enabled: paddleEnabled(),
    environment: env,
    clientTokenSet: !!PADDLE_CLIENT_TOKEN,
    apiKeySet: !!PADDLE_API_KEY,
    webhookSecretSet: !!PADDLE_WEBHOOK_SECRET,
    defaultPriceId: PADDLE_DEFAULT_PRICE_ID ? `${PADDLE_DEFAULT_PRICE_ID.slice(0, 8)}…` : null,
    priceMapTemplates: Object.keys(PRICE_MAP).filter((k) => k !== 'default').length,
    // Card checkout is what removes the manual-approval bottleneck; if it is
    // not fully live every new customer still waits on an admin.
    selfServeReady: paddleEnabled() && !!PADDLE_WEBHOOK_SECRET && env === 'production',
    warnings: [
      !paddleEnabled() ? 'Paddle checkout disabled — every activation needs manual admin approval' : null,
      !PADDLE_WEBHOOK_SECRET ? 'PADDLE_WEBHOOK_SECRET missing — paid subscriptions will never activate' : null,
      sandboxInProd ? 'PADDLE_ENVIRONMENT=sandbox in production — real cards cannot be charged' : null,
    ].filter(Boolean),
  };
}

export function resolvePaddlePriceId(templateId) {
  if (templateId && PRICE_MAP[templateId]) return PRICE_MAP[templateId];
  if (PRICE_MAP.default) return PRICE_MAP.default;
  return PADDLE_DEFAULT_PRICE_ID;
}

export function buildPaddleCheckoutConfig({ workerId, tenantId, templateId }) {
  if (!paddleEnabled()) return { ok: false, error: 'paddle_not_configured' };
  const priceId = resolvePaddlePriceId(templateId);
  if (!priceId) return { ok: false, error: 'paddle_price_not_configured' };
  const found = workers.adminFindWorker(workerId);
  if (!found || found.tenantId !== tenantId) return { ok: false, error: 'not_found' };
  const worker = workers.getWorker(tenantId, workerId);
  return {
    ok: true,
    clientToken: PADDLE_CLIENT_TOKEN,
    environment: PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    priceId,
    customData: {
      worker_id: workerId,
      tenant_id: tenantId,
      template_id: templateId || worker.templateId || '',
    },
    workerName: worker.name,
  };
}

function parseSignatureHeader(header = '') {
  const parts = String(header).split(';').map((p) => p.trim());
  let ts = '';
  const hashes = [];
  for (const part of parts) {
    const [k, v] = part.split('=');
    if (k === 'ts') ts = v ?? '';
    if (k === 'h1' && v) hashes.push(v);
  }
  return { ts, hashes };
}

export function verifyPaddleWebhookSignature(rawBody, signatureHeader, secret = PADDLE_WEBHOOK_SECRET) {
  if (!secret) return { ok: false, error: 'webhook_secret_not_configured' };
  const { ts, hashes } = parseSignatureHeader(signatureHeader);
  if (!ts || hashes.length === 0) return { ok: false, error: 'invalid_signature_header' };
  const ageSec = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(ageSec) || ageSec > 300) return { ok: false, error: 'signature_expired' };
  const payload = `${ts}:${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const match = hashes.some((h) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(expected));
    } catch { return false; }
  });
  return match ? { ok: true } : { ok: false, error: 'signature_mismatch' };
}

function extractCustomData(entity = {}) {
  const cd = entity.custom_data ?? entity.customData ?? {};
  const workerId = String(cd.worker_id ?? cd.workerId ?? '').trim();
  const tenantId = String(cd.tenant_id ?? cd.tenantId ?? '').trim();
  return { workerId, tenantId };
}

function activateFromPaddle({ workerId, tenantId, reference, days, amountIls, eventType }) {
  if (!workerId || !tenantId) return { ok: false, error: 'missing_custom_data' };
  const result = autoActivateWorker({
    workerId,
    tenantId,
    channel: 'paddle',
    reference: reference || `paddle-${eventType}`,
    days: days || DEFAULT_RENT_DAYS,
    amountIls,
    source: `paddle-${eventType}`,
  });
  // The receipt is sent by autoActivateWorker so every channel gets one.
  return result;
}

export function processPaddleWebhookEvent(event) {
  const eventType = String(event?.event_type ?? event?.eventType ?? '').trim();
  const data = event?.data ?? {};
  const { workerId, tenantId } = extractCustomData(data);

  if (eventType === 'subscription.created' || eventType === 'subscription.activated') {
    const subId = data.id ?? data.subscription_id ?? '';
    return activateFromPaddle({
      workerId, tenantId, reference: subId, eventType,
    });
  }

  if (eventType === 'transaction.completed' || eventType === 'transaction.paid') {
    const txId = data.id ?? '';
    const amount = data.details?.totals?.total
      ?? data.details?.totals?.grand_total
      ?? data.totals?.total
      ?? 0;
    const amountIls = Number(amount) / 100 || undefined;
    return activateFromPaddle({
      workerId, tenantId, reference: txId, amountIls, eventType,
    });
  }

  if (eventType === 'subscription.updated') {
    const status = String(data.status ?? '').toLowerCase();
    const subId = data.id ?? '';
    if (status === 'active' || status === 'trialing') {
      linkSubscription({ tenantId, subId, status, priceId: firstPriceId(data) });
      return activateFromPaddle({ workerId, tenantId, reference: subId, eventType });
    }
    // past_due means the card failed. The worker keeps serving through the
    // grace window while the billing cycle chases it — cutting service off the
    // moment a card expires is how a renewal becomes a cancellation.
    if (status === 'past_due' || status === 'paused') {
      registry.setSubscriptionStatus(tenantId, status);
      notifyPaymentProblem({ tenantId, workerId, status });
      return { ok: true, eventType, status, action: 'dunning_started' };
    }
    registry.setSubscriptionStatus(tenantId, status);
    return { ok: true, eventType, status };
  }

  // A cancellation does not revoke service immediately — the customer paid
  // through the end of the current period, and paid_until already encodes it.
  if (eventType === 'subscription.canceled' || eventType === 'subscription.cancelled') {
    if (tenantId) registry.setSubscriptionStatus(tenantId, 'canceled');
    return { ok: true, eventType, action: 'marked_canceled', servedUntilPeriodEnd: true };
  }

  if (eventType === 'transaction.payment_failed') {
    if (tenantId) registry.setSubscriptionStatus(tenantId, 'payment_failed');
    notifyPaymentProblem({ tenantId, workerId, status: 'payment_failed' });
    return { ok: true, eventType, action: 'dunning_started' };
  }

  return { ok: true, ignored: true, eventType };
}

function firstPriceId(data) {
  const items = data?.items ?? [];
  return items[0]?.price?.id ?? items[0]?.price_id ?? '';
}

/** Map a Paddle price back to one of our plans so quotas match what was sold. */
function planForPriceId(priceId) {
  if (!priceId) return null;
  const entry = Object.entries(PRICE_MAP).find(([, v]) => v === priceId);
  return entry && registry.PLANS[entry[0]] ? entry[0] : null;
}

function linkSubscription({ tenantId, subId, status, priceId }) {
  if (!tenantId) return;
  try {
    const plan = planForPriceId(priceId);
    if (plan) {
      registry.setTenantPlan(tenantId, plan, {
        subscriptionProvider: 'paddle', subscriptionId: subId, subscriptionStatus: status,
      });
    } else {
      registry.setSubscriptionStatus(tenantId, status);
    }
  } catch {}
}

function notifyPaymentProblem({ tenantId, workerId, status }) {
  if (!tenantId) return;
  try {
    const t = registry.getTenant(tenantId);
    const businessName = t?.businessName || 'העסק שלך';
    const label = status === 'payment_failed' ? 'החיוב נכשל' : 'התשלום ממתין';
    notifyTenant(tenantId, workerId ?? '', {
      subject: `${label} — נדרש עדכון אמצעי תשלום`,
      html: notify.renderEmail({
        title: label,
        intro: `שלום ${businessName}, לא הצלחנו לחייב את אמצעי התשלום שלכם.`,
        bodyHtml: 'העובד ממשיך לענות ללקוחות בינתיים. כדי שלא תהיה הפסקה בשירות, כדאי לעדכן כרטיס אשראי.',
        ctaText: 'לעדכון אמצעי תשלום',
        ctaUrl: `${(process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/marketplace#/account`,
        footerNote: 'אם כבר עדכנתם — אפשר להתעלם מההודעה.',
      }),
      wa: `${businessName}: ${label} במנוי. לעדכון אמצעי תשלום: ${(process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/marketplace#/account`,
    }, `paddle:${tenantId}:${status}:${new Date().toISOString().slice(0, 10)}`);
    notify.flushOutbox({ limit: 5 }).catch(() => {});
  } catch {}
}


/**
 * @returns {Promise<boolean>} true if handled
 */
export async function handlePaddleWebhook(req, res, url, { send, readBody, recordAdminAudit }) {
  if (url.pathname !== '/api/webhooks/paddle' || req.method !== 'POST') return false;

  const { text: raw, tooLarge } = await readBody(req, 256 * 1024);
  if (tooLarge) {
    send(res, 413, { error: 'payload_too_large' });
    return true;
  }

  const signature = req.headers['paddle-signature'] ?? '';
  if (!PADDLE_WEBHOOK_SECRET) {
    console.warn('[paddle-billing] webhook_secret_not_configured — refusing unverified webhook');
    send(res, 503, { error: 'webhook_secret_not_configured' });
    return true;
  }
  const verified = verifyPaddleWebhookSignature(raw, signature);
  if (!verified.ok) {
    send(res, 401, { error: 'invalid_paddle_signature', reason: verified.error });
    return true;
  }

  let event;
  try { event = raw ? JSON.parse(raw) : {}; } catch {
    send(res, 400, { error: 'invalid_json' });
    return true;
  }

  const result = processPaddleWebhookEvent(event);
  recordAdminAudit?.(req, {
    action: 'webhook_paddle',
    targetType: 'worker',
    targetId: extractCustomData(event?.data ?? {}).workerId || 'unknown',
    metadata: {
      eventType: event?.event_type,
      eventId: event?.event_id,
      result: result.ok ? (result.ignored ? 'ignored' : 'activated') : result.error,
    },
  });

  send(res, 200, { ok: true, received: true, ...result });
  return true;
}
