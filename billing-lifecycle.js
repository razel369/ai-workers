// Billing lifecycle — the recurring-revenue loop.
//
// Before this module `paid_until` was written once at activation and then never
// looked at again by anything but a boolean check at chat time. A customer paid
// by Bit, got 30 days, and on day 31 their worker went silent — no reminder, no
// grace, no receipt, nobody told. That is silent churn by construction, and for
// a subscription business it is the difference between a demo and a company.
//
// This runs once a day and drives every worker through:
//
//   active → (T-7/T-3/T-1 reminders) → expiry → GRACE_DAYS still answering
//          → dunning 1..3 → suspended
//
// Grace matters commercially: cutting a clinic's chat off at midnight on the
// renewal date, with the customer mid-conversation, is how you turn a late
// payment into a cancellation.
//
// ENV:
//   BILLING_GRACE_DAYS=5          # keep answering this long past paid_until
//   BILLING_REMINDER_DAYS=7,3,1   # send renewal reminders this many days out
//   BILLING_RUN_HOUR=8            # local hour for the daily run
//   BILLING_DISABLED=1            # turn the scheduler off (tests)

import * as notify from './notify.js';
const esc = notify.esc;
import * as registry from './tenant-registry.js';
import * as metering from './usage-metering.js';
import * as ownerAlerts from './owner-alerts.js';

const DAY_MS = 86_400_000;

export const GRACE_DAYS = Math.max(0, Number(process.env.BILLING_GRACE_DAYS ?? 5));
const REMINDER_DAYS = String(process.env.BILLING_REMINDER_DAYS ?? '7,3,1')
  .split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => b - a);
const RUN_HOUR = Math.min(23, Math.max(0, Number(process.env.BILLING_RUN_HOUR ?? 8)));
const DISABLED = process.env.BILLING_DISABLED === '1';

let db = null;
let workers = null;
let publicBaseUrl = '';
let timer = null;

export function initBilling({ database, workersModule, baseUrl }) {
  db = database;
  workers = workersModule;
  publicBaseUrl = String(baseUrl ?? '').replace(/\/$/, '');
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_billing_events_at ON billing_events(at);
    CREATE INDEX IF NOT EXISTS idx_billing_events_worker ON billing_events(worker_id, event);
    CREATE TABLE IF NOT EXISTS billing_runs (
      run_date TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      scanned INTEGER NOT NULL DEFAULT 0,
      reminders INTEGER NOT NULL DEFAULT 0,
      suspended INTEGER NOT NULL DEFAULT 0,
      errors TEXT
    );
  `);
  return db;
}

// --- Date helpers ---------------------------------------------------------

const todayKey = (d = new Date()) => d.toISOString().slice(0, 10);

/** Whole days from now until `iso`. Negative once the date has passed. */
export function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / DAY_MS);
}

/**
 * A worker whose paid_until has passed but is still inside the grace window.
 * workers.js keeps these answering customers; the UI shows a renewal banner.
 */
export function isWithinGrace(paidUntil) {
  if (!paidUntil) return false;
  const end = new Date(paidUntil).getTime();
  if (!Number.isFinite(end)) return false;
  const now = Date.now();
  return now > end && now <= end + GRACE_DAYS * DAY_MS;
}

export function graceEndsAt(paidUntil) {
  if (!paidUntil) return null;
  const end = new Date(paidUntil).getTime();
  if (!Number.isFinite(end)) return null;
  return new Date(end + GRACE_DAYS * DAY_MS).toISOString();
}

function logEvent(tenantId, workerId, event, detail = '') {
  try {
    db.prepare(`INSERT INTO billing_events (at, tenant_id, worker_id, event, detail) VALUES (?,?,?,?,?)`)
      .run(new Date().toISOString(), tenantId, workerId, event, String(detail).slice(0, 500));
  } catch {}
}

const fmtDate = (iso) => {
  try { return new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return String(iso ?? ''); }
};

// --- Message templates ----------------------------------------------------

function renewUrl(workerId) {
  return `${publicBaseUrl}/marketplace#/worker/${encodeURIComponent(workerId)}`;
}

