// Privacy compliance — retention, access, erasure.
//
// The privacy policy already promises Israeli data-subject rights ("access,
// correction or deletion"), but nothing implemented them: transcripts, leads,
// customer profiles and remembered facts were kept forever with no purge and no
// way to answer a deletion request except by deleting the whole worker.
//
// That gap is a sales blocker as much as a legal one. The stated ICP includes
// clinics and law firms, whose procurement asks for a retention schedule, an
// erasure path, and a processor agreement before they will sign.
//
// The tenant is the controller of their customers' data; this platform is the
// processor. So retention is configurable per tenant, and erasure works on an
// end customer identified by conversation id, phone or email.
//
// ENV:
//   RETENTION_DAYS=365           # default; per-tenant override in tenants table
//   RETENTION_MIN_DAYS=30        # floor, so a tenant cannot delete audit trail
//   RETENTION_ENABLED=1

import * as registry from './tenant-registry.js';

const env = (k, d = '') => (process.env[k] ?? d).trim();

export const DEFAULT_RETENTION_DAYS = Math.max(1, Number(env('RETENTION_DAYS', '365')));
const MIN_RETENTION_DAYS = Math.max(1, Number(env('RETENTION_MIN_DAYS', '30')));
const RETENTION_ENABLED = env('RETENTION_ENABLED', '1') !== '0';

let db = null;
let workers = null;
let timer = null;

export function initCompliance({ database, workersModule }) {
  db = database;
  workers = workersModule;
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_requests (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject_ref TEXT NOT NULL,
      rows_affected INTEGER NOT NULL DEFAULT 0,
      actor TEXT NOT NULL DEFAULT 'tenant',
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_data_requests_tenant ON data_requests(tenant_id, at);
    CREATE TABLE IF NOT EXISTS retention_runs (
      run_date TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      tenants INTEGER NOT NULL DEFAULT 0,
      rows_purged INTEGER NOT NULL DEFAULT 0,
      errors TEXT
    );
  `);
  return db;
}

export function effectiveRetentionDays(tenantId) {
  const t = registry.getTenant(tenantId);
  const requested = Number(t?.retentionDays);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, requested);
}

function logRequest({ tenantId, kind, subjectRef, rows, actor, detail }) {
  try {
    db.prepare(`INSERT INTO data_requests (id, at, tenant_id, kind, subject_ref, rows_affected, actor, detail)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(registry.newRegistryId('dsr'), new Date().toISOString(), tenantId, kind,
        String(subjectRef ?? '').slice(0, 200), rows, actor ?? 'tenant',
        detail ? String(detail).slice(0, 500) : null);
  } catch {}
}

// Personal data lives in these tenant tables, keyed by customer_id.
const CUSTOMER_TABLES = [
  { table: 'messages', col: 'customer_id' },
  { table: 'customer_memories', col: 'customer_id' },
  { table: 'customer_profiles', col: 'customer_id' },
  { table: 'conversation_summaries', col: 'customer_id' },
  { table: 'leads', col: 'customer_id' },
  { table: 'escalations', col: 'customer_id' },
  { table: 'schedule_callbacks', col: 'customer_id' },
  { table: 'followup_triggers', col: 'customer_id' },
  { table: 'crm_notes', col: 'customer_id' },
];

// Tables purged purely by age (no per-customer identity needed).
const AGED_TABLES = [
  'messages', 'conversation_summaries', 'agent_actions',
  'outbox', 'escalations', 'schedule_callbacks', 'followup_triggers',
];

function tenantDb(tenantId) {
  return workers.getTenantDbHandle(tenantId);
}

function tableExists(database, name) {
  try {
    return !!database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  } catch { return false; }
}

