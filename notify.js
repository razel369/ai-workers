// Platform notification transport — transactional email + WhatsApp + webhook.
//
// The worker-level `email_smtp` integration in integrations/runner.js is a TOOL
// the AI worker calls. This module is different: it is how the PLATFORM talks to
// its own customers (renewal reminders, trial expiry, receipts, lead alerts).
// Without it there is no way to tell a tenant their worker is about to stop.
//
// Zero npm dependencies: HTTP providers via fetch, SMTP via node:net + node:tls.
//
// ENV:
//   MAIL_PROVIDER=resend|sendgrid|mailgun|postmark|smtp|webhook|console
//     (auto-detected from whichever credentials are present)
//   MAIL_FROM="AI Workers <noreply@example.com>"
//   MAIL_REPLY_TO=support@example.com
//   RESEND_API_KEY / SENDGRID_API_KEY / POSTMARK_TOKEN
//   MAILGUN_API_KEY + MAILGUN_DOMAIN
//   SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_SECURE=1
//   MAIL_WEBHOOK_URL      # generic JSON POST fallback (Zapier/Make)
//   NOTIFY_MAX_ATTEMPTS=5

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const SMTP_TIMEOUT_MS = 20_000;
const HTTP_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = Number(process.env.NOTIFY_MAX_ATTEMPTS ?? 5);
const RETRY_BACKOFF_MIN = [1, 5, 30, 120, 480]; // minutes between attempts

const env = (k, d = '') => (process.env[k] ?? d).trim();

export const MAIL_FROM = env('MAIL_FROM') || (env('AGENT_OWNER_CONTACT') ? `AI Workers <${env('AGENT_OWNER_CONTACT')}>` : '');
const MAIL_REPLY_TO = env('MAIL_REPLY_TO') || env('AGENT_OWNER_CONTACT');

let db = null;

