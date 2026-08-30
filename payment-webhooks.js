// Payment webhook handlers — internal Bit/PayPal adapters and activation helpers.

import crypto from 'node:crypto';
import * as workers from './workers.js';

const PAYMENT_AUTO_VERIFY = process.env.PAYMENT_AUTO_VERIFY === '1';
const BIT_WEBHOOK_SECRET = process.env.BIT_WEBHOOK_SECRET ?? '';
const PAYPAL_WEBHOOK_SECRET = process.env.PAYPAL_WEBHOOK_SECRET ?? '';
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? '';
const ACTIVATION_SLA_HOURS = Number(process.env.ACTIVATION_SLA_HOURS ?? 24);

if (process.env.NODE_ENV === 'production') {
  if (!BIT_WEBHOOK_SECRET && !PAYMENT_WEBHOOK_SECRET) {
    console.warn('[startup] BIT_WEBHOOK_SECRET / PAYMENT_WEBHOOK_SECRET not set — bit webhook endpoint will reject all requests');
  }
  if (!PAYPAL_WEBHOOK_SECRET && !PAYMENT_WEBHOOK_SECRET) {
    console.warn('[startup] PAYPAL_WEBHOOK_SECRET / PAYMENT_WEBHOOK_SECRET not set — paypal webhook endpoint will reject all requests');
  }
}

