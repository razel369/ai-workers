// WhatsApp 24-hour customer service window + Hebrew template messages.
//
// Meta only allows free-form messages within 24 hours of the customer's last
// inbound message. Outside that window a free-form send is rejected, and
// repeatedly attempting it is one of the fastest ways to get a business number
// rate-limited or blocked — which for an Israeli SMB product means losing the
// single channel the whole pitch rests on.
//
// The router previously sent replies with no notion of the window at all. This
// module tracks the window per (business number, customer) and picks the right
// message type: free-form inside it, an approved template outside it.
//
// Templates must be created and approved in Meta Business Manager first; their
// names are configured here so approval and code can move independently.
//
// ENV:
//   WHATSAPP_TEMPLATE_LANG=he
//   WHATSAPP_TEMPLATE_REENGAGE=nightdesk_reengage_he
//   WHATSAPP_TEMPLATE_LEAD_ALERT=nightdesk_lead_alert_he
//   WHATSAPP_SESSION_HOURS=24

const SESSION_HOURS = Math.max(1, Number(process.env.WHATSAPP_SESSION_HOURS ?? 24));
const TEMPLATE_LANG = (process.env.WHATSAPP_TEMPLATE_LANG ?? 'he').trim();
const TEMPLATE_REENGAGE = (process.env.WHATSAPP_TEMPLATE_REENGAGE ?? '').trim();
const TEMPLATE_LEAD_ALERT = (process.env.WHATSAPP_TEMPLATE_LEAD_ALERT ?? '').trim();

let db = null;