function buildRenewalReminder({ businessName, workerName, paidUntil, days, workerId, plan }) {
  const when = days === 1 ? 'מחר' : `בעוד ${days} ימים`;
  const price = registry.getPlan(plan).priceIls;
  return {
    subject: `${workerName} — המנוי מתחדש ${when}`,
    html: notify.renderEmail({
      title: `המנוי של ${workerName} מסתיים ${when}`,
      intro: `שלום ${businessName}, המנוי לעובד "${workerName}" בתוקף עד ${fmtDate(paidUntil)}.`,
      bodyHtml: `כדי שהעובד ימשיך לענות ללקוחות שלכם ברצף, אפשר לחדש עכשיו${price ? ` (${esc(price)} ₪ לחודש)` : ''}.<br><br>
        <b>מה קורה אם לא מחדשים?</b><br>
        העובד ממשיך לענות עוד ${GRACE_DAYS} ימים אחרי תאריך הסיום, ורק אז מושהה. השיחות, הלידים והידע שלכם נשמרים.`,
      ctaText: 'לחידוש המנוי',
      ctaUrl: renewUrl(workerId),
      footerNote: 'קיבלתם את ההודעה כי יש לכם עובד פעיל בפלטפורמה.',
    }),
    wa: `שלום ${businessName}, המנוי לעובד "${workerName}" מסתיים ${when} (${fmtDate(paidUntil)}). לחידוש: ${renewUrl(workerId)}`,
  };
}

function buildTrialEnding({ businessName, workerName, paidUntil, days, workerId }) {
  const when = days <= 0 ? 'היום' : days === 1 ? 'מחר' : `בעוד ${days} ימים`;
  return {
    subject: `הניסיון של ${workerName} נגמר ${when}`,
    html: notify.renderEmail({
      title: `תקופת הניסיון מסתיימת ${when}`,
      intro: `שלום ${businessName}, הניסיון של "${workerName}" בתוקף עד ${fmtDate(paidUntil)}.`,
      bodyHtml: `אם העובד עזר לכם לתפוס פניות שהייתם מפספסים — אפשר להמשיך במנוי חודשי, ביטול בכל עת.<br><br>
        כל מה שהגדרתם — פרסונה, ידע, לידים והיסטוריית שיחות — נשמר ויחכה לכם.`,
      ctaText: 'להמשיך עם מנוי',
      ctaUrl: renewUrl(workerId),
      footerNote: 'לא רוצים להמשיך? אין צורך לעשות דבר.',
    }),
    wa: `שלום ${businessName}, הניסיון של "${workerName}" נגמר ${when}. להמשך: ${renewUrl(workerId)}`,
  };
}

function buildGraceNotice({ businessName, workerName, workerId, graceEnd, stage }) {
  const left = Math.max(0, daysUntil(graceEnd) ?? 0);
  const titles = [
    'המנוי פג — העובד עדיין עונה',
    'תזכורת שנייה — העובד יושהה בקרוב',
    'הודעה אחרונה לפני השהיה',
  ];
  return {
    subject: `${workerName} — ${titles[Math.min(stage - 1, 2)]}`,
    html: notify.renderEmail({
      title: titles[Math.min(stage - 1, 2)],
      intro: `שלום ${businessName}, המנוי של "${workerName}" הסתיים.`,
      bodyHtml: `העובד <b>ממשיך לענות ללקוחות שלכם עוד ${esc(left)} ימים</b> (עד ${esc(fmtDate(graceEnd))}).<br><br>
        אחרי זה הוא יושהה ולא יענה לפניות — הנתונים שלכם יישמרו ותוכלו להפעיל מחדש בכל רגע.`,
      ctaText: 'לחידוש מיידי',
      ctaUrl: renewUrl(workerId),
      footerNote: 'אם כבר שילמתם, ייתכן שהאישור בדרך — אפשר להשיב למייל הזה.',
    }),
    wa: `${businessName}: המנוי של "${workerName}" הסתיים. העובד עונה עוד ${left} ימים. לחידוש: ${renewUrl(workerId)}`,
  };
}

