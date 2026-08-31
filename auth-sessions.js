// Passwordless session auth for the business owner's hub.
//
// Until now the only credential was an API key (`sk_...`) kept in localStorage
// and displayed in the UI. That is a reasonable developer credential and a poor
// login for a dentist:
//
//   - localStorage is readable by any XSS, and the app renders customer-written
//     content (lead notes, chat transcripts). One injection = permanent, total
//     tenant compromise.
//   - The key never expires, so it stays valid forever on a shared clinic PC.
//   - Revoking it logs out every device *and* the embed widget at once.
//   - Nothing records who opened the account, which the DPA promises tenants.
//
// So humans get sessions and machines keep keys. Login is passwordless — a
// magic link by email or a 6-digit code by WhatsApp — because a business owner
// will not invent, remember, or safely store another password. The session
// itself lives in an httpOnly, Secure, SameSite=Lax cookie the page's own
// JavaScript cannot read.
//
// ENV:
//   SESSION_TTL_DAYS=30
//   MAGIC_LINK_TTL_MINUTES=15
//   AUTH_MAX_REQUESTS_PER_HOUR=5
//   SESSION_COOKIE_NAME=aiw_session

import crypto from 'node:crypto';
import * as registry from './tenant-registry.js';
import * as notify from './notify.js';

const env = (k, d = '') => (process.env[k] ?? d).trim();

const SESSION_TTL_DAYS = Math.max(1, Number(env('SESSION_TTL_DAYS', '30')));
const MAGIC_TTL_MIN = Math.max(1, Number(env('MAGIC_LINK_TTL_MINUTES', '15')));
const MAX_REQ_PER_HOUR = Math.max(1, Number(env('AUTH_MAX_REQUESTS_PER_HOUR', '5')));
const COOKIE_NAME = env('SESSION_COOKIE_NAME', 'aiw_session');
const CSRF_COOKIE = `${COOKIE_NAME}_csrf`;

const DAY_MS = 86_400_000;

let db = null;
let publicBaseUrl = '';

export function initAuthSessions({ database, baseUrl }) {
  db = database;
  publicBaseUrl = String(baseUrl ?? '').replace(/\/$/, '');
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_challenges (
      token_hash TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      destination TEXT NOT NULL,
      code_hash TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      request_ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auth_challenges_tenant ON auth_challenges(tenant_id, created_at);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      session_hash TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      user_agent TEXT,
      ip TEXT,
      label TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_tenant ON auth_sessions(tenant_id, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_hash ON auth_sessions(session_hash);

    CREATE TABLE IF NOT EXISTS auth_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      tenant_id TEXT,
      event TEXT NOT NULL,
      channel TEXT,
      destination TEXT,
      ip TEXT,
      user_agent TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auth_events_tenant ON auth_events(tenant_id, at);
  `);
  return db;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

/** Mask a destination in logs and responses — never echo a full address back. */
export function maskDestination(value) {
  const v = String(value ?? '');
  if (v.includes('@')) {
    const [user, domain] = v.split('@');
    return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
  }
  return v.length > 4 ? `${'*'.repeat(v.length - 4)}${v.slice(-4)}` : '****';
}

function logEvent({ tenantId, event, channel, destination, ip, userAgent, detail }) {
  try {
    db.prepare(`INSERT INTO auth_events (at, tenant_id, event, channel, destination, ip, user_agent, detail)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(new Date().toISOString(), tenantId ?? null, event, channel ?? null,
        destination ? maskDestination(destination) : null, ip ?? null,
        String(userAgent ?? '').slice(0, 200), detail ? String(detail).slice(0, 300) : null);
  } catch {}
}

// --- Cookies --------------------------------------------------------------

export function parseCookies(req) {
  const raw = req.headers?.cookie ?? '';
  const out = {};
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecureRequest(req) {
  if (publicBaseUrl.startsWith('https://')) return true;
  const proto = req.headers?.['x-forwarded-proto'];
  return String(proto ?? '').split(',')[0].trim() === 'https';
}

function cookie(name, value, { maxAgeSec, req, httpOnly = true }) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    // Lax still sends the cookie on the top-level GET that follows a magic
    // link, while blocking it on cross-site POSTs.
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  if (httpOnly) bits.push('HttpOnly');
  if (isSecureRequest(req)) bits.push('Secure');
  return bits.join('; ');
}

export function sessionCookieHeaders(req, { sessionToken, csrfToken }) {
  const maxAge = SESSION_TTL_DAYS * 86_400;
  return {
    'set-cookie': [
      cookie(COOKIE_NAME, sessionToken, { maxAgeSec: maxAge, req, httpOnly: true }),
      // Readable by the page on purpose: it must be echoed back in a header.
      cookie(CSRF_COOKIE, csrfToken, { maxAgeSec: maxAge, req, httpOnly: false }),
    ],
  };
}

export function clearCookieHeaders(req) {
  return {
    'set-cookie': [
      cookie(COOKIE_NAME, '', { maxAgeSec: 0, req, httpOnly: true }),
      cookie(CSRF_COOKIE, '', { maxAgeSec: 0, req, httpOnly: false }),
    ],
  };
}

// --- Rate limiting --------------------------------------------------------

function tooManyRequests({ destination, ip }) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  try {
    const byDest = db.prepare(
      `SELECT COUNT(*) AS c FROM auth_challenges WHERE destination = ? AND created_at >= ?`
    ).get(destination, since)?.c ?? 0;
    const byIp = db.prepare(
      `SELECT COUNT(*) AS c FROM auth_challenges WHERE request_ip = ? AND created_at >= ?`
    ).get(ip ?? '', since)?.c ?? 0;
    return byDest >= MAX_REQ_PER_HOUR || byIp >= MAX_REQ_PER_HOUR * 3;
  } catch {
    return false;
  }
}