export function paymentConfigStatus() {
  return {
    autoVerifyEnabled: PAYMENT_AUTO_VERIFY,
    bitWebhookSecretSet: !!BIT_WEBHOOK_SECRET,
    paypalWebhookSecretSet: !!(PAYPAL_WEBHOOK_SECRET || PAYMENT_WEBHOOK_SECRET),
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
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (!left.length || left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
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
  const res = workers.adminMarkPaid({
    workerId,
    tenantId,
    days: days || Number(process.env.DEFAULT_RENT_DAYS ?? 30),
    paymentChannel: channel || 'webhook',
    paymentReference: reference || source || 'webhook-auto',
    amountIls: amountIls ?? 0,
  });
  if (!res.ok) return res;
  const pendingSetup = res.activationPendingSetup === true;
  return {
    ...res,
    autoActivated: !pendingSetup && !w.isActive && !res.alreadyRecorded,
    autoRenewed: !pendingSetup && w.isActive && !res.alreadyRecorded,
    activationPendingSetup: pendingSetup,
  };
}

function existingEntitlementResult({ workerId, tenantId }) {
  const worker = workers.getWorker(tenantId, workerId);
  if (!worker) return { ok: false, error: 'worker_not_found' };
  const readiness = workers.getWorkerReadiness(worker);
  return {
    ok: true,
    alreadyRecorded: true,
    paidUntil: worker.paidUntil ?? null,
    paused: !!worker.paused,
    activationPendingSetup: !readiness.ready,
    readiness,
    autoActivated: false,
    autoRenewed: false,
  };
}

function paypalPaymentDetails(body) {
  const resource = body?.resource && typeof body.resource === 'object' ? body.resource : {};
  const amountObject = body?.amount && typeof body.amount === 'object' ? body.amount : {};
  const resourceAmount = resource?.amount && typeof resource.amount === 'object' ? resource.amount : {};
  const reference = String(
    body?.txn_id ?? body?.transaction_id ?? body?.id ?? body?.reference ?? resource?.id ?? ''
  ).trim().slice(0, 200);
  const rawAmount = body?.mc_gross ?? body?.amountIls ?? amountObject.value ?? body?.amount ?? resourceAmount.value;
  const amountIls = Number(rawAmount);
  const currency = String(
    body?.mc_currency ?? body?.currency ?? amountObject.currency_code ?? resourceAmount.currency_code ?? ''
  ).trim().toUpperCase();
  return { reference, amountIls, currency };
}

export function verifyRentAmount({ tenantId, workerId, amountIls, currency }) {
  const worker = workers.getWorker(tenantId, workerId);
  if (!worker) return { ok: false, error: 'worker_not_found' };
  const expectedAmountIls = Number(workers.getTemplate(worker.templateId)?.rentPriceIls);
  const amountMatches = Number.isFinite(amountIls)
    && Number.isFinite(expectedAmountIls)
    && Math.abs(amountIls - expectedAmountIls) < 0.01;
  if (currency !== 'ILS' || !amountMatches) {
    return { ok: false, error: 'payment_amount_mismatch', expectedAmountIls, expectedCurrency: 'ILS' };
  }
  return { ok: true, expectedAmountIls };
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
export async function handlePaymentWebhooks(req, res, url, {
  send,
  readBody,
  markActivationRequestReviewed,
  recordAdminAudit,
  findPendingActivation,
  claimPaymentReference,
  markPaymentReferenceEntitled,
}) {
  if (url.pathname === '/api/webhooks/bit' && req.method === 'POST') {
    const bitSecret = BIT_WEBHOOK_SECRET || PAYMENT_WEBHOOK_SECRET;
    if (!bitSecret) {
      console.warn('[payment-webhooks] webhook_secret_not_configured — refusing unverified bit webhook');
      send(res, 503, { error: 'webhook_secret_not_configured' });
      return true;
    }
    const secretOk = verifySharedSecret(req, bitSecret);
    if (!secretOk) {
      send(res, 401, { error: 'invalid_webhook_secret' });
      return true;
    }
    const { text: raw, tooLarge } = await readBody(req, 65536);
    if (tooLarge) {
      send(res, 413, { error: 'payload_too_large' });
      return true;
    }
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
    if (!reference) {
      send(res, 400, { error: 'payment_reference_required' });
      return true;
    }
    const amountIls = Number(body.amount ?? body.amountIls);
    const verifiedAmount = verifyRentAmount({ ...target, amountIls, currency: 'ILS' });
    if (!verifiedAmount.ok) {
      send(res, 400, verifiedAmount);
      return true;
    }
    if (typeof claimPaymentReference !== 'function') {
      send(res, 503, { error: 'payment_ledger_unavailable' });
      return true;
    }
    const ledger = claimPaymentReference({
      provider: 'bit',
      reference,
      tenantId: target.tenantId,
      workerId: target.workerId,
    });
    if (!ledger.ok) {
      recordAdminAudit?.(req, {
        action: 'webhook_bit_payment',
        targetType: 'worker',
        targetId: target.workerId,
        status: 'failed',
        metadata: { tenantId: target.tenantId, reference, error: ledger.error },
      });
      send(res, ledger.error === 'payment_reference_already_used' ? 400 : 503, ledger);
      return true;
    }
    const result = ledger.replay && ledger.entitled
      ? existingEntitlementResult(target)
      : autoActivateWorker({
        workerId: target.workerId,
        tenantId: target.tenantId,
        channel: 'bit',
        reference,
        amountIls,
        source: 'bit-webhook',
      });
    if (result.ok) markPaymentReferenceEntitled?.({
      provider: 'bit', reference, tenantId: target.tenantId, workerId: target.workerId,
    });
    if (result.ok && findPendingActivation) {
      const pending = findPendingActivation({ tenantId: target.tenantId, workerId: target.workerId, reference });
      if (pending?.id) markActivationRequestReviewed(pending.id, 'approved');
    }
    recordAdminAudit?.(req, {
      action: 'webhook_bit_payment',
      targetType: 'worker',
      targetId: target.workerId,
      metadata: { tenantId: target.tenantId, reference, replay: ledger.replay, result: result.ok ? 'activated' : result.error },
    });
    send(res, result.ok ? 200 : 400, { ok: result.ok, ...result, stub: !secretOk });
    return true;
  }

  if (url.pathname === '/api/webhooks/paypal' && req.method === 'POST') {
    const paypalSecret = PAYPAL_WEBHOOK_SECRET || PAYMENT_WEBHOOK_SECRET;
    if (!paypalSecret) {
      console.warn('[payment-webhooks] webhook_secret_not_configured — refusing unverified paypal webhook');
      send(res, 503, { error: 'webhook_secret_not_configured' });
      return true;
    }
    const secretOk = verifySharedSecret(req, paypalSecret);
    if (!secretOk) {
      send(res, 401, { error: 'invalid_webhook_secret' });
      return true;
    }
    const { text: raw, contentType, tooLarge } = await readBody(req, 65536);
    if (tooLarge) {
      send(res, 413, { error: 'payload_too_large' });
      return true;
    }
    let body = {};
    if (contentType?.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(raw).entries());
    } else {
      try { body = raw ? JSON.parse(raw) : {}; } catch {
        send(res, 400, { error: 'invalid_json' });
        return true;
      }
    }
    // Internal adapter: accept only an explicitly completed event, then verify
    // reference, ILS amount, and template price before changing entitlement.
    const status = String(body.payment_status ?? body.event_type ?? body.status ?? '').trim().toLowerCase();
    const completed = status === 'completed'
      || status === 'payment.capture.completed'
      || status === 'capture.completed';
    const target = resolveWorkerTarget(body);
    if (!target) {
      send(res, 200, { ok: true, stub: true, note: 'paypal_ipn_received_no_worker', received: true });
      return true;
    }
    if (!completed) {
      send(res, 200, { ok: true, ignored: true, status });
      return true;
    }
    const { reference, amountIls, currency } = paypalPaymentDetails(body);
    if (!reference) {
      send(res, 400, { error: 'payment_reference_required' });
      return true;
    }
    const verifiedAmount = verifyRentAmount({ ...target, amountIls, currency });
    if (!verifiedAmount.ok) {
      recordAdminAudit?.(req, {
        action: 'webhook_paypal_payment',
        targetType: 'worker',
        targetId: target.workerId,
        status: 'failed',
        metadata: { tenantId: target.tenantId, reference, error: verifiedAmount.error },
      });
      send(res, 400, verifiedAmount);
      return true;
    }
    if (typeof claimPaymentReference !== 'function') {
      send(res, 503, { error: 'payment_ledger_unavailable' });
      return true;
    }
    const ledger = claimPaymentReference({
      provider: 'paypal',
      reference,
      tenantId: target.tenantId,
      workerId: target.workerId,
    });
    if (!ledger.ok) {
      recordAdminAudit?.(req, {
        action: 'webhook_paypal_payment',
        targetType: 'worker',
        targetId: target.workerId,
        status: 'failed',
        metadata: { tenantId: target.tenantId, reference, error: ledger.error },
      });
      send(res, ledger.error === 'payment_reference_already_used' ? 400 : 503, ledger);
      return true;
    }
    const result = ledger.replay && ledger.entitled
      ? existingEntitlementResult(target)
      : autoActivateWorker({
        workerId: target.workerId,
        tenantId: target.tenantId,
        channel: 'paypal',
        reference,
        amountIls,
        source: 'paypal-webhook',
      });
    if (result.ok) markPaymentReferenceEntitled?.({
      provider: 'paypal', reference, tenantId: target.tenantId, workerId: target.workerId,
    });
    if (result.ok && findPendingActivation) {
      const pending = findPendingActivation({ tenantId: target.tenantId, workerId: target.workerId, reference });
      if (pending?.id) markActivationRequestReviewed(pending.id, 'approved');
    }
    recordAdminAudit?.(req, {
      action: 'webhook_paypal_payment',
      targetType: 'worker',
      targetId: target.workerId,
      metadata: { tenantId: target.tenantId, reference, status, replay: ledger.replay, result: result.ok ? 'activated' : result.error },
    });
    send(res, result.ok ? 200 : 400, { ok: result.ok, ...result, stub: !secretOk });
    return true;
  }

  return false;
}