function buildSuspended({ businessName, workerName, workerId }) {
  return {
    subject: `${workerName} הושהה`,
    html: notify.renderEmail({
      title: 'העובד הושהה',
      intro: `שלום ${businessName}, "${workerName}" הושהה כי המנוי לא חודש.`,
      bodyHtml: `<b>הלקוחות שלכם כבר לא מקבלים מענה מהעובד.</b><br><br>
        כל הנתונים — הידע, ההגדרות, הלידים והשיחות — נשמרים במלואם. חידוש מחזיר את העובד לפעולה מיידית, בדיוק איפה שהפסיק.`,
      ctaText: 'להפעיל מחדש',
      ctaUrl: renewUrl(workerId),
      footerNote: 'רוצים לבטל לגמרי ולמחוק נתונים? השיבו למייל הזה ונטפל בזה.',
    }),
    wa: `${businessName}: העובד "${workerName}" הושהה — הלקוחות לא מקבלים מענה. להפעלה: ${renewUrl(workerId)}`,
  };
}

export function buildPaymentReceipt({ businessName, workerName, amountIls, paidUntil, workerId, reference }) {
  return {
    subject: `אישור תשלום — ${workerName}`,
    html: notify.renderEmail({
      title: 'התשלום התקבל ✓',
      intro: `תודה ${businessName}, "${workerName}" פעיל עד ${fmtDate(paidUntil)}.`,
      bodyHtml: `<b>סכום:</b> ${esc(amountIls || 0)} ₪<br>
        <b>אסמכתא:</b> ${esc(reference || '—')}<br>
        <b>בתוקף עד:</b> ${esc(fmtDate(paidUntil))}<br><br>
        נשלח לכם תזכורת לפני החידוש הבא.`,
      ctaText: 'לצפייה בחשבונית',
      ctaUrl: `${publicBaseUrl}/invoice/${encodeURIComponent(workerId)}`,
      footerNote: 'שמרו את המייל הזה לצורכי הנהלת חשבונות.',
    }),
    wa: `תודה! העובד "${workerName}" פעיל עד ${fmtDate(paidUntil)}. חשבונית: ${publicBaseUrl}/invoice/${workerId}`,
  };
}

// --- Dispatch -------------------------------------------------------------

/**
 * Queue a message to a tenant on every channel they opted into.
 * `dedupeKey` makes the whole daily run idempotent — running it twice on the
 * same day cannot double-send.
 */
export function notifyTenant(tenantId, workerId, msg, dedupeKey) {
  const target = registry.notificationTargets(tenantId);
  let queued = 0;
  if (target.email) {
    const r = notify.queueNotification({
      channel: 'email', recipient: target.email, subject: msg.subject,
      html: msg.html, kind: 'billing', tenantId, workerId,
      dedupeKey: dedupeKey ? `${dedupeKey}:email` : null,
    });
    if (r.queued) queued++;
  }
  if (target.phone && msg.wa) {
    const r = notify.queueNotification({
      channel: 'whatsapp', recipient: target.phone, subject: msg.subject,
      text: msg.wa, kind: 'billing', tenantId, workerId,
      dedupeKey: dedupeKey ? `${dedupeKey}:wa` : null,
    });
    if (r.queued) queued++;
  }
  // No contact channel at all — record it so the admin can chase it up.
  if (!target.email && !target.phone) logEvent(tenantId, workerId, 'unreachable', 'no contact on file');
  return queued;
}

/**
 * Receipt for any successful activation, whatever the channel.
 *
 * Bit and bank transfer are the primary Israeli channels, so putting the
 * receipt only on the card path would leave most paying customers with no
 * confirmation and no bookkeeping record. Deduped on (worker, reference).
 */
export function sendActivationReceipt({ tenantId, workerId, workerName, amountIls, paidUntil, reference }) {
  if (!tenantId || !workerId) return { sent: 0 };
  try {
    const t = registry.getTenant(tenantId);
    const msg = buildPaymentReceipt({
      businessName: t?.businessName || 'לקוח יקר',
      workerName: workerName || 'העובד שלכם',
      amountIls, paidUntil, workerId,
      reference: reference || '—',
    });
    const queued = notifyTenant(tenantId, workerId, msg, `receipt:${workerId}:${reference || paidUntil}`);
    if (queued) notify.flushOutbox({ limit: 5 }).catch(() => {});
    logEvent(tenantId, workerId, 'receipt_sent', reference || '');
    return { sent: queued };
  } catch {
    return { sent: 0 };
  }
}