// --- Login: request a challenge ------------------------------------------

/**
 * Find the tenant that owns a contact address.
 * Deliberately silent about misses: the caller always reports success so this
 * endpoint cannot be used to discover which businesses are customers.
 */
function findTenantByDestination(destination) {
  const value = String(destination ?? '').trim();
  if (!value) return null;
  const isEmail = value.includes('@');
  const normalised = isEmail ? value.toLowerCase() : registry.normalisePhone(value);
  if (!normalised) return null;
  for (const t of registry.listTenants()) {
    if (isEmail && String(t.contactEmail ?? '').toLowerCase() === normalised) return t;
    if (!isEmail && registry.normalisePhone(t.contactPhone) === normalised) return t;
  }
  return null;
}

/**
 * Issue a magic link (email) or a 6-digit code (WhatsApp).
 * Always resolves the same way to the caller — see findTenantByDestination.
 */
export async function requestLogin({ destination, ip, userAgent }) {
  if (!db) return { ok: false, error: 'auth_not_initialised' };
  const value = String(destination ?? '').trim();
  if (!value) return { ok: false, error: 'destination_required' };

  const isEmail = value.includes('@');
  const channel = isEmail ? 'email' : 'whatsapp';
  const normalised = isEmail ? value.toLowerCase() : registry.normalisePhone(value);

  if (tooManyRequests({ destination: normalised, ip })) {
    logEvent({ event: 'login_rate_limited', channel, destination: normalised, ip, userAgent });
    return { ok: true, sent: true, throttled: true };
  }

  const tenant = findTenantByDestination(value);
  if (!tenant) {
    // Record the attempt (so the rate limiter still counts it) but send nothing.
    try {
      db.prepare(`INSERT INTO auth_challenges
        (token_hash, tenant_id, channel, destination, created_at, expires_at, request_ip)
        VALUES (?,?,?,?,?,?,?)`)
        .run(sha256(newToken()), '', channel, normalised, new Date().toISOString(),
          new Date(Date.now() + MAGIC_TTL_MIN * 60_000).toISOString(), ip ?? '');
    } catch {}
    logEvent({ event: 'login_unknown_destination', channel, destination: normalised, ip, userAgent });
    return { ok: true, sent: true };
  }

  const token = newToken();
  const code = String(crypto.randomInt(100_000, 1_000_000));
  const now = new Date();
  const expires = new Date(now.getTime() + MAGIC_TTL_MIN * 60_000);

  db.prepare(`INSERT INTO auth_challenges
    (token_hash, tenant_id, channel, destination, code_hash, created_at, expires_at, request_ip)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(sha256(token), tenant.tenantId, channel, normalised, sha256(code),
      now.toISOString(), expires.toISOString(), ip ?? '');

  const link = `${publicBaseUrl}/app/login?t=${encodeURIComponent(token)}`;
  const businessName = tenant.businessName || 'העסק שלך';

  if (channel === 'email') {
    notify.queueNotification({
      channel: 'email', recipient: normalised,
      subject: `כניסה לחשבון — ${businessName}`,
      html: notify.renderEmail({
        title: 'כניסה לחשבון',
        intro: `שלום ${businessName}, לחצו על הכפתור כדי להיכנס. הקישור תקף ל-${MAGIC_TTL_MIN} דקות ולשימוש אחד בלבד.`,
        bodyHtml: `אפשר גם להזין את הקוד הזה במסך הכניסה:<br><br>
          <span style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</span>`,
        ctaText: 'כניסה לחשבון',
        ctaUrl: link,
        footerNote: 'לא ביקשתם להיכנס? אפשר להתעלם מההודעה — בלי לחיצה לא קורה כלום.',
      }),
      kind: 'auth', tenantId: tenant.tenantId,
    });
  } else {
    notify.queueNotification({
      channel: 'whatsapp', recipient: normalised,
      subject: 'קוד כניסה',
      text: `קוד הכניסה שלך: ${code}\nתקף ל-${MAGIC_TTL_MIN} דקות.\n\nאו הקישור: ${link}`,
      kind: 'auth', tenantId: tenant.tenantId,
    });
  }
  notify.flushOutbox({ limit: 3 }).catch(() => {});
  logEvent({ tenantId: tenant.tenantId, event: 'login_requested', channel, destination: normalised, ip, userAgent });
  return { ok: true, sent: true, channel };
}

// --- Login: redeem a challenge -------------------------------------------

function consumeChallenge(row) {
  db.prepare(`UPDATE auth_challenges SET consumed_at = ? WHERE token_hash = ?`)
    .run(new Date().toISOString(), row.token_hash);
}

function startSession({ tenantId, ip, userAgent }) {
  const sessionToken = newToken();
  const csrfToken = newToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_DAYS * DAY_MS);
  const id = `ses_${crypto.randomBytes(12).toString('hex')}`;
  db.prepare(`INSERT INTO auth_sessions
    (id, session_hash, tenant_id, created_at, last_seen_at, expires_at, user_agent, ip)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, sha256(sessionToken), tenantId, now.toISOString(), now.toISOString(),
      expires.toISOString(), String(userAgent ?? '').slice(0, 200), ip ?? '');
  return { id, sessionToken, csrfToken, expiresAt: expires.toISOString() };
}

