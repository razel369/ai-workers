// Payment webhook handlers — Bit, PayPal IPN stub, auto-activation helpers.

import crypto from 'node:crypto';
import * as workers from './workers.js';

const PAYMENT_AUTO_VERIFY = process.env.PAYMENT_AUTO_VERIFY === '1';
const BIT_WEBHOOK_SECRET = process.env.BIT_WEBHOOK_SECRET ?? '';
const PAYPAL_WEBHOOK_SECRET = process.env.PAYPAL_WEBHOOK_SECRET ?? '';
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? '';
const ACTIVATION_SLA_HOURS = Number(process.env.ACTIVATION_SLA_HOURS ?? 24);

export function paymentConfigStatus() {
  return {
    autoVerifyEnabled: PAYMENT_AUTO_VERIFY,
    bitWebhookSecretSet: !!BIT_WEBHOOK_SECRET,
    paypalWebhookSecretSet: !!PAYPAL_WEBHOOK_SECRET,
    activationSlaHours: ACTIVATION_SLA_HOURS,
  };
}

export function activationSlaTextHe() {
  const h = ACTIVATION_SLA_HOURS;
  if (h <= 4) return `אישור תוך ${h} שעות בימי עסקים`;
  if (h <= 24) return 'אישור תוך 24 שעות בימי עסקים';
  return `אישור תוך ${h} שעות`;
}

function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function verifySharedSecret(req, expected) {
  if (!expected) return false;
  const header = req.headers['x-webhook-secret'] ?? req.headers['x-payment-secret'] ?? '';
  const auth = req.headers['authorization'] ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return timingSafeEqual(String(header), expected) || timingSafeEqual(bearer, expected);
}

function resolveWorkerTarget(body) {
  const workerId = String(body.workerId ?? body.worker_id ?? '').trim();
  const tenantId = String(body.tenantId ?? body.tenant_id ?? '').trim();
  if (workerId && tenantId) return { workerId, tenantId };
  if (workerId) {
    const found = workers.adminFindWorker(workerId);
    if (found) return { workerId, tenantId: found.tenantId };
  }
  return null;
}

export function autoActivateWorker({ workerId, tenantId, channel, reference, days, amountIls, source }) {
  const w = workers.getWorker(tenantId, workerId);
  if (!w) return { ok: false, error: 'worker_not_found' };
  if (w.isActive) return { ok: true, alreadyActive: true, paidUntil: w.paidUntil };
  const res = workers.adminMarkPaid({
    workerId,
    tenantId,
    days: days || Number(process.env.DEFAULT_RENT_DAYS ?? 30),
    paymentChannel: channel || 'webhook',
    paymentReference: reference || source || 'webhook-auto',
    amountIls: amountIls ?? 0,
  });
  return res.ok ? { ok: true, paidUntil: res.paidUntil, autoActivated: true } : res;
}

export function tryAutoVerifyActivationProof({ reference, channel }) {
  if (!PAYMENT_AUTO_VERIFY) return { ok: false, skipped: true, reason: 'auto_verify_disabled' };
  const ref = String(reference ?? '').trim();
  if (!ref || ref.length < 4) return { ok: false, skipped: true, reason: 'reference_too_short' };
  // Stub: references prefixed AUTO- or PP-VERIFY- are treated as pre-verified demo payments.
  if (/^(AUTO-|PP-VERIFY-|BIT-VERIFY-)/i.test(ref)) {
    return { ok: true, verified: true, mode: 'stub', reference: ref, channel: channel || 'auto-verify' };
  }
  return { ok: false, verified: false, reason: 'manual_review_required' };
}

/**
 * @returns {Promise<boolean>} true if handled
 */
