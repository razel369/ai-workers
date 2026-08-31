// First-party funnel analytics.
//
// Third-party analytics was silently disabled in production (host check), and
// even when enabled it cannot see the steps that matter here — signup started
// vs completed, worker built vs activated, checkout opened vs paid. Those are
// the numbers that say which part of the funnel is losing customers.
//
// Stored on the platform DB, no third party involved, no cookies, and no
// personal data: a random session key, a step name, and coarse properties.
//
// ENV:
//   FUNNEL_ANALYTICS=0        # disable
//   FUNNEL_RETENTION_DAYS=180

import crypto from 'node:crypto';

const ENABLED = process.env.FUNNEL_ANALYTICS !== '0';
const RETENTION_DAYS = Math.max(7, Number(process.env.FUNNEL_RETENTION_DAYS ?? 180));

const ALLOWED_STEPS = new Set([
  'landing_view', 'marketplace_view', 'template_selected',
  'signup_started', 'signup_completed', 'worker_created', 'worker_customized',
  'demo_chat_started', 'activation_requested', 'checkout_opened',
  'payment_completed', 'route_view', 'upgrade_clicked', 'quota_blocked',
]);

// The ordered conversion path the report measures drop-off across.
const FUNNEL_ORDER = [
  'landing_view', 'marketplace_view', 'signup_completed',
  'worker_created', 'demo_chat_started', 'checkout_opened', 'payment_completed',
];

let db = null;

export function initFunnelAnalytics(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS funnel_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      day TEXT NOT NULL,
      step TEXT NOT NULL,
      session_key TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      referrer TEXT NOT NULL DEFAULT '',
      tenant_id TEXT,
      props TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_funnel_day_step ON funnel_events(day, step);
    CREATE INDEX IF NOT EXISTS idx_funnel_session ON funnel_events(session_key);
  `);
  return db;
}

/** Hash the session key so a raw client-supplied id is never stored. */
function hashSession(key) {
  return crypto.createHash('sha256').update(String(key ?? '')).digest('hex').slice(0, 32);
}

export function recordEvent({ step, sessionKey, path = '', referrer = '', tenantId = null, props = {} }) {
  if (!ENABLED || !db) return { ok: false, skipped: 'disabled' };
  const name = String(step ?? '').trim();
  if (!ALLOWED_STEPS.has(name)) return { ok: false, error: 'unknown_step' };
  if (!sessionKey) return { ok: false, error: 'session_required' };
  const now = new Date();
  try {
    db.prepare(`INSERT INTO funnel_events (at, day, step, session_key, path, referrer, tenant_id, props)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(now.toISOString(), now.toISOString().slice(0, 10), name, hashSession(sessionKey),
        String(path).slice(0, 200), String(referrer).slice(0, 120), tenantId,
        JSON.stringify(props ?? {}).slice(0, 500));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Unique sessions reaching each funnel step over the window, with the
 * conversion and drop-off between consecutive steps.
 */
export function funnelReport({ days = 30 } = {}) {
  if (!db) return { steps: [], days };
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT step, COUNT(DISTINCT session_key) AS sessions
    FROM funnel_events WHERE day >= ? GROUP BY step`).all(since);
  const bySt = Object.fromEntries(rows.map((r) => [r.step, r.sessions]));
  const top = bySt[FUNNEL_ORDER[0]] ?? 0;
  let prev = null;
  const steps = FUNNEL_ORDER.map((step) => {
    const sessions = bySt[step] ?? 0;
    const fromPrev = prev === null ? null : (prev > 0 ? Number(((sessions / prev) * 100).toFixed(1)) : 0);
    const dropOff = prev === null ? null : Math.max(0, prev - sessions);
    const row = {
      step, sessions,
      pctOfTop: top > 0 ? Number(((sessions / top) * 100).toFixed(1)) : 0,
      conversionFromPrevious: fromPrev,
      droppedHere: dropOff,
    };
    prev = sessions;
    return row;
  });
  // The step losing the most sessions is where to spend the next sprint.
  const worst = steps.filter((s) => s.droppedHere !== null)
    .sort((a, b) => b.droppedHere - a.droppedHere)[0] ?? null;
  return {
    days, since,
    steps,
    biggestDropOff: worst ? { from: FUNNEL_ORDER[FUNNEL_ORDER.indexOf(worst.step) - 1], to: worst.step, lost: worst.droppedHere } : null,
    overallConversionPct: top > 0
      ? Number((((bySt.payment_completed ?? 0) / top) * 100).toFixed(2)) : 0,
  };
}

export function purgeOldEvents() {
  if (!db) return { purged: 0 };
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  try {
    const r = db.prepare(`DELETE FROM funnel_events WHERE day < ?`).run(cutoff);
    return { purged: r.changes ?? 0 };
  } catch {
    return { purged: 0 };
  }
}

export function funnelStatus() {
  if (!db) return { enabled: ENABLED, events: 0 };
  const events = db.prepare(`SELECT COUNT(*) AS c FROM funnel_events`).get()?.c ?? 0;
  return { enabled: ENABLED, events, retentionDays: RETENTION_DAYS };
}