function hasColumn(database, table, col) {
  try {
    return database.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch { return false; }
}

// --- Right of access ------------------------------------------------------

/**
 * Everything held about one end customer, for a subject access request.
 * Matches on conversation id, phone or email — a customer asking to be
 * forgotten knows their phone number, not the internal customer_id.
 */
export function exportCustomerData(tenantId, { customerId = '', phone = '', email = '' }) {
  if (!tenantId) return { ok: false, error: 'tenant_required' };
  const ids = resolveCustomerIds(tenantId, { customerId, phone, email });
  if (!ids.length) return { ok: true, found: false, customerIds: [], data: {} };

  const database = tenantDb(tenantId);
  const placeholders = ids.map(() => '?').join(',');
  const data = {};
  for (const { table, col } of CUSTOMER_TABLES) {
    if (!tableExists(database, table) || !hasColumn(database, table, col)) continue;
    try {
      data[table] = database.prepare(`SELECT * FROM ${table} WHERE ${col} IN (${placeholders})`).all(...ids);
    } catch {}
  }
  const rows = Object.values(data).reduce((n, arr) => n + arr.length, 0);
  logRequest({ tenantId, kind: 'export', subjectRef: phone || email || customerId, rows, actor: 'tenant' });
  return { ok: true, found: true, customerIds: ids, exportedAt: new Date().toISOString(), rowCount: rows, data };
}

/** Map a phone/email/customer id onto every conversation id it appears under. */
function resolveCustomerIds(tenantId, { customerId, phone, email }) {
  const database = tenantDb(tenantId);
  const ids = new Set();
  if (customerId) ids.add(String(customerId));
  // Erasure is irreversible and matches phones by suffix, so a too-short number
  // would delete unrelated customers. Require a plausible full phone.
  const rawPhone = registry.normalisePhone(phone);
  const normalisedPhone = rawPhone.length >= 9 ? rawPhone : '';
  if (normalisedPhone || email) {
    for (const [table, cols] of [['leads', ['phone', 'email']], ['customer_profiles', ['phone']]]) {
      if (!tableExists(database, table)) continue;
      for (const col of cols) {
        if (!hasColumn(database, table, col) || !hasColumn(database, table, 'customer_id')) continue;
        const value = col === 'phone' ? normalisedPhone : email;
        if (!value) continue;
        try {
          // Compare phones on digits only — stored values vary in formatting.
          const rows = col === 'phone'
            ? database.prepare(
                `SELECT DISTINCT customer_id AS cid FROM ${table}
                 WHERE customer_id != '' AND replace(replace(replace(${col},'-',''),' ',''),'+','') LIKE ?`
              ).all(`%${normalisedPhone.slice(-9)}%`)
            : database.prepare(
                `SELECT DISTINCT customer_id AS cid FROM ${table} WHERE customer_id != '' AND lower(${col}) = lower(?)`
              ).all(value);
          for (const r of rows) if (r.cid) ids.add(r.cid);
        } catch {}
      }
    }
  }
  return [...ids];
}

// --- Right to erasure -----------------------------------------------------

export function deleteCustomerData(tenantId, { customerId = '', phone = '', email = '', actor = 'tenant' }) {
  if (!tenantId) return { ok: false, error: 'tenant_required' };
  if (phone && registry.normalisePhone(phone).length < 9) {
    return { ok: false, error: 'phone_too_short', hint: 'Provide the full phone number — a partial match could erase other customers.' };
  }
  const ids = resolveCustomerIds(tenantId, { customerId, phone, email });
  if (!ids.length) return { ok: true, deleted: 0, customerIds: [] };

  const database = tenantDb(tenantId);
  const placeholders = ids.map(() => '?').join(',');
  let deleted = 0;
  const perTable = {};
  for (const { table, col } of CUSTOMER_TABLES) {
    if (!tableExists(database, table) || !hasColumn(database, table, col)) continue;
    try {
      const before = database.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} IN (${placeholders})`).get(...ids)?.c ?? 0;
      if (!before) continue;
      database.prepare(`DELETE FROM ${table} WHERE ${col} IN (${placeholders})`).run(...ids);
      perTable[table] = before;
      deleted += before;
    } catch {}
  }
  // Leads may carry the phone/email with no customer_id attached — catch those too.
  const erasePhone = registry.normalisePhone(phone);
  const normalisedPhone = erasePhone.length >= 9 ? erasePhone : '';
  if (tableExists(database, 'leads')) {
    try {
      if (normalisedPhone) {
        const r = database.prepare(
          `DELETE FROM leads WHERE replace(replace(replace(phone,'-',''),' ',''),'+','') LIKE ?`
        ).run(`%${normalisedPhone.slice(-9)}%`);
        deleted += r.changes ?? 0;
      }
      if (email) {
        const r = database.prepare(`DELETE FROM leads WHERE lower(email) = lower(?)`).run(email);
        deleted += r.changes ?? 0;
      }
    } catch {}
  }
  logRequest({
    tenantId, kind: 'erasure', subjectRef: phone || email || customerId,
    rows: deleted, actor, detail: JSON.stringify(perTable).slice(0, 400),
  });
  return { ok: true, deleted, customerIds: ids, perTable };
}

// --- Retention purge ------------------------------------------------------

/**
 * Delete personal data past the tenant's retention window.
 * Leads are deliberately excluded: they are the tenant's business records, not
 * incidental conversation logs, and deleting them silently would destroy the
 * value the tenant paid for. Transcripts and operational rows do age out.
 */
export function purgeTenant(tenantId, { days } = {}) {
  const retention = days ?? effectiveRetentionDays(tenantId);
  const cutoff = new Date(Date.now() - retention * 86_400_000).toISOString();
  const database = tenantDb(tenantId);
  let purged = 0;
  const perTable = {};
  for (const table of AGED_TABLES) {
    if (!tableExists(database, table) || !hasColumn(database, table, 'created_at')) continue;
    try {
      const r = database.prepare(`DELETE FROM ${table} WHERE created_at < ?`).run(cutoff);
      const n = r.changes ?? 0;
      if (n) { perTable[table] = n; purged += n; }
    } catch {}
  }
  return { tenantId, retentionDays: retention, cutoff, purged, perTable };
}

export function runRetentionPurge({ force = false } = {}) {
  if (!RETENTION_ENABLED && !force) return { ok: false, skipped: 'disabled' };
  if (!db || !workers) return { ok: false, error: 'compliance_not_initialised' };
  const runDate = new Date().toISOString().slice(0, 10);
  if (!force) {
    const existing = db.prepare(`SELECT 1 FROM retention_runs WHERE run_date = ?`).get(runDate);
    if (existing) return { ok: true, skipped: 'already_ran_today' };
  }
  const errors = [];
  let tenants = 0, rows = 0;
  for (const t of registry.listTenants()) {
    try {
      const r = purgeTenant(t.tenantId);
      tenants++;
      rows += r.purged;
    } catch (e) {
      errors.push(`${t.tenantId}: ${e?.message ?? e}`);
    }
  }
  try {
    db.prepare(`INSERT INTO retention_runs (run_date, at, tenants, rows_purged, errors) VALUES (?,?,?,?,?)
      ON CONFLICT(run_date) DO UPDATE SET at=excluded.at, tenants=excluded.tenants,
      rows_purged=excluded.rows_purged, errors=excluded.errors`)
      .run(runDate, new Date().toISOString(), tenants, rows,
        errors.length ? errors.slice(0, 10).join(' | ').slice(0, 800) : null);
  } catch {}
  return { ok: true, runDate, tenants, rowsPurged: rows, errors: errors.length };
}

export function complianceStatus() {
  const base = {
    retentionEnabled: RETENTION_ENABLED,
    defaultRetentionDays: DEFAULT_RETENTION_DAYS,
    minRetentionDays: MIN_RETENTION_DAYS,
  };
  if (!db) return base;
  const lastRun = db.prepare(`SELECT run_date AS runDate, at, tenants, rows_purged AS rowsPurged, errors
    FROM retention_runs ORDER BY run_date DESC LIMIT 1`).get() ?? null;
  const requests = db.prepare(`SELECT COUNT(*) AS c FROM data_requests`).get()?.c ?? 0;
  return { ...base, lastRun, dataRequests: requests };
}

export function recentDataRequests(tenantId = null, limit = 50) {
  if (!db) return [];
  const sql = tenantId
    ? `SELECT * FROM data_requests WHERE tenant_id = ? ORDER BY at DESC LIMIT ?`
    : `SELECT * FROM data_requests ORDER BY at DESC LIMIT ?`;
  return tenantId ? db.prepare(sql).all(tenantId, limit) : db.prepare(sql).all(limit);
}

// --- AI disclosure --------------------------------------------------------

/**
 * Every worker must tell the customer it is not a person.
 * Appended to the system prompt rather than left to each template so a tenant
 * editing their persona cannot remove it — the EU AI Act transparency duty and
 * basic consumer-protection expectations both land on the platform, not on the
 * tenant who wrote the prompt.
 */
export const AI_DISCLOSURE_HE =
  'שקיפות (חובה): אתה עוזר בינה מלאכותית ולא אדם. אם לקוח שואל אם הוא מדבר עם אדם, ' +
  'עונה ישירות ובלי התחמקות שאתה עוזר AI של העסק, ומציע להעביר לנציג אנושי. ' +
  'לעולם אל תתחזה לאדם, אל תמציא שם של עובד אנושי, ואל תטען שאתה "המזכירה" או "הנציג" בגוף ראשון כאדם.';

export function withAiDisclosure(systemPrompt) {
  if (String(systemPrompt ?? '').includes(AI_DISCLOSURE_HE)) return systemPrompt;
  return `${systemPrompt}\n\n${AI_DISCLOSURE_HE}`;
}

// --- Scheduler ------------------------------------------------------------

export function startRetentionScheduler({ extraPurges = [] } = {}) {
  if (!RETENTION_ENABLED || timer) return { started: false };
  const tick = () => {
    try { runRetentionPurge(); } catch (e) { console.warn('[retention] failed:', e?.message ?? e); }
    // Anything else that grows without bound (funnel events, sent notifications).
    for (const purge of extraPurges) {
      try { purge(); } catch (e) { console.warn('[retention] extra purge failed:', e?.message ?? e); }
    }
  };
  timer = setInterval(tick, 6 * 60 * 60_000);
  timer.unref?.();
  setTimeout(tick, 120_000).unref?.();
  return { started: true };
}

export function stopRetentionScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
