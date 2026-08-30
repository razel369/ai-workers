// Paddle Billing — server-created checkout transactions + verified webhooks.
//
// Security boundary: tenant_id / worker_id in Paddle custom_data are never
// authoritative. The server creates each Paddle transaction itself and keeps a
// durable provider-id -> tenant/worker mapping before returning transactionId
// to Paddle.js. Webhooks may mutate a worker only through that mapping.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as workers from './workers.js';
import { autoActivateWorker } from './payment-webhooks.js';

const PADDLE_API_KEY = (process.env.PADDLE_API_KEY ?? '').trim();
const PADDLE_CLIENT_TOKEN = (process.env.PADDLE_CLIENT_TOKEN ?? '').trim();
const PADDLE_WEBHOOK_SECRET = (process.env.PADDLE_WEBHOOK_SECRET ?? '').trim();
const PADDLE_ENVIRONMENT = (process.env.PADDLE_ENVIRONMENT ?? 'sandbox').trim().toLowerCase();
const DEFAULT_RENT_DAYS = Number(process.env.DEFAULT_RENT_DAYS ?? 30);
const API_TIMEOUT_MS = Math.min(Math.max(Number(process.env.PADDLE_API_TIMEOUT_MS ?? 10_000) || 10_000, 1_000), 30_000);

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

