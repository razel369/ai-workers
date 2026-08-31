// Owner alerts — get the lead to a phone, not to a dashboard.
//
// The entire pitch is "you stop losing the customer who writes at 21:00". The
// worker was already capturing those leads correctly — and then filing them in
// SQLite, where the business owner would find them only by logging in. An
// optional per-tenant webhook existed, but almost nobody configures one, so in
// practice a hot lead at 23:00 reached nobody until morning.
//
// A lead the owner never sees is worth the same as a lead never captured, and
// it is the reason a tenant cancels in month two. This module pushes leads and
// escalations to the owner immediately, on whatever channel they gave us.
//
// ENV:
//   OWNER_ALERTS=0             # disable entirely
//   OWNER_ALERT_MIN_SCORE=0    # only alert on leads at/above this score
//   OWNER_ALERT_QUIET_HOURS=   # e.g. 23-7 — hold non-urgent alerts overnight

import * as notify from './notify.js';
const esc = notify.esc;
import * as registry from './tenant-registry.js';

const ENABLED = process.env.OWNER_ALERTS !== '0';
const MIN_SCORE = Number(process.env.OWNER_ALERT_MIN_SCORE ?? 0);
const QUIET = String(process.env.OWNER_ALERT_QUIET_HOURS ?? '').trim();

let publicBaseUrl = '';

export function initOwnerAlerts({ baseUrl } = {}) {
  publicBaseUrl = String(baseUrl ?? '').replace(/\/$/, '');
}

/**
 * Quiet hours suppress routine lead alerts overnight but never urgent
 * escalations — a gas leak reported to a property manager at 02:00 is exactly
 * the message that must not wait.
 */