// --- The daily cycle ------------------------------------------------------

/**
 * Walk every worker with a paid_until and act on where it sits relative to now.
 * Safe to call repeatedly: every send is deduped on (worker, event, date).
 */
export async function runBillingCycle({ force = false } = {}) {
  if (!db || !workers) return { ok: false, error: 'billing_not_initialised' };
  const runDate = todayKey();
  if (!force) {
    const existing = db.prepare(`SELECT finished_at FROM billing_runs WHERE run_date = ?`).get(runDate);
    if (existing?.finished_at) return { ok: true, skipped: 'already_ran_today' };
  }
  db.prepare(`INSERT INTO billing_runs (run_date, started_at) VALUES (?,?)
    ON CONFLICT(run_date) DO UPDATE SET started_at = excluded.started_at`)
    .run(runDate, new Date().toISOString());

  let scanned = 0, reminders = 0, suspended = 0;
  const errors = [];
  let all = [];
  try { all = workers.adminListAllWorkers({ fresh: true }); } catch (e) { errors.push(String(e?.message ?? e)); }

  for (const w of all) {
    scanned++;
    try {
      const target = registry.notificationTargets(w.tenantId);
      const businessName = target.businessName;
      const workerName = w.name || 'העובד שלכם';
      const isTrial = !w.paidUntil ? false : isTrialWorker(w);
      const left = daysUntil(w.paidUntil);

      if (w.status === 'suspended' || w.status === 'pending_payment' || left === null) continue;

      // 1. Still in force — remind at the configured horizons.
      if (left > 0) {
        if (!REMINDER_DAYS.includes(left)) continue;
        const key = `bill:${w.id}:${isTrial ? 'trial' : 'renew'}:${left}:${runDate}`;
        const msg = isTrial
          ? buildTrialEnding({ businessName, workerName, paidUntil: w.paidUntil, days: left, workerId: w.id })
          : buildRenewalReminder({
              businessName, workerName, paidUntil: w.paidUntil, days: left,
              workerId: w.id, plan: registry.getTenant(w.tenantId)?.plan,
            });
        if (notifyTenant(w.tenantId, w.id, msg, key)) {
          reminders++;
          logEvent(w.tenantId, w.id, isTrial ? 'trial_reminder' : 'renewal_reminder', `T-${left}`);
        }
        continue;
      }

      // 2. Past the date but inside grace — escalate the dunning stage daily-ish.
      if (isWithinGrace(w.paidUntil)) {
        const graceEnd = graceEndsAt(w.paidUntil);
        const elapsed = Math.abs(left);
        // Stage 1 on day 0, stage 2 mid-grace, stage 3 on the last day.
        const stage = elapsed === 0 ? 1 : elapsed >= GRACE_DAYS - 1 ? 3 : 2;
        const key = `bill:${w.id}:grace:${stage}`;
        const msg = buildGraceNotice({ businessName, workerName, workerId: w.id, graceEnd, stage });
        if (notifyTenant(w.tenantId, w.id, msg, key)) {
          reminders++;
          registry.setDunningStage(w.tenantId, stage);
          logEvent(w.tenantId, w.id, 'dunning', `stage ${stage}`);
        }
        continue;
      }

      // 3. Grace exhausted — suspend and say so.
      if (w.status === 'active') {
        const r = suspendWorker(w.tenantId, w.id);
        if (r.ok) {
          suspended++;
          logEvent(w.tenantId, w.id, 'suspended', `paid_until ${w.paidUntil}`);
          notifyTenant(w.tenantId, w.id, buildSuspended({ businessName, workerName, workerId: w.id }), `bill:${w.id}:suspended`);
        }
      }
    } catch (e) {
      errors.push(`${w.id}: ${e?.message ?? e}`);
    }
  }

  // Warn tenants approaching their message quota while they can still act on
  // it — a worker that stops answering mid-month with no warning reads as an
  // outage, not as a plan limit.
  let quotaWarnings = 0;
  for (const t of registry.listTenants()) {
    try {
      const quota = metering.checkQuota(t.tenantId);
      if (!quota.nearLimit || quota.exceeded) continue;
      if (metering.quotaNoticeState(t.tenantId).warnedAt) continue;
      const sent = ownerAlerts.alertQuotaWarning({
        tenantId: t.tenantId, usage: metering.tenantUsage(t.tenantId), quota,
      });
      if (sent.sent) {
        metering.markQuotaNotice(t.tenantId, 'warned');
        logEvent(t.tenantId, '', 'quota_warning', `${quota.pct}%`);
        quotaWarnings++;
      }
    } catch (e) {
      errors.push(`quota ${t.tenantId}: ${e?.message ?? e}`);
    }
  }

  // Push whatever the cycle queued.
  let flushed = { sent: 0, failed: 0 };
  try { flushed = await notify.flushOutbox({ limit: 200 }); } catch (e) { errors.push(String(e?.message ?? e)); }

  db.prepare(`UPDATE billing_runs SET finished_at = ?, scanned = ?, reminders = ?, suspended = ?, errors = ? WHERE run_date = ?`)
    .run(new Date().toISOString(), scanned, reminders, suspended,
      errors.length ? errors.slice(0, 20).join(' | ').slice(0, 1000) : null, runDate);

  return { ok: true, runDate, scanned, reminders, suspended, quotaWarnings, flushed, errors: errors.length };
}