/** Redeem a magic-link token. Single use: consumed whether or not it was valid. */
export function redeemToken({ token, ip, userAgent }) {
  if (!db || !token) return { ok: false, error: 'invalid_token' };
  const row = db.prepare(`SELECT * FROM auth_challenges WHERE token_hash = ?`).get(sha256(token));
  if (!row || !row.tenant_id) {
    logEvent({ event: 'login_failed', ip, userAgent, detail: 'unknown token' });
    return { ok: false, error: 'invalid_token' };
  }
  if (row.consumed_at) {
    logEvent({ tenantId: row.tenant_id, event: 'login_failed', ip, userAgent, detail: 'token reused' });
    return { ok: false, error: 'token_already_used' };
  }
  if (new Date(row.expires_at) < new Date()) {
    logEvent({ tenantId: row.tenant_id, event: 'login_failed', ip, userAgent, detail: 'token expired' });
    return { ok: false, error: 'token_expired' };
  }
  consumeChallenge(row);
  const session = startSession({ tenantId: row.tenant_id, ip, userAgent });
  logEvent({ tenantId: row.tenant_id, event: 'login_success', channel: row.channel, destination: row.destination, ip, userAgent });
  return { ok: true, tenantId: row.tenant_id, ...session };
}

/** Redeem a 6-digit code. Capped attempts so the code cannot be brute-forced. */
export function redeemCode({ destination, code, ip, userAgent }) {
  if (!db) return { ok: false, error: 'auth_not_initialised' };
  const value = String(destination ?? '').trim();
  const normalised = value.includes('@') ? value.toLowerCase() : registry.normalisePhone(value);
  const row = db.prepare(`SELECT * FROM auth_challenges
    WHERE destination = ? AND consumed_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1`).get(normalised, new Date().toISOString());
  if (!row || !row.tenant_id) return { ok: false, error: 'invalid_code' };

  if (row.attempts >= 5) {
    consumeChallenge(row);
    logEvent({ tenantId: row.tenant_id, event: 'login_failed', ip, userAgent, detail: 'too many code attempts' });
    return { ok: false, error: 'too_many_attempts' };
  }
  db.prepare(`UPDATE auth_challenges SET attempts = attempts + 1 WHERE token_hash = ?`).run(row.token_hash);

  const provided = sha256(String(code ?? '').trim());
  const expected = String(row.code_hash ?? '');
  const match = provided.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!match) {
    logEvent({ tenantId: row.tenant_id, event: 'login_failed', ip, userAgent, detail: 'wrong code' });
    return { ok: false, error: 'invalid_code' };
  }
  consumeChallenge(row);
  const session = startSession({ tenantId: row.tenant_id, ip, userAgent });
  logEvent({ tenantId: row.tenant_id, event: 'login_success', channel: row.channel, destination: row.destination, ip, userAgent });
  return { ok: true, tenantId: row.tenant_id, ...session };
}

// --- Session validation ---------------------------------------------------

/**
 * Resolve the tenant for a request's session cookie, or null.
 * Sliding expiry: every authenticated request pushes the window out, so an
 * active owner is never logged out mid-task while an abandoned session on a
 * shared machine still ages out.
 */