export function initWhatsAppSessions(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      phone_key TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT '',
      worker_id TEXT NOT NULL DEFAULT '',
      last_inbound_at TEXT NOT NULL,
      last_outbound_at TEXT,
      messages_in INTEGER NOT NULL DEFAULT 0,
      messages_out INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (phone_key, customer_phone)
    );
    CREATE INDEX IF NOT EXISTS idx_wa_sessions_tenant ON whatsapp_sessions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_wa_sessions_last ON whatsapp_sessions(last_inbound_at);
  `);
  return db;
}

const digits = (p) => String(p ?? '').replace(/\D/g, '');

/** An inbound message opens (or extends) the customer service window. */
export function recordInbound({ phoneKey, customerPhone, tenantId = '', workerId = '' }) {
  if (!db || !phoneKey || !customerPhone) return null;
  const now = new Date().toISOString();
  try {
    db.prepare(`INSERT INTO whatsapp_sessions
      (phone_key, customer_phone, tenant_id, worker_id, last_inbound_at, messages_in)
      VALUES (?,?,?,?,?,1)
      ON CONFLICT(phone_key, customer_phone) DO UPDATE SET
        last_inbound_at = excluded.last_inbound_at,
        tenant_id = excluded.tenant_id,
        worker_id = excluded.worker_id,
        messages_in = messages_in + 1`)
      .run(phoneKey, digits(customerPhone), tenantId, workerId, now);
  } catch {}
  return { openedAt: now, expiresAt: new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString() };
}

export function recordOutbound({ phoneKey, customerPhone }) {
  if (!db || !phoneKey || !customerPhone) return;
  try {
    db.prepare(`UPDATE whatsapp_sessions SET last_outbound_at = ?, messages_out = messages_out + 1
      WHERE phone_key = ? AND customer_phone = ?`)
      .run(new Date().toISOString(), phoneKey, digits(customerPhone));
  } catch {}
}

/**
 * Whether a free-form (non-template) message is allowed right now.
 * Fails closed: an unknown session is treated as outside the window, because
 * guessing wrong costs the tenant's number, not just one message.
 */
export function sessionWindow({ phoneKey, customerPhone }) {
  if (!db || !phoneKey || !customerPhone) {
    return { open: false, reason: 'unknown_session', hoursRemaining: 0 };
  }
  const row = db.prepare(`SELECT last_inbound_at AS lastInboundAt FROM whatsapp_sessions
    WHERE phone_key = ? AND customer_phone = ?`).get(phoneKey, digits(customerPhone));
  if (!row?.lastInboundAt) return { open: false, reason: 'no_inbound_on_record', hoursRemaining: 0 };
  const elapsedMs = Date.now() - new Date(row.lastInboundAt).getTime();
  const remainingMs = SESSION_HOURS * 3600_000 - elapsedMs;
  return {
    open: remainingMs > 0,
    reason: remainingMs > 0 ? null : 'window_expired',
    hoursRemaining: Math.max(0, Number((remainingMs / 3600_000).toFixed(1))),
    lastInboundAt: row.lastInboundAt,
  };
}

/**
 * Decide what may actually be sent.
 * Returns { type: 'text' } inside the window, { type: 'template', name, params }
 * outside it when a template is configured, or { type: 'blocked' } when there
 * is no lawful way to send — better to surface that than to burn the number.
 */
export function planOutbound({ phoneKey, customerPhone, purpose = 'reply', params = [] }) {
  const window = sessionWindow({ phoneKey, customerPhone });
  if (window.open) return { type: 'text', window };

  const templateName = purpose === 'lead_alert' ? TEMPLATE_LEAD_ALERT : TEMPLATE_REENGAGE;
  if (!templateName) {
    return {
      type: 'blocked', window,
      reason: 'outside_24h_window_and_no_template',
      hint: 'Create and get a Hebrew template approved in Meta Business Manager, then set WHATSAPP_TEMPLATE_REENGAGE.',
    };
  }
  return {
    type: 'template', window,
    name: templateName,
    language: TEMPLATE_LANG,
    params: params.map((p) => String(p ?? '').slice(0, 200)),
  };
}

/** Meta Cloud API payload for either message type. */
export function buildMetaPayload({ to, plan, text }) {
  const recipient = digits(to);
  if (plan.type === 'template') {
    return {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'template',
      template: {
        name: plan.name,
        language: { code: plan.language },
        ...(plan.params.length
          ? { components: [{ type: 'body', parameters: plan.params.map((t) => ({ type: 'text', text: t })) }] }
          : {}),
      },
    };
  }
  return {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'text',
    text: { body: String(text ?? '').slice(0, 4000) },
  };
}

/** Sessions with no inbound for a while — useful for a re-engagement report. */
export function staleSessions({ olderThanHours = SESSION_HOURS, limit = 100 } = {}) {
  if (!db) return [];
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString();
  return db.prepare(`SELECT phone_key AS phoneKey, customer_phone AS customerPhone,
    tenant_id AS tenantId, worker_id AS workerId, last_inbound_at AS lastInboundAt,
    messages_in AS messagesIn, messages_out AS messagesOut
    FROM whatsapp_sessions WHERE last_inbound_at < ? ORDER BY last_inbound_at DESC LIMIT ?`)
    .all(cutoff, limit);
}

export function sessionStats() {
  const cfg = {
    sessionHours: SESSION_HOURS,
    templateLang: TEMPLATE_LANG,
    reengageTemplate: TEMPLATE_REENGAGE || null,
    leadAlertTemplate: TEMPLATE_LEAD_ALERT || null,
    // Without an approved template the business simply cannot re-open a
    // conversation, so flag it rather than letting it fail silently later.
    canReengage: !!TEMPLATE_REENGAGE,
  };
  if (!db) return { ...cfg, total: 0, open: 0 };
  const cutoff = new Date(Date.now() - SESSION_HOURS * 3600_000).toISOString();
  const total = db.prepare(`SELECT COUNT(*) AS c FROM whatsapp_sessions`).get()?.c ?? 0;
  const open = db.prepare(`SELECT COUNT(*) AS c FROM whatsapp_sessions WHERE last_inbound_at >= ?`).get(cutoff)?.c ?? 0;
  return { ...cfg, total, open };
}