function paddleApiBaseUrl() {
  const official = PADDLE_ENVIRONMENT === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';
  const configured = String(process.env.PADDLE_API_BASE_URL ?? '').trim();
  if (!configured) return official;
  try {
    const parsed = new URL(configured);
    if (process.env.NODE_ENV === 'production' && parsed.origin !== official) {
      console.warn('[paddle-billing] ignoring non-official PADDLE_API_BASE_URL in production');
      return official;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return official;
    return parsed.origin;
  } catch {
    return official;
  }
}

function authorityDbPath() {
  if (process.env.PADDLE_AUTHORITY_DB_PATH) return path.resolve(process.env.PADDLE_AUTHORITY_DB_PATH);
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(path.dirname(new URL(import.meta.url).pathname), 'data');
  return path.join(dataDir, 'paddle-authority.db');
}

let authorityDb = null;

function getAuthorityDb() {
  if (authorityDb) return authorityDb;
  const dbPath = authorityDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS paddle_payment_targets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      price_id TEXT NOT NULL,
      expected_amount_ils REAL NOT NULL,
      customer_id TEXT,
      status TEXT NOT NULL DEFAULT 'creating',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_paddle_target_worker
      ON paddle_payment_targets(tenant_id, worker_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS paddle_provider_links (
      provider_type TEXT NOT NULL CHECK(provider_type IN ('transaction', 'subscription')),
      provider_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(provider_type, provider_id),
      FOREIGN KEY(target_id) REFERENCES paddle_payment_targets(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_paddle_links_target ON paddle_provider_links(target_id);
  `);
  authorityDb = db;
  return db;
}

function normalizeTargetRow(row) {
  if (!row) return null;
  return {
    targetId: row.targetId,
    tenantId: row.tenantId,
    workerId: row.workerId,
    templateId: row.templateId,
    priceId: row.priceId,
    expectedAmountIls: Number(row.expectedAmountIls),
    customerId: row.customerId ?? null,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function targetByProvider(providerType, providerId) {
  const id = String(providerId ?? '').trim();
  if (!id) return null;
  const row = getAuthorityDb().prepare(`
    SELECT t.id AS targetId, t.tenant_id AS tenantId, t.worker_id AS workerId,
      t.template_id AS templateId, t.price_id AS priceId,
      t.expected_amount_ils AS expectedAmountIls, t.customer_id AS customerId,
      t.status, t.created_at AS createdAt, t.updated_at AS updatedAt
    FROM paddle_provider_links l
    JOIN paddle_payment_targets t ON t.id = l.target_id
    WHERE l.provider_type = ? AND l.provider_id = ?
  `).get(providerType, id);
  return normalizeTargetRow(row);
}

function bindProviderId(providerType, providerId, targetId) {
  const id = String(providerId ?? '').trim();
  if (!id) return { ok: false, error: `paddle_${providerType}_id_required` };
  const db = getAuthorityDb();
  const existing = db.prepare(`SELECT target_id AS targetId FROM paddle_provider_links
    WHERE provider_type = ? AND provider_id = ?`).get(providerType, id);
  if (existing) {
    return existing.targetId === targetId
      ? { ok: true, alreadyBound: true }
      : { ok: false, error: 'paddle_provider_mapping_conflict' };
  }
  try {
    db.prepare(`INSERT INTO paddle_provider_links (provider_type, provider_id, target_id, created_at)
      VALUES (?, ?, ?, ?)`).run(providerType, id, targetId, new Date().toISOString());
    return { ok: true };
  } catch {
    const raced = db.prepare(`SELECT target_id AS targetId FROM paddle_provider_links
      WHERE provider_type = ? AND provider_id = ?`).get(providerType, id);
    return raced?.targetId === targetId
      ? { ok: true, alreadyBound: true }
      : { ok: false, error: 'paddle_provider_mapping_conflict' };
  }
}

function createPendingTarget({ tenantId, workerId, templateId, priceId, expectedAmountIls }) {
  const id = `pct_${crypto.randomBytes(24).toString('base64url')}`;
  const now = new Date().toISOString();
  getAuthorityDb().prepare(`INSERT INTO paddle_payment_targets
    (id, tenant_id, worker_id, template_id, price_id, expected_amount_ils, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'creating', ?, ?)`)
    .run(id, tenantId, workerId, templateId, priceId, expectedAmountIls, now, now);
  return id;
}

function markTarget(targetId, status) {
  getAuthorityDb().prepare(`UPDATE paddle_payment_targets SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, new Date().toISOString(), targetId);
}

async function createPaddleTransaction({ priceId, targetId }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${paddleApiBaseUrl()}/transactions`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${PADDLE_API_KEY}`,
        'content-type': 'application/json',
        'paddle-version': '1',
      },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        collection_mode: 'automatic',
        custom_data: { checkout_target_id: targetId },
      }),
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      console.error('[paddle-billing] create transaction failed', response.status, payload?.error?.type ?? 'unknown_error');
      return { ok: false, error: 'paddle_transaction_create_failed', providerStatus: response.status };
    }
    const transactionId = String(payload?.data?.id ?? '').trim();
    if (!transactionId.startsWith('txn_')) {
      console.error('[paddle-billing] create transaction returned no transaction id');
      return { ok: false, error: 'paddle_transaction_invalid_response' };
    }
    return { ok: true, transactionId };
  } catch (error) {
    console.error('[paddle-billing] create transaction request failed', error?.name ?? 'Error');
    return { ok: false, error: error?.name === 'AbortError' ? 'paddle_api_timeout' : 'paddle_api_unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

export function paddleProductionReady() {
  if (process.env.NODE_ENV !== 'production') return true;
  const liveClientToken = /^live_[A-Za-z0-9_-]{8,}$/.test(PADDLE_CLIENT_TOKEN);
  const modernLiveApiKey = /^pdl_live_apikey_[A-Za-z0-9_-]{20,}$/.test(PADDLE_API_KEY);
  const legacyLiveApiKey = PADDLE_API_KEY.length >= 40
    && !/(?:sdbx|sandbox|test|example|placeholder|changeme)/i.test(PADDLE_API_KEY);
  const credibleWebhookSecret = PADDLE_WEBHOOK_SECRET.length >= 16
    && !/(?:test|example|placeholder|changeme)/i.test(PADDLE_WEBHOOK_SECRET);
  return PADDLE_ENVIRONMENT === 'production'
    && liveClientToken
    && (modernLiveApiKey || legacyLiveApiKey)
    && credibleWebhookSecret
    && paddlePriceMapStatus().complete;
}

export function paddleEnabled() {
  return Boolean(PADDLE_CLIENT_TOKEN
    && PADDLE_API_KEY
    && Object.keys(PRICE_MAP).length > 0
    && paddleProductionReady());
}

export function paddlePriceMapStatus() {
  const templateIds = workers.TEMPLATES.map((template) => template.id);
  const configured = templateIds.filter((id) => typeof PRICE_MAP[id] === 'string' && PRICE_MAP[id].trim());
  const missingTemplates = templateIds.filter((id) => !configured.includes(id));
  return { configuredTemplates: configured, missingTemplates, complete: missingTemplates.length === 0 };
}

export function paddleConfigStatus() {
  return {
    enabled: paddleEnabled(),
    environment: PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    clientTokenSet: !!PADDLE_CLIENT_TOKEN,
    apiKeySet: !!PADDLE_API_KEY,
    webhookSecretSet: !!PADDLE_WEBHOOK_SECRET,
    serverCreatedTransactions: true,
    productionReady: paddleProductionReady(),
    defaultPriceId: null,
    priceMapTemplates: Object.keys(PRICE_MAP).filter((k) => k !== 'default').length,
    priceMapComplete: paddlePriceMapStatus().complete,
    missingTemplates: paddlePriceMapStatus().missingTemplates,
  };
}

export function resolvePaddlePriceId(templateId) {
  if (!templateId) return '';
  const mapped = PRICE_MAP[templateId];
  return typeof mapped === 'string' ? mapped.trim() : '';
}

export async function buildPaddleCheckoutConfig({ workerId, tenantId, templateId }) {
  if (!paddleEnabled()) return { ok: false, error: 'paddle_not_configured' };
  const priceId = resolvePaddlePriceId(templateId);
  if (!priceId) return { ok: false, error: 'paddle_price_not_configured' };
  const found = workers.adminFindWorker(workerId);
  if (!found || found.tenantId !== tenantId) return { ok: false, error: 'not_found' };
  const worker = workers.getWorker(tenantId, workerId);
  if (!worker || worker.templateId !== templateId) return { ok: false, error: 'template_mismatch' };
  const readiness = workers.getWorkerReadiness(worker);
  if (!readiness.ready) {
    return { ok: false, error: 'worker_not_ready_for_checkout', readiness };
  }
  const expectedAmountIls = Number(workers.getTemplate(templateId)?.rentPriceIls);
  if (!Number.isFinite(expectedAmountIls) || expectedAmountIls <= 0) {
    return { ok: false, error: 'paddle_template_amount_invalid' };
  }

  const targetId = createPendingTarget({
    tenantId, workerId, templateId, priceId, expectedAmountIls,
  });
  const created = await createPaddleTransaction({ priceId, targetId });
  if (!created.ok) {
    markTarget(targetId, 'failed');
    return created;
  }
  const bound = bindProviderId('transaction', created.transactionId, targetId);
  if (!bound.ok) {
    markTarget(targetId, 'failed');
    return bound;
  }
  markTarget(targetId, 'ready');
  return {
    ok: true,
    clientToken: PADDLE_CLIENT_TOKEN,
    environment: PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    transactionId: created.transactionId,
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

function validateTargetWorker(target) {
  if (!target) return { ok: false, error: 'paddle_target_unmapped' };
  const worker = workers.getWorker(target.tenantId, target.workerId);
  if (!worker || worker.templateId !== target.templateId) {
    return { ok: false, error: 'paddle_target_worker_mismatch' };
  }
  return { ok: true, worker };
}

function validateTransactionDetails(data, target) {
  if (data.status !== undefined && String(data.status).trim().toLowerCase() !== 'completed') {
    return { ok: false, error: 'paddle_transaction_not_completed' };
  }
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length !== 1) return { ok: false, error: 'paddle_transaction_items_mismatch' };
  const itemPriceId = String(items[0]?.price?.id ?? items[0]?.price_id ?? '').trim();
  const quantity = Number(items[0]?.quantity ?? 0);
  if (itemPriceId !== target.priceId || quantity !== 1) {
    return { ok: false, error: 'paddle_transaction_items_mismatch' };
  }
  const amount = data.details?.totals?.total
    ?? data.details?.totals?.grand_total
    ?? data.totals?.total
    ?? null;
  const currency = String(
    data.currency_code
    ?? data.details?.totals?.currency_code
    ?? data.totals?.currency_code
    ?? ''
  ).trim().toUpperCase();
  const minorUnits = Number(amount);
  const amountIls = Number.isFinite(minorUnits) ? minorUnits / 100 : Number.NaN;
  if (currency !== 'ILS' || !Number.isFinite(amountIls)
    || Math.abs(amountIls - target.expectedAmountIls) >= 0.01) {
    return {
      ok: false,
      error: 'payment_amount_mismatch',
      expectedAmountIls: target.expectedAmountIls,
      expectedCurrency: 'ILS',
    };
  }
  return { ok: true, amountIls };
}

function checkAndRecordCustomer(target, customerId) {
  const normalized = String(customerId ?? '').trim();
  if (!normalized) return { ok: true };
  if (target.customerId && target.customerId !== normalized) {
    return { ok: false, error: 'paddle_customer_mismatch' };
  }
  if (!target.customerId) {
    getAuthorityDb().prepare(`UPDATE paddle_payment_targets SET customer_id = ?, updated_at = ? WHERE id = ?`)
      .run(normalized, new Date().toISOString(), target.targetId);
  }
  return { ok: true };
}

function resolveTransactionTarget(data) {
  const transactionId = String(data?.id ?? '').trim();
  if (!transactionId) return { ok: false, error: 'paddle_transaction_id_required' };
  const subscriptionId = String(data?.subscription_id ?? '').trim();
  const byTransaction = targetByProvider('transaction', transactionId);
  const bySubscription = subscriptionId ? targetByProvider('subscription', subscriptionId) : null;
  if (byTransaction && bySubscription && byTransaction.targetId !== bySubscription.targetId) {
    return { ok: false, error: 'paddle_provider_mapping_conflict' };
  }
  const target = byTransaction || bySubscription;
  if (!target) return { ok: false, error: 'paddle_target_unmapped' };
  return { ok: true, target, transactionId, subscriptionId, needsTransactionBind: !byTransaction };
}

function suspendTarget(target, eventType) {
  const valid = validateTargetWorker(target);
  if (!valid.ok) return valid;
  const paused = workers.updateWorker(target.tenantId, target.workerId, { paused: true });
  if (!paused.ok) return { ok: false, error: paused.error || 'suspend_failed' };
  markTarget(target.targetId, 'suspended');
  return { ok: true, suspended: true, eventType, workerId: target.workerId };
}

export function processPaddleWebhookEvent(event) {
  if (!paddleProductionReady()) {
    return { ok: false, error: 'paddle_production_not_ready' };
  }
  const eventType = String(event?.event_type ?? event?.eventType ?? '').trim();
  const data = event?.data ?? {};

  if (eventType === 'transaction.completed') {
    const resolved = resolveTransactionTarget(data);
    if (!resolved.ok) return resolved;
    const validWorker = validateTargetWorker(resolved.target);
    if (!validWorker.ok) return validWorker;
    const validTransaction = validateTransactionDetails(data, resolved.target);
    if (!validTransaction.ok) return validTransaction;
    const customer = checkAndRecordCustomer(resolved.target, data.customer_id);
    if (!customer.ok) return customer;
    if (resolved.needsTransactionBind) {
      const bound = bindProviderId('transaction', resolved.transactionId, resolved.target.targetId);
      if (!bound.ok) return bound;
    }
    if (resolved.subscriptionId) {
      const bound = bindProviderId('subscription', resolved.subscriptionId, resolved.target.targetId);
      if (!bound.ok) return bound;
    }
    const activated = autoActivateWorker({
      workerId: resolved.target.workerId,
      tenantId: resolved.target.tenantId,
      channel: 'paddle',
      reference: resolved.transactionId,
      days: Number.isFinite(DEFAULT_RENT_DAYS) && DEFAULT_RENT_DAYS > 0 ? DEFAULT_RENT_DAYS : 30,
      amountIls: validTransaction.amountIls,
      source: 'paddle-transaction.completed',
    });
    if (activated.ok) markTarget(resolved.target.targetId, 'completed');
    return { ...activated, workerId: resolved.target.workerId };
  }

  if (eventType === 'subscription.created') {
    const subscriptionId = String(data.id ?? '').trim();
    const transactionId = String(data.transaction_id ?? '').trim();
    if (!subscriptionId || !transactionId) {
      return { ok: false, error: 'paddle_subscription_mapping_incomplete' };
    }
    const target = targetByProvider('transaction', transactionId);
    if (!target) return { ok: false, error: 'paddle_target_unmapped' };
    const bound = bindProviderId('subscription', subscriptionId, target.targetId);
    if (!bound.ok) return bound;
    const customer = checkAndRecordCustomer(target, data.customer_id);
    if (!customer.ok) return customer;
    return {
      ok: true,
      ignored: true,
      eventType,
      workerId: target.workerId,
      reason: 'activation_requires_completed_transaction',
    };
  }

  if (['subscription.canceled', 'subscription.paused'].includes(eventType)) {
    const target = targetByProvider('subscription', data.id);
    if (!target) return { ok: false, error: 'paddle_target_unmapped' };
    const customer = checkAndRecordCustomer(target, data.customer_id);
    if (!customer.ok) return customer;
    return suspendTarget(target, eventType);
  }

  if (eventType === 'transaction.refunded') {
    const target = targetByProvider('transaction', data.id);
    if (!target) return { ok: false, error: 'paddle_target_unmapped' };
    return suspendTarget(target, eventType);
  }

  if (['adjustment.created', 'adjustment.updated'].includes(eventType)) {
    const action = String(data.action ?? '').trim().toLowerCase();
    const status = String(data.status ?? '').trim().toLowerCase();
    const suspendingAction = ['refund', 'chargeback'].includes(action);
    if (!suspendingAction || status !== 'approved') {
      return { ok: true, ignored: true, eventType, reason: 'adjustment_not_approved_refund' };
    }
    const target = targetByProvider('transaction', data.transaction_id);
    if (!target) return { ok: false, error: 'paddle_target_unmapped' };
    return suspendTarget(target, eventType);
  }

  return { ok: true, ignored: true, eventType, reason: 'unsupported_paddle_event' };
}

/**
 * @returns {Promise<boolean>} true if handled
 */
export async function handlePaddleWebhook(req, res, url, { send, readBody, recordAdminAudit }) {
  if (url.pathname !== '/api/webhooks/paddle' || req.method !== 'POST') return false;

  if (!paddleProductionReady()) {
    send(res, 503, { error: 'paddle_production_not_ready' });
    return true;
  }

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
    targetId: result.workerId || 'unknown',
    metadata: {
      eventType: event?.event_type,
      eventId: event?.event_id,
      result: result.ok
        ? (result.ignored ? 'ignored' : (result.activationPendingSetup ? 'paid_pending_setup' : (result.suspended ? 'suspended' : 'activated')))
        : result.error,
    },
  });

  send(res, result.ok ? 200 : 400, { received: true, ...result });
  return true;
}