/**
 * A trial worker is one that was auto-activated by TRIAL_DAYS and has never had
 * a paid rental recorded against it.
 */
function isTrialWorker(w) {
  try {
    const paid = workers.workerHasPaidRental?.(w.tenantId, w.id);
    if (paid !== undefined) return !paid;
  } catch {}
  return false;
}

function suspendWorker(tenantId, workerId) {
  try {
    if (typeof workers.adminSuspendWorker === 'function') {
      return workers.adminSuspendWorker(tenantId, workerId);
    }
    return { ok: false, error: 'suspend_unavailable' };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function billingStats() {
  if (!db) return { lastRun: null, events: 0 };
  const lastRun = db.prepare(`SELECT run_date AS runDate, started_at AS startedAt, finished_at AS finishedAt,
    scanned, reminders, suspended, errors FROM billing_runs ORDER BY run_date DESC LIMIT 1`).get() ?? null;
  const events = db.prepare(`SELECT COUNT(*) AS c FROM billing_events`).get()?.c ?? 0;
  const recent = db.prepare(`SELECT at, tenant_id AS tenantId, worker_id AS workerId, event, detail
    FROM billing_events ORDER BY id DESC LIMIT 50`).all();
  return { lastRun, events, recent, graceDays: GRACE_DAYS, reminderDays: REMINDER_DAYS, enabled: !DISABLED };
}

// --- Scheduler ------------------------------------------------------------

/**
 * Check hourly and run once when the clock passes BILLING_RUN_HOUR.
 * An hourly tick (rather than a 24h timer) means a container restart cannot
 * skip a day, which for a billing job is the failure that costs money.
 */
export function startBillingScheduler() {
  if (DISABLED || timer) return { started: false, reason: DISABLED ? 'disabled' : 'already_running' };
  const tick = async () => {
    try {
      if (new Date().getHours() < RUN_HOUR) return;
      await runBillingCycle();
    } catch (e) {
      console.warn('[billing] cycle failed:', e?.message ?? e);
    }
  };
  timer = setInterval(tick, 60 * 60_000);
  timer.unref?.();
  // Also sweep the outbox every few minutes so retries actually drain.
  const outboxTimer = setInterval(() => {
    notify.flushOutbox({ limit: 50 }).catch(() => {});
  }, 5 * 60_000);
  outboxTimer.unref?.();
  setTimeout(tick, 30_000).unref?.();
  return { started: true, runHour: RUN_HOUR, graceDays: GRACE_DAYS };
}

export function stopBillingScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