function inQuietHours(now = new Date()) {
  if (!QUIET) return false;
  const m = QUIET.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return false;
  const [from, to] = [Number(m[1]), Number(m[2])];
  const h = now.getHours();
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

const workerUrl = (workerId) => `${publicBaseUrl}/marketplace#/worker/${encodeURIComponent(workerId)}`;

function dispatch({ tenantId, workerId, subject, html, wa, kind, urgent }) {
  const target = registry.notificationTargets(tenantId);
  let sent = 0;
  if (target.email) {
    const r = notify.queueNotification({
      channel: 'email', recipient: target.email, subject, html,
      kind, tenantId, workerId,
    });
    if (r.queued) sent++;
  }
  if (target.phone && wa) {
    const r = notify.queueNotification({
      channel: 'whatsapp', recipient: target.phone, subject, text: wa,
      kind, tenantId, workerId,
    });
    if (r.queued) sent++;
  }
  if (!sent) return { sent: 0 };
  // Urgent alerts skip the batch sweep and go out on this tick.
  notify.flushOutbox({ limit: urgent ? 5 : 20 }).catch(() => {});
  return { sent };
}

export function alertNewLead({ tenantId, workerId, workerName, lead }) {
  if (!ENABLED) return { sent: 0, skipped: 'disabled' };
  const score = Number(lead?.score ?? 0);
  if (score < MIN_SCORE) return { sent: 0, skipped: 'below_min_score' };
  if (inQuietHours()) return { sent: 0, skipped: 'quiet_hours' };

  const hot = score >= 7;
  const name = lead?.fullName || 'ליד חדש';
  const telHref = String(lead?.phone ?? '').replace(/[^\d+]/g, '');
  const contactBits = [
    lead?.phone ? `<b>טלפון:</b> <a href="tel:${encodeURIComponent(telHref)}">${esc(lead.phone)}</a>` : '',
    lead?.email ? `<b>אימייל:</b> ${esc(lead.email)}` : '',
    lead?.company ? `<b>חברה:</b> ${esc(lead.company)}` : '',
  ].filter(Boolean).join('<br>');

  return dispatch({
    tenantId, workerId, kind: 'lead', urgent: hot,
    subject: `${hot ? '🔥 ליד חם' : 'ליד חדש'}: ${String(name).slice(0, 80)}`,
    html: notify.renderEmail({
      title: `${hot ? '🔥 ליד חם חדש' : 'ליד חדש'} — ${name}`,
      intro: `העובד "${workerName}" קלט ליד חדש עכשיו (דירוג ${score}/10).`,
      bodyHtml: `${contactBits}${contactBits ? '<br><br>' : ''}
        ${lead?.notes ? `<b>מה הלקוח אמר:</b><br>${esc(String(lead.notes).slice(0, 600))}` : ''}`,
      ctaText: 'לצפייה בליד',
      ctaUrl: workerUrl(workerId),
      footerNote: 'אפשר לכבות התראות לידים בהגדרות החשבון.',
    }),
    wa: `${hot ? '🔥 ליד חם' : 'ליד חדש'} מ-"${workerName}":\n${name}` +
      `${lead?.phone ? `\n📞 ${lead.phone}` : ''}${lead?.email ? `\n✉️ ${lead.email}` : ''}` +
      `${lead?.notes ? `\n\n${String(lead.notes).slice(0, 300)}` : ''}\n\n${workerUrl(workerId)}`,
  });
}

export function alertEscalation({ tenantId, workerId, workerName, escalation }) {
  if (!ENABLED) return { sent: 0, skipped: 'disabled' };
  const urgency = String(escalation?.urgency ?? 'normal');
  const urgent = urgency === 'high' || urgency === 'critical';
  // Urgent escalations override quiet hours by design.
  if (!urgent && inQuietHours()) return { sent: 0, skipped: 'quiet_hours' };

  const label = { critical: '🚨 קריטי', high: '⚠️ דחוף', normal: 'רגיל', low: 'נמוך' }[urgency] ?? urgency;
  return dispatch({
    tenantId, workerId, kind: 'escalation', urgent,
    subject: `${label} — לקוח צריך אותך (${workerName})`,
    html: notify.renderEmail({
      title: `${label}: לקוח מבקש אדם`,
      intro: `העובד "${workerName}" העביר אליכם פנייה שדורשת מענה אנושי.`,
      bodyHtml: `<b>סיבה:</b> ${esc(String(escalation?.reason ?? '').slice(0, 600))}<br>
        <b>דחיפות:</b> ${esc(label)}`,
      ctaText: 'לטיפול בפנייה',
      ctaUrl: workerUrl(workerId),
      footerNote: 'הסלמות דחופות נשלחות גם בשעות שקטות.',
    }),
    wa: `${label} — "${workerName}" העביר אליך פנייה:\n${String(escalation?.reason ?? '').slice(0, 300)}\n\n${workerUrl(workerId)}`,
  });
}

/** Warn the owner before their quota runs out, while they can still act on it. */
export function alertQuotaWarning({ tenantId, usage, quota }) {
  if (!ENABLED) return { sent: 0 };
  return dispatch({
    tenantId, workerId: '', kind: 'quota', urgent: false,
    subject: `נותרו ${quota.remaining} שיחות במכסה החודשית`,
    html: notify.renderEmail({
      title: `ניצלתם ${quota.pct}% מהמכסה החודשית`,
      intro: `בחבילת "${quota.planNameHe}" יש ${quota.limit} שיחות בחודש, ונוצלו ${quota.used}.`,
      bodyHtml: `כשהמכסה נגמרת העובד מפסיק לענות ללקוחות עד תחילת החודש הבא.<br><br>
        אם העסק גדל — שדרוג חבילה מונע את זה.`,
      ctaText: 'לשדרוג החבילה',
      ctaUrl: `${publicBaseUrl}/marketplace#/account`,
      footerNote: `עלות משוערת החודש: ${Number(usage?.costIls ?? 0).toFixed(2)} ₪.`,
    }),
    wa: `ניצלתם ${quota.pct}% ממכסת השיחות החודשית (${quota.used}/${quota.limit}). לשדרוג: ${publicBaseUrl}/marketplace#/account`,
  });
}

export function ownerAlertsStatus() {
  return { enabled: ENABLED, minScore: MIN_SCORE, quietHours: QUIET || null };
}
