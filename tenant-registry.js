// Tenant registry — who the customer is, how to reach them, what they pay for.
//
// Before this module a tenant was just a row in `api_keys` with the business
// name stuffed into `label` and the contact into `payment_reference`. That is
// enough to authenticate a request and nothing else: it cannot tell you where
// to send a renewal reminder, which plan the tenant is on, or how much of their
// quota they have burned. Billing, metering, owner alerts and the retention
// purge all read from here.

import crypto from 'node:crypto';

const DAY_MS = 86_400_000;

let db = null;

// --- Plan catalogue -------------------------------------------------------
//
// Priced per the Phase 3 monetisation experiments in docs/LAUNCH-CHECKLIST.md:
// bundles beat per-worker rental for multi-location businesses, and annual
// prepay (2 months free) pulls cash forward and cuts monthly churn decisions.

export const PLANS = {
  trial: {
    id: 'trial', nameHe: 'ניסיון', priceIls: 0, months: 0,
    maxWorkers: 1, monthlyMessages: 300, maxKnowledgeChars: 20_000,
    features: ['צ\'אט באתר', 'לידים והסלמות', 'תמיכה במייל'],
  },
  starter: {
    id: 'starter', nameHe: 'עובד יחיד', priceIls: 249, months: 1,
    maxWorkers: 1, monthlyMessages: 1_500, maxKnowledgeChars: 60_000,
    features: ['עובד אחד', '1,500 שיחות בחודש', 'ווידג\'ט לאתר', 'התראות לידים'],
  },
  bundle3: {
    id: 'bundle3', nameHe: 'שלושה עובדים', priceIls: 499, months: 1,
    maxWorkers: 3, monthlyMessages: 5_000, maxKnowledgeChars: 200_000,
    features: ['עד 3 עובדים', '5,000 שיחות בחודש', 'WhatsApp', 'ייצוא לידים ל-CSV'],
  },
  agency: {
    id: 'agency', nameHe: 'סוכנות', priceIls: 1_290, months: 1,
    maxWorkers: 10, monthlyMessages: 20_000, maxKnowledgeChars: 1_000_000,
    features: ['עד 10 עובדים', '20,000 שיחות בחודש', 'White-label', 'תמיכה בעדיפות'],
  },
  // Annual = 10x the monthly price for 12 months of service (2 months free).
  starter_annual: {
    id: 'starter_annual', nameHe: 'עובד יחיד — שנתי', priceIls: 2_490, months: 12,
    maxWorkers: 1, monthlyMessages: 1_500, maxKnowledgeChars: 60_000,
    features: ['עובד אחד', 'חודשיים חינם', 'מחיר נעול לשנה'],
  },
  bundle3_annual: {
    id: 'bundle3_annual', nameHe: 'שלושה עובדים — שנתי', priceIls: 4_990, months: 12,
    maxWorkers: 3, monthlyMessages: 5_000, maxKnowledgeChars: 200_000,
    features: ['עד 3 עובדים', 'חודשיים חינם', 'WhatsApp', 'מחיר נעול לשנה'],
  },
};

export const DEFAULT_PLAN = 'starter';

export function getPlan(planId) {
  return PLANS[planId] ?? PLANS[DEFAULT_PLAN];
}

export function listPlans() {
  return Object.values(PLANS).filter((p) => p.id !== 'trial');
}

// --- Schema ---------------------------------------------------------------

