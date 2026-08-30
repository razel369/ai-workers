// Browser-owner authentication for the self-serve UI.
//
// API keys remain supported for programmatic clients, but the browser receives
// only an opaque HttpOnly session cookie. Recovery codes are shown once and
// stored as hashes so losing browser storage does not strand a paying tenant.

import crypto from 'node:crypto';

const COOKIE_NAME = 'aiw_owner_session';
const configuredSessionTtlDays = Number(process.env.OWNER_SESSION_TTL_DAYS ?? 30);
const SESSION_TTL_DAYS = Number.isFinite(configuredSessionTtlDays)
  ? Math.max(1, Math.min(Math.trunc(configuredSessionTtlDays), 365))
  : 30;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const nowIso = () => new Date().toISOString();

export function normalizeOwnerEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length < 5 || email.length > 160) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function parseCookies(header = '') {
  const out = new Map();
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!name) continue;
    try { out.set(name, decodeURIComponent(raw)); }
    catch { out.set(name, raw); }
  }
  return out;
}

function makeSecret(prefix, bytes = 32) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
  catch { return false; }
}

export function initOwnerSessions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_accounts (
      tenant_id TEXT PRIMARY KEY,
      business_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      recovery_hash TEXT NOT NULL,
      recovery_rotated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_sessions (
      token_hash TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_owner_sessions_tenant ON owner_sessions(tenant_id, revoked_at, expires_at);
    CREATE INDEX IF NOT EXISTS idx_owner_sessions_expiry ON owner_sessions(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_accounts_email ON tenant_accounts(email);
  `);
}

export function findOwnerAccountByEmail(db, email) {
  const normalized = normalizeOwnerEmail(email);
  if (!normalized) return null;
  return db.prepare(
    `SELECT tenant_id AS tenantId, business_name AS businessName, email,
            recovery_hash AS recoveryHash, created_at AS createdAt, updated_at AS updatedAt
       FROM tenant_accounts WHERE email = ?`
  ).get(normalized) ?? null;
}

export function getOwnerAccount(db, tenantId) {
  return db.prepare(
    `SELECT tenant_id AS tenantId, business_name AS businessName, email,
            created_at AS createdAt, updated_at AS updatedAt
       FROM tenant_accounts WHERE tenant_id = ?`
  ).get(String(tenantId ?? '')) ?? null;
}

export function createOwnerAccount(db, { tenantId, businessName, email }) {
  const normalized = normalizeOwnerEmail(email);
  if (!normalized) return { ok: false, error: 'valid_email_required' };
  if (!tenantId) return { ok: false, error: 'tenant_required' };
  if (findOwnerAccountByEmail(db, normalized)) return { ok: false, error: 'account_exists' };

  const recoveryCode = makeSecret('rcv', 24);
  const now = nowIso();
  try {
    db.prepare(
      `INSERT INTO tenant_accounts
        (tenant_id, business_name, email, recovery_hash, recovery_rotated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      String(tenantId),
      String(businessName ?? '').trim().slice(0, 80) || 'העסק שלי',
      normalized,
      sha256(recoveryCode),
      now,
      now,
      now,
    );
  } catch (error) {
    if (/unique/i.test(String(error?.message ?? ''))) return { ok: false, error: 'account_exists' };
    throw error;
  }
  return { ok: true, recoveryCode, email: normalized };
}

export function issueOwnerSession(db, tenantId) {
  try {
    db.prepare(`DELETE FROM owner_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL`).run(nowIso());
  } catch {}
  const token = makeSecret('ows', 32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000);
  db.prepare(
    `INSERT INTO owner_sessions (token_hash, tenant_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sha256(token), String(tenantId), now.toISOString(), expires.toISOString(), now.toISOString());
  return { token, tenantId: String(tenantId), expiresAt: expires.toISOString(), maxAge: SESSION_TTL_DAYS * 86_400 };
}

export function ownerSessionCookie(session, { secure = false } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(session.token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${session.maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearOwnerSessionCookie({ secure = false } = {}) {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function authenticateOwnerSession(db, req, { requireCsrf = false } = {}) {
  const token = parseCookies(req?.headers?.cookie ?? '').get(COOKIE_NAME) ?? '';
  if (!token.startsWith('ows_')) return { ok: false, error: 'session_missing' };
  if (requireCsrf && String(req?.headers?.['x-aiw-csrf'] ?? '') !== '1') {
    return { ok: false, error: 'csrf_required' };
  }
  const row = db.prepare(
    `SELECT token_hash AS tokenHash, tenant_id AS tenantId, expires_at AS expiresAt, revoked_at AS revokedAt
       FROM owner_sessions WHERE token_hash = ?`
  ).get(sha256(token));
  if (!row || row.revokedAt) return { ok: false, error: 'session_invalid' };
  if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, error: 'session_expired' };
  try {
    db.prepare('UPDATE owner_sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), row.tokenHash);
  } catch {}
  return { ok: true, tenantId: row.tenantId, tokenHash: row.tokenHash, expiresAt: row.expiresAt };
}

export function revokeOwnerSession(db, req) {
  const token = parseCookies(req?.headers?.cookie ?? '').get(COOKIE_NAME) ?? '';
  if (!token.startsWith('ows_')) return { ok: true, revoked: false };
  const result = db.prepare(
    `UPDATE owner_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`
  ).run(nowIso(), sha256(token));
  return { ok: true, revoked: Number(result?.changes ?? 0) > 0 };
}

export function recoverOwnerAccount(db, { email, recoveryCode }) {
  const account = findOwnerAccountByEmail(db, email);
  const suppliedHash = sha256(String(recoveryCode ?? '').trim());
  if (!account || !String(recoveryCode ?? '').startsWith('rcv_') || !safeEqualHex(account.recoveryHash, suppliedHash)) {
    return { ok: false, error: 'invalid_recovery' };
  }

  const nextRecoveryCode = makeSecret('rcv', 24);
  const now = nowIso();
  db.prepare(
    `UPDATE tenant_accounts
        SET recovery_hash = ?, recovery_rotated_at = ?, updated_at = ?
      WHERE tenant_id = ?`
  ).run(sha256(nextRecoveryCode), now, now, account.tenantId);
  db.prepare(
    `UPDATE owner_sessions SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL`
  ).run(now, account.tenantId);
  return {
    ok: true,
    tenantId: account.tenantId,
    businessName: account.businessName,
    email: account.email,
    recoveryCode: nextRecoveryCode,
  };
}

export const ownerSessionCookieName = COOKIE_NAME;