/** Wire the outbox table onto the platform DB. Call once at startup. */
export function initNotify(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      channel TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'generic',
      tenant_id TEXT,
      worker_id TEXT,
      dedupe_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      sent_at TEXT,
      provider TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON notification_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_outbox_tenant ON notification_outbox(tenant_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedupe ON notification_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
  `);
  return db;
}

// --- Provider resolution --------------------------------------------------

export function resolveProvider() {
  const explicit = env('MAIL_PROVIDER').toLowerCase();
  if (explicit) return explicit;
  if (env('RESEND_API_KEY')) return 'resend';
  if (env('SENDGRID_API_KEY')) return 'sendgrid';
  if (env('POSTMARK_TOKEN')) return 'postmark';
  if (env('MAILGUN_API_KEY') && env('MAILGUN_DOMAIN')) return 'mailgun';
  if (env('SMTP_HOST')) return 'smtp';
  if (env('MAIL_WEBHOOK_URL')) return 'webhook';
  return 'console';
}

export function notifyConfigStatus() {
  const provider = resolveProvider();
  return {
    provider,
    configured: provider !== 'console',
    fromSet: !!MAIL_FROM,
    replyToSet: !!MAIL_REPLY_TO,
    // A configured provider with no From address cannot actually send.
    deliverable: provider !== 'console' && !!MAIL_FROM,
    whatsappDeliverable: !!(
      (env('WHATSAPP_TOKEN') || env('WHATSAPP_ACCESS_TOKEN'))
      && (env('WHATSAPP_PHONE_ID') || env('WHATSAPP_PHONE_NUMBER_ID'))
    ),
  };
}

// --- Hebrew RTL email shell ----------------------------------------------

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * Wrap body content in an RTL Hebrew email shell.
 * Table-based + inline styles: Gmail/Outlook strip <style> blocks.
 */
export function renderEmail({ title, intro, bodyHtml = '', ctaText = '', ctaUrl = '', footerNote = '' }) {
  const brand = env('AGENT_NAME', 'AI Workers');
  const cta = ctaText && ctaUrl
    ? `<tr><td style="padding:8px 0 24px"><a href="${esc(ctaUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px">${esc(ctaText)}</a></td></tr>`
    : '';
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:'Segoe UI',Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px;text-align:right;direction:rtl">
<tr><td style="font-size:13px;color:#6b7280;padding-bottom:16px">${esc(brand)}</td></tr>
<tr><td style="font-size:21px;font-weight:700;color:#111827;padding-bottom:12px">${esc(title)}</td></tr>
<tr><td style="font-size:15px;line-height:1.7;color:#374151;padding-bottom:16px">${esc(intro)}</td></tr>
<tr><td style="font-size:15px;line-height:1.7;color:#374151;padding-bottom:16px">${bodyHtml}</td></tr>
${cta}
<tr><td style="border-top:1px solid #e5e7eb;padding-top:16px;font-size:12px;color:#9ca3af;line-height:1.6">
${esc(footerNote)}${footerNote ? '<br>' : ''}
${MAIL_REPLY_TO ? `לשאלות: ${esc(MAIL_REPLY_TO)}` : ''}
</td></tr>
</table></td></tr></table></body></html>`;
}

/** Strip tags for the text/plain alternative (spam filters penalise HTML-only). */
export function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|div|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Queue ---------------------------------------------------------------

/**
 * Queue a message. Returns { queued, id, deduplicated }.
 * `dedupeKey` makes the daily scheduler idempotent — re-running it the same day
 * will not send a second "your worker expires tomorrow" email.
 */
export function queueNotification({
  channel = 'email', recipient, subject = '', html = '', text = '',
  kind = 'generic', tenantId = null, workerId = null, dedupeKey = null,
} = {}) {
  if (!db) return { queued: false, error: 'notify_not_initialised' };
  const to = String(recipient ?? '').trim();
  if (!to) return { queued: false, error: 'recipient_required' };
  if (channel === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { queued: false, error: 'invalid_email' };
  }
  if (channel === 'whatsapp' && !/^\d{9,15}$/.test(to.replace(/\D/g, ''))) {
    return { queued: false, error: 'invalid_phone' };
  }
  subject = String(subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  const id = `ntf_${crypto.randomBytes(12).toString('hex')}`;
  const now = new Date().toISOString();
  const bodyText = text || (html ? htmlToText(html) : '');
  try {
    db.prepare(`INSERT INTO notification_outbox
      (id, created_at, channel, recipient, subject, body_html, body_text, kind, tenant_id, worker_id, dedupe_key, status, next_attempt_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?)`)
      .run(id, now, channel, to, subject, html, bodyText, kind, tenantId, workerId, dedupeKey, now);
    return { queued: true, id };
  } catch (e) {
    // Unique index on dedupe_key — this exact message already went out.
    if (String(e?.message ?? '').includes('UNIQUE')) return { queued: false, deduplicated: true };
    return { queued: false, error: e?.message ?? String(e) };
  }
}

/** Queue + attempt immediate delivery. Used for time-critical alerts (new lead). */
export async function sendNow(msg) {
  const q = queueNotification(msg);
  if (!q.queued) return q;
  await flushOutbox({ limit: 1, id: q.id });
  return q;
}

/**
 * Deliver pending messages whose retry time has come.
 * Returns { attempted, sent, failed }.
 */
export async function flushOutbox({ limit = 25, id = null } = {}) {
  if (!db) return { attempted: 0, sent: 0, failed: 0 };
  const now = new Date().toISOString();
  const rows = id
    ? db.prepare(`SELECT * FROM notification_outbox WHERE id = ? AND status = 'pending'`).all(id)
    : db.prepare(`SELECT * FROM notification_outbox
        WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC LIMIT ?`).all(now, limit);

  let sent = 0, failed = 0;
  for (const row of rows) {
    let result;
    try {
      result = row.channel === 'webhook' ? await deliverWebhook(row)
        : row.channel === 'whatsapp' ? await deliverWhatsApp(row)
        : await deliverEmail(row);
    } catch (e) {
      result = { ok: false, error: e?.message ?? String(e) };
    }
    const attempts = row.attempts + 1;
    if (result.ok) {
      db.prepare(`UPDATE notification_outbox SET status='sent', attempts=?, sent_at=?, provider=?, last_error=NULL WHERE id=?`)
        .run(attempts, new Date().toISOString(), result.provider ?? '', row.id);
      sent++;
    } else {
      const dead = attempts >= MAX_ATTEMPTS;
      const backoff = RETRY_BACKOFF_MIN[Math.min(attempts - 1, RETRY_BACKOFF_MIN.length - 1)];
      const nextAt = new Date(Date.now() + backoff * 60_000).toISOString();
      db.prepare(`UPDATE notification_outbox SET status=?, attempts=?, next_attempt_at=?, last_error=? WHERE id=?`)
        .run(dead ? 'failed' : 'pending', attempts, nextAt, String(result.error ?? 'unknown').slice(0, 300), row.id);
      failed++;
    }
  }
  return { attempted: rows.length, sent, failed };
}

export function outboxStats() {
  if (!db) return { pending: 0, sent: 0, failed: 0 };
  const row = db.prepare(`SELECT
    SUM(status='pending') AS pending,
    SUM(status='sent') AS sent,
    SUM(status='failed') AS failed FROM notification_outbox`).get();
  return { pending: row?.pending ?? 0, sent: row?.sent ?? 0, failed: row?.failed ?? 0 };
}

/**
 * Drop delivered notifications past their retention window.
 * The outbox otherwise grows forever, and sent rows carry recipient addresses
 * long after they serve any purpose.
 */
export function purgeOldNotifications(days = Number(process.env.NOTIFY_RETENTION_DAYS ?? 90)) {
  if (!db) return { purged: 0 };
  const cutoff = new Date(Date.now() - Math.max(7, days) * 86_400_000).toISOString();
  try {
    const r = db.prepare(`DELETE FROM notification_outbox WHERE status IN ('sent','failed') AND created_at < ?`).run(cutoff);
    return { purged: r.changes ?? 0 };
  } catch {
    return { purged: 0 };
  }
}

export function recentNotifications(limit = 50) {
  if (!db) return [];
  return db.prepare(`SELECT id, created_at AS createdAt, channel, recipient, subject, kind,
    tenant_id AS tenantId, status, attempts, last_error AS lastError, sent_at AS sentAt, provider
    FROM notification_outbox ORDER BY created_at DESC LIMIT ?`).all(Math.min(limit, 200));
}

// --- Delivery ------------------------------------------------------------

async function deliverEmail(row) {
  const provider = resolveProvider();
  if (!MAIL_FROM && provider !== 'console' && provider !== 'webhook') {
    return { ok: false, error: 'mail_from_not_configured' };
  }
  const msg = {
    to: row.recipient,
    subject: row.subject || '(ללא נושא)',
    html: row.body_html,
    text: row.body_text,
    from: MAIL_FROM,
    replyTo: MAIL_REPLY_TO,
  };
  switch (provider) {
    case 'resend': return sendViaResend(msg);
    case 'sendgrid': return sendViaSendGrid(msg);
    case 'postmark': return sendViaPostmark(msg);
    case 'mailgun': return sendViaMailgun(msg);
    case 'smtp': return sendViaSmtp(msg);
    case 'webhook': return sendViaWebhook(msg);
    default:
      console.log(`[notify:console] → ${msg.to} | ${msg.subject}`);
      return { ok: true, provider: 'console' };
  }
}

async function deliverWhatsApp(row) {
  const r = await sendPlatformWhatsApp(row.recipient, row.body_text || htmlToText(row.body_html));
  return r.ok ? { ok: true, provider: 'whatsapp' } : { ok: false, error: r.error };
}

async function deliverWebhook(row) {
  const url = env('MAIL_WEBHOOK_URL') || env('WEBHOOK_NOTIFY_URL');
  if (!url) return { ok: false, error: 'webhook_url_not_configured' };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: row.kind, recipient: row.recipient, subject: row.subject,
      text: row.body_text, tenantId: row.tenant_id, workerId: row.worker_id,
      at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return r.ok ? { ok: true, provider: 'webhook' } : { ok: false, error: `webhook_http_${r.status}` };
}

function parseAddress(addr) {
  const m = String(addr).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { name: '', email: String(addr).trim() };
}

async function sendViaResend(msg) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env('RESEND_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: msg.from, to: [msg.to], subject: msg.subject,
      html: msg.html, text: msg.text,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (r.ok) return { ok: true, provider: 'resend' };
  return { ok: false, error: `resend_http_${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` };
}

async function sendViaSendGrid(msg) {
  const from = parseAddress(msg.from);
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${env('SENDGRID_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: msg.to }] }],
      from: { email: from.email, name: from.name || undefined },
      ...(msg.replyTo ? { reply_to: { email: msg.replyTo } } : {}),
      subject: msg.subject,
      content: [
        { type: 'text/plain', value: msg.text || ' ' },
        ...(msg.html ? [{ type: 'text/html', value: msg.html }] : []),
      ],
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (r.ok || r.status === 202) return { ok: true, provider: 'sendgrid' };
  return { ok: false, error: `sendgrid_http_${r.status}` };
}

async function sendViaPostmark(msg) {
  const r = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': env('POSTMARK_TOKEN'),
      'content-type': 'application/json', accept: 'application/json',
    },
    body: JSON.stringify({
      From: msg.from, To: msg.to, Subject: msg.subject,
      HtmlBody: msg.html, TextBody: msg.text,
      ...(msg.replyTo ? { ReplyTo: msg.replyTo } : {}),
      MessageStream: env('POSTMARK_STREAM', 'outbound'),
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (r.ok) return { ok: true, provider: 'postmark' };
  return { ok: false, error: `postmark_http_${r.status}` };
}

async function sendViaMailgun(msg) {
  const domain = env('MAILGUN_DOMAIN');
  const region = env('MAILGUN_REGION') === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
  const form = new URLSearchParams({
    from: msg.from, to: msg.to, subject: msg.subject,
    text: msg.text || ' ', ...(msg.html ? { html: msg.html } : {}),
    ...(msg.replyTo ? { 'h:Reply-To': msg.replyTo } : {}),
  });
  const r = await fetch(`https://${region}/v3/${encodeURIComponent(domain)}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`api:${env('MAILGUN_API_KEY')}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (r.ok) return { ok: true, provider: 'mailgun' };
  return { ok: false, error: `mailgun_http_${r.status}` };
}

async function sendViaWebhook(msg) {
  const url = env('MAIL_WEBHOOK_URL');
  if (!url) return { ok: false, error: 'mail_webhook_url_not_configured' };
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return r.ok ? { ok: true, provider: 'webhook' } : { ok: false, error: `mail_webhook_http_${r.status}` };
}

// --- Raw SMTP (node:net + node:tls, no dependencies) ----------------------

/** Strip CR/LF before anything reaches a mail header — otherwise a value we
 *  interpolate (a tenant-chosen worker name, say) can inject extra headers. */
function sanitizeHeaderValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeaderWord(raw) {
  const value = sanitizeHeaderValue(raw);
  // RFC 2047 — Hebrew subjects must be encoded or they arrive as mojibake.
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildMimeMessage(msg) {
  const boundary = `bnd_${crypto.randomBytes(12).toString('hex')}`;
  const b64 = (s) => Buffer.from(s ?? '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const headers = [
    `From: ${sanitizeHeaderValue(msg.from)}`,
    `To: ${sanitizeHeaderValue(msg.to)}`,
    msg.replyTo ? `Reply-To: ${sanitizeHeaderValue(msg.replyTo)}` : '',
    `Subject: ${encodeHeaderWord(msg.subject)}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${parseAddress(msg.from).email.split('@')[1] || 'localhost'}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean).join('\r\n');
  const body = [
    '', `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    b64(msg.text || ' '),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    b64(msg.html || `<pre>${esc(msg.text ?? '')}</pre>`),
    `--${boundary}--`, '',
  ].join('\r\n');
  // Dot-stuffing: a lone "." on its own line would end DATA early.
  return `${headers}\r\n${body}`.replace(/\r\n\./g, '\r\n..');
}

function sendViaSmtp(msg) {
  const host = env('SMTP_HOST');
  const port = Number(env('SMTP_PORT', '587'));
  const user = env('SMTP_USER');
  const pass = env('SMTP_PASS');
  const implicitTls = env('SMTP_SECURE') === '1' || port === 465;
  if (!host) return Promise.resolve({ ok: false, error: 'smtp_host_not_configured' });

  return new Promise((resolve) => {
    let socket = implicitTls
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    let buffer = '';
    let settled = false;
    let upgraded = implicitTls;
    const queue = [];
    let waiting = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    const fail = (error) => finish({ ok: false, error });

    const timer = setTimeout(() => fail('smtp_timeout'), SMTP_TIMEOUT_MS);
    timer.unref?.();

    const write = (line) => socket.write(`${line}\r\n`);
    // Await a full SMTP reply (last line has a space, not a hyphen, after the code).
    const expect = (codes, onReply) => { waiting = { codes, onReply }; };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        queue.push(line);
        if (/^\d{3} /.test(line)) {
          const reply = queue.splice(0, queue.length);
          const code = Number(line.slice(0, 3));
          const w = waiting;
          waiting = null;
          if (!w) continue;
          if (!w.codes.includes(code)) return fail(`smtp_${code}: ${line.slice(0, 120)}`);
          try { w.onReply(reply, code); } catch (e) { return fail(e?.message ?? String(e)); }
        }
      }
    };

    const attach = () => {
      socket.setEncoding?.('utf8');
      socket.on('data', onData);
      socket.on('error', (e) => fail(`smtp_socket: ${e?.message ?? e}`));
      socket.on('close', () => { if (!settled) fail('smtp_closed_early'); });
    };

    const doAuth = (ehloLines) => {
      const caps = ehloLines.join(' ').toUpperCase();
      if (!user || !pass) return sendEnvelope();
      if (caps.includes('AUTH') && caps.includes('PLAIN')) {
        const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
        write(`AUTH PLAIN ${token}`);
        return expect([235], () => sendEnvelope());
      }
      write('AUTH LOGIN');
      expect([334], () => {
        write(Buffer.from(user, 'utf8').toString('base64'));
        expect([334], () => {
          write(Buffer.from(pass, 'utf8').toString('base64'));
          expect([235], () => sendEnvelope());
        });
      });
    };

    const sendEnvelope = () => {
      write(`MAIL FROM:<${parseAddress(msg.from).email}>`);
      expect([250], () => {
        write(`RCPT TO:<${parseAddress(msg.to).email}>`);
        expect([250, 251], () => {
          write('DATA');
          expect([354], () => {
            socket.write(`${buildMimeMessage(msg)}\r\n.\r\n`);
            expect([250], () => {
              write('QUIT');
              clearTimeout(timer);
              finish({ ok: true, provider: 'smtp' });
            });
          });
        });
      });
    };

    const greet = () => {
      write(`EHLO ${env('SMTP_EHLO', 'localhost')}`);
      expect([250], (lines) => {
        const caps = lines.join(' ').toUpperCase();
        if (!upgraded && caps.includes('STARTTLS')) {
          write('STARTTLS');
          return expect([220], () => {
            socket.removeListener('data', onData);
            const plain = socket;
            socket = tls.connect({ socket: plain, servername: host });
            upgraded = true;
            attach();
            socket.once('secureConnect', () => greet());
          });
        }
        doAuth(lines);
      });
    };

    attach();
    expect([220], () => greet());
  });
}

// --- WhatsApp owner alerts ------------------------------------------------

/**
 * Send a WhatsApp message via Meta Cloud API using platform credentials.
 * Used for owner alerts (a new lead at 23:00 must reach a phone, not a dashboard).
 */
export async function sendPlatformWhatsApp(toPhone, text) {
  const token = env('WHATSAPP_TOKEN') || env('WHATSAPP_ACCESS_TOKEN');
  const phoneId = env('WHATSAPP_PHONE_ID') || env('WHATSAPP_PHONE_NUMBER_ID');
  const to = String(toPhone ?? '').replace(/[^\d]/g, '');
  if (!token || !phoneId) return { ok: false, error: 'whatsapp_not_configured' };
  if (!to) return { ok: false, error: 'invalid_phone' };
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: String(text).slice(0, 4000) } }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (r.ok) return { ok: true };
    return { ok: false, error: `whatsapp_http_${r.status}` };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