export function initTenantRegistry(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id TEXT PRIMARY KEY,
      business_name TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT 'trial',
      plan_started_at TEXT,
      notify_email INTEGER NOT NULL DEFAULT 1,
      notify_whatsapp INTEGER NOT NULL DEFAULT 0,
      dunning_stage INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER,
      subscription_provider TEXT,
      subscription_id TEXT,
      subscription_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_plan ON tenants(plan);
    CREATE INDEX IF NOT EXISTS idx_tenants_sub ON tenants(subscription_id);
  `);
  backfillFromApiKeys();
  return db;
}

/**
 * Existing tenants predate this table: their business name lives in
 * api_keys.label and their contact in api_keys.payment_reference. Import them
 * so the first billing run can actually reach everyone already signed up.
 */
function backfillFromApiKeys() {
  let rows = [];
  try {
    rows = db.prepare(`SELECT tenant_id, label, payment_reference, created_at
      FROM api_keys WHERE tenant_id IS NOT NULL AND revoked_at IS NULL`).all();
  } catch { return; }
  const now = new Date().toISOString();
  for (const r of rows) {
    if (!r.tenant_id) continue;
    const exists = db.prepare(`SELECT 1 FROM tenants WHERE tenant_id = ?`).get(r.tenant_id);
    if (exists) continue;
    const contact = String(r.payment_reference ?? '').trim();
    const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact);
    // Existing tenants predate the plan system. Backfilling them as 'trial'
    // would drop live customers to the 300-message trial cap the moment quota
    // enforcement turns on, so they land on the paid default instead.
    db.prepare(`INSERT INTO tenants
      (tenant_id, business_name, contact_email, contact_phone, plan, created_at, updated_at)
      VALUES (?,?,?,?,'${DEFAULT_PLAN}',?,?)`)
      .run(r.tenant_id, String(r.label ?? '').slice(0, 120),
        isEmail ? contact : '', isEmail ? '' : normalisePhone(contact),
        r.created_at ?? now, now);
  }
}

export function normalisePhone(raw) {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  // Israeli local format (05X-...) → E.164 so WhatsApp/Meta accepts it.
  if (/^0\d{8,9}$/.test(digits)) return `972${digits.slice(1)}`;
  return digits.replace(/^\+/, '');
}

// --- CRUD -----------------------------------------------------------------

export function upsertTenant({ tenantId, businessName, contact, contactEmail, contactPhone, plan }) {
  if (!db || !tenantId) return null;
  const now = new Date().toISOString();
  let email = String(contactEmail ?? '').trim();
  let phone = normalisePhone(contactPhone);
  // Signup collects a single free-text "contact" field — split it by shape.
  const raw = String(contact ?? '').trim();
  if (raw && !email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) email = raw;
  else if (raw && !phone) phone = normalisePhone(raw);

  const existing = getTenant(tenantId);
  if (existing) {
    db.prepare(`UPDATE tenants SET
      business_name = COALESCE(NULLIF(?,''), business_name),
      contact_email = COALESCE(NULLIF(?,''), contact_email),
      contact_phone = COALESCE(NULLIF(?,''), contact_phone),
      plan = COALESCE(NULLIF(?,''), plan),
      notify_whatsapp = CASE WHEN NULLIF(?,'') IS NOT NULL THEN 1 ELSE notify_whatsapp END,
      updated_at = ? WHERE tenant_id = ?`)
      .run(String(businessName ?? ''), email, phone, String(plan ?? ''), phone, now, tenantId);
  } else {
    db.prepare(`INSERT INTO tenants
      (tenant_id, business_name, contact_email, contact_phone, plan, plan_started_at,
       notify_whatsapp, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(tenantId, String(businessName ?? '').slice(0, 120), email, phone,
        plan || 'trial', now, phone ? 1 : 0, now, now);
  }
  return getTenant(tenantId);
}

export function getTenant(tenantId) {
  if (!db || !tenantId) return null;
  const r = db.prepare(`SELECT tenant_id AS tenantId, business_name AS businessName,
    contact_email AS contactEmail, contact_phone AS contactPhone, plan,
    plan_started_at AS planStartedAt, notify_email AS notifyEmail,
    notify_whatsapp AS notifyWhatsapp, dunning_stage AS dunningStage,
    retention_days AS retentionDays, subscription_provider AS subscriptionProvider,
    subscription_id AS subscriptionId, subscription_status AS subscriptionStatus,
    created_at AS createdAt, updated_at AS updatedAt
    FROM tenants WHERE tenant_id = ?`).get(tenantId);
  if (!r) return null;
  return { ...r, notifyEmail: !!r.notifyEmail, notifyWhatsapp: !!r.notifyWhatsapp, planDetails: getPlan(r.plan) };
}