export function sessionFromRequest(req) {
  if (!db) return null;
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const row = db.prepare(`SELECT * FROM auth_sessions WHERE session_hash = ?`).get(sha256(token));
  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_DAYS * DAY_MS);
  try {
    db.prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`)
      .run(now.toISOString(), expires.toISOString(), row.id);
  } catch {}
  return { sessionId: row.id, tenantId: row.tenant_id };
}

/**
 * Double-submit CSRF check for state-changing requests.
 * The session cookie is SameSite=Lax, which already blocks cross-site POSTs in
 * current browsers; this is the belt to that braces and covers older ones.
 */
export function csrfOk(req) {
  const method = String(req.method ?? '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const cookieToken = parseCookies(req)[CSRF_COOKIE] ?? '';
  const headerToken = String(req.headers?.['x-csrf-token'] ?? '');
  if (!cookieToken || !headerToken) return false;
  if (cookieToken.length !== headerToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
}

// --- Session management ---------------------------------------------------

export function listSessions(tenantId, currentSessionId = null) {
  if (!db || !tenantId) return [];
  return db.prepare(`SELECT id, created_at AS createdAt, last_seen_at AS lastSeenAt,
    expires_at AS expiresAt, user_agent AS userAgent, ip
    FROM auth_sessions WHERE tenant_id = ? AND revoked_at IS NULL
    ORDER BY last_seen_at DESC LIMIT 50`).all(tenantId)
    .map((r) => ({ ...r, current: r.id === currentSessionId, device: describeDevice(r.userAgent) }));
}

function describeDevice(ua = '') {
  const s = String(ua);
  const os = /iPhone|iPad/i.test(s) ? 'iPhone/iPad'
    : /Android/i.test(s) ? 'Android'
    : /Mac OS X|Macintosh/i.test(s) ? 'Mac'
    : /Windows/i.test(s) ? 'Windows'
    : /Linux|X11|CrOS/i.test(s) ? 'מחשב'
    : 'מכשיר לא ידוע';
  const browser = /Edg\//i.test(s) ? 'Edge'
    : /Chrome\//i.test(s) ? 'Chrome'
    : /Firefox\//i.test(s) ? 'Firefox'
    : /Safari\//i.test(s) ? 'Safari'
    : '';
  return browser ? `${os} · ${browser}` : os;
}

export function revokeSession(tenantId, sessionId) {
  if (!db || !tenantId || !sessionId) return { ok: false, error: 'ids_required' };
  const r = db.prepare(`UPDATE auth_sessions SET revoked_at = ?
    WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`)
    .run(new Date().toISOString(), sessionId, tenantId);
  if (r.changes) logEvent({ tenantId, event: 'session_revoked', detail: sessionId });
  return { ok: (r.changes ?? 0) > 0 };
}

export function revokeAllSessions(tenantId, { exceptSessionId = null } = {}) {
  if (!db || !tenantId) return { revoked: 0 };
  const now = new Date().toISOString();
  const r = exceptSessionId
    ? db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE tenant_id = ? AND id != ? AND revoked_at IS NULL`).run(now, tenantId, exceptSessionId)
    : db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL`).run(now, tenantId);
  logEvent({ tenantId, event: 'sessions_revoked_all', detail: `${r.changes ?? 0} sessions` });
  return { revoked: r.changes ?? 0 };
}

/** Recent sign-in activity, shown to the owner so an unexpected login is visible. */
export function recentAuthEvents(tenantId, limit = 20) {
  if (!db || !tenantId) return [];
  return db.prepare(`SELECT at, event, channel, destination, ip, user_agent AS userAgent, detail
    FROM auth_events WHERE tenant_id = ? ORDER BY id DESC LIMIT ?`).all(tenantId, Math.min(limit, 100));
}

/** Housekeeping: consumed/expired challenges and dead sessions. */
export function purgeExpiredAuth() {
  if (!db) return { purged: 0 };
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - 90 * DAY_MS).toISOString();
  let purged = 0;
  try {
    purged += db.prepare(`DELETE FROM auth_challenges WHERE expires_at < ? OR consumed_at IS NOT NULL`).run(now).changes ?? 0;
    purged += db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`).run(now, cutoff).changes ?? 0;
    db.prepare(`DELETE FROM auth_events WHERE at < ?`).run(cutoff);
  } catch {}
  return { purged };
}

export function authStatus() {
  const base = {
    sessionTtlDays: SESSION_TTL_DAYS,
    magicLinkTtlMinutes: MAGIC_TTL_MIN,
    maxRequestsPerHour: MAX_REQ_PER_HOUR,
    cookieName: COOKIE_NAME,
  };
  if (!db) return base;
  const active = db.prepare(`SELECT COUNT(*) AS c FROM auth_sessions
    WHERE revoked_at IS NULL AND expires_at > ?`).get(new Date().toISOString())?.c ?? 0;
  return { ...base, activeSessions: active };
}