export async function handlePaymentWebhooks(req, res, url, { send, readBody, markActivationRequestReviewed, recordAdminAudit, findPendingActivation }) {
  if (url.pathname === '/api/webhooks/bit' && req.method === 'POST') {
    const secretOk = verifySharedSecret(req, BIT_WEBHOOK_SECRET || PAYMENT_WEBHOOK_SECRET);
    if (!secretOk && (BIT_WEBHOOK_SECRET || PAYMENT_WEBHOOK_SECRET)) {
      send(res, 401, { error: 'invalid_webhook_secret' });
      return true;
    }
    const { text: raw } = await readBody(req, 65536);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {
      send(res, 400, { error: 'invalid_json' });
      return true;
    }
    const target = resolveWorkerTarget(body);
    if (!target) {
      send(res, 400, { error: 'workerId_required', hint: 'POST { workerId, tenantId?, reference, amount? }' });
      return true;
    }
    const reference = String(body.reference ?? body.transactionId ?? body.txId ?? '').trim();
    const result = autoActivateWorker({
      workerId: target.workerId,
      tenantId: target.tenantId,
      channel: 'bit',
      reference: reference || 'bit-webhook',
      days: Number(body.days) || undefined,
      amountIls: body.amount ?? body.amountIls,
      source: 'bit-webhook',
    });
    if (findPendingActivation) {
      const pending = findPendingActivation({ tenantId: target.tenantId, workerId: target.workerId, reference });
      if (pending?.id) markActivationRequestReviewed(pending.id, 'approved');
    }
    recordAdminAudit?.(req, {
      action: 'webhook_bit_payment',
      targetType: 'worker',
      targetId: target.workerId,
      metadata: { tenantId: target.tenantId, reference, result: result.ok ? 'activated' : result.error },
    });
    send(res, result.ok ? 200 : 400, { ok: result.ok, ...result, stub: !secretOk });
    return true;
  }

  if (url.pathname === '/api/webhooks/paypal' && req.method === 'POST') {
    const secretOk = verifySharedSecret(req, PAYPAL_WEBHOOK_SECRET || PAYMENT_WEBHOOK_SECRET);
    if (!secretOk && (PAYPAL_WEBHOOK_SECRET || PAYMENT_WEBHOOK_SECRET)) {
      send(res, 401, { error: 'invalid_webhook_secret' });
      return true;
    }
    const { text: raw, contentType } = await readBody(req, 65536);
    let body = {};
    if (contentType?.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(raw).entries());
    } else {
      try { body = raw ? JSON.parse(raw) : {}; } catch {
        send(res, 400, { error: 'invalid_json' });
        return true;
      }
    }
    // PayPal IPN stub: accept payment_status=Completed or event_type=PAYMENT.CAPTURE.COMPLETED
    const status = String(body.payment_status ?? body.event_type ?? body.status ?? '').toLowerCase();
    const completed = status.includes('completed') || status.includes('capture');
    const target = resolveWorkerTarget(body);
    if (!target) {
      send(res, 200, { ok: true, stub: true, note: 'paypal_ipn_received_no_worker', received: true });
      return true;
    }
    if (!completed && PAYPAL_WEBHOOK_SECRET) {
      send(res, 200, { ok: true, ignored: true, status });
      return true;
    }
    const reference = String(body.txn_id ?? body.transaction_id ?? body.id ?? body.reference ?? '').trim();
    const result = autoActivateWorker({
      workerId: target.workerId,
      tenantId: target.tenantId,
      channel: 'paypal',
      reference: reference || 'paypal-webhook',
      days: Number(body.days) || undefined,
      amountIls: body.amount ?? body.mc_gross,
      source: 'paypal-webhook',
    });
    if (findPendingActivation) {
      const pending = findPendingActivation({ tenantId: target.tenantId, workerId: target.workerId, reference });
      if (pending?.id) markActivationRequestReviewed(pending.id, 'approved');
    }
    recordAdminAudit?.(req, {
      action: 'webhook_paypal_payment',
      targetType: 'worker',
      targetId: target.workerId,
      metadata: { tenantId: target.tenantId, reference, status, result: result.ok ? 'activated' : result.error },
    });
    send(res, result.ok ? 200 : 400, { ok: result.ok, ...result, stub: !secretOk });
    return true;
  }

  return false;
}