export function listTenants() {
  if (!db) return [];
  return db.prepare(`SELECT tenant_id AS tenantId, business_name AS businessName,
    contact_email AS contactEmail, contact_phone AS contactPhone, plan,
    notify_email AS notifyEmail, notify_whatsapp AS notifyWhatsapp,
    dunning_stage AS dunningStage, retention_days AS retentionDays,
    subscription_status AS subscriptionStatus, created_at AS createdAt
    FROM tenants ORDER BY created_at DESC`).all()
    .map((r) => ({ ...r, notifyEmail: !!r.notifyEmail, notifyWhatsapp: !!r.notifyWhatsapp }));
}

export function setTenantPlan(tenantId, planId, { subscriptionProvider, subscriptionId, subscriptionStatus } = {}) {
  if (!db || !tenantId) return null;
  const now = new Date().toISOString();
  db.prepare(`UPDATE tenants SET plan = ?, plan_started_at = ?, dunning_stage = 0,
    subscription_provider = COALESCE(?, subscription_provider),
    subscription_id = COALESCE(?, subscription_id),
    subscription_status = COALESCE(?, subscription_status),
    updated_at = ? WHERE tenant_id = ?`)
    .run(getPlan(planId).id, now, subscriptionProvider ?? null, subscriptionId ?? null,
      subscriptionStatus ?? null, now, tenantId);
  return getTenant(tenantId);
}

export function setSubscriptionStatus(tenantId, status) {
  if (!db || !tenantId) return null;
  db.prepare(`UPDATE tenants SET subscription_status = ?, updated_at = ? WHERE tenant_id = ?`)
    .run(String(status ?? ''), new Date().toISOString(), tenantId);
  return getTenant(tenantId);
}

export function findTenantBySubscription(subscriptionId) {
  if (!db || !subscriptionId) return null;
  const r = db.prepare(`SELECT tenant_id AS tenantId FROM tenants WHERE subscription_id = ?`).get(subscriptionId);
  return r ? getTenant(r.tenantId) : null;
}

export function setDunningStage(tenantId, stage) {
  if (!db || !tenantId) return;
  db.prepare(`UPDATE tenants SET dunning_stage = ?, updated_at = ? WHERE tenant_id = ?`)
    .run(Number(stage) || 0, new Date().toISOString(), tenantId);
}

export function updateNotificationPrefs(tenantId, { notifyEmail, notifyWhatsapp, contactEmail, contactPhone, retentionDays }) {
  if (!db || !tenantId) return null;
  const t = getTenant(tenantId);
  if (!t) return null;
  db.prepare(`UPDATE tenants SET
    notify_email = ?, notify_whatsapp = ?,
    contact_email = ?, contact_phone = ?,
    retention_days = ?, updated_at = ? WHERE tenant_id = ?`)
    .run(
      notifyEmail === undefined ? (t.notifyEmail ? 1 : 0) : (notifyEmail ? 1 : 0),
      notifyWhatsapp === undefined ? (t.notifyWhatsapp ? 1 : 0) : (notifyWhatsapp ? 1 : 0),
      contactEmail === undefined ? t.contactEmail : String(contactEmail ?? '').trim().slice(0, 160),
      contactPhone === undefined ? t.contactPhone : normalisePhone(contactPhone),
      retentionDays === undefined ? t.retentionDays : (Number(retentionDays) || null),
      new Date().toISOString(), tenantId
    );
  return getTenant(tenantId);
}

/** Where a platform notification for this tenant should go. */
export function notificationTargets(tenantId) {
  const t = getTenant(tenantId);
  if (!t) return { email: '', phone: '', businessName: '' };
  return {
    email: t.notifyEmail ? t.contactEmail : '',
    phone: t.notifyWhatsapp ? t.contactPhone : '',
    businessName: t.businessName || 'העסק שלך',
  };
}

export const DAY = DAY_MS;
export const newRegistryId = (p) => `${p}_${crypto.randomBytes(12).toString('hex')}`;
