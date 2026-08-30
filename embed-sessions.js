// Short-lived, worker-scoped sessions for the public embed widget.
// The browser never receives a tenant API key and never chooses customerId.

import crypto from 'node:crypto';

const configuredTtlMinutes = Number(process.env.EMBED_SESSION_TTL_MINUTES ?? 60);
const TTL_MINUTES = Number.isFinite(configuredTtlMinutes)
  ? Math.max(5, Math.min(Math.trunc(configuredTtlMinutes), 240))
  : 60;
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export function initEmbedSessions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embed_sessions (
      token_hash TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_embed_sessions_worker ON embed_sessions(tenant_id, worker_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_embed_sessions_expiry ON embed_sessions(expires_at);
  `);
}

export function issueEmbedSession(db, { tenantId, workerId, origin }) {
  if (!tenantId || !workerId || !origin) return { ok: false, error: 'session_scope_required' };
  const token = `emb_${crypto.randomBytes(32).toString('base64url')}`;
  const customerId = `web_${crypto.randomBytes(18).toString('base64url')}`;
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MINUTES * 60_000);
  db.prepare(
    `INSERT INTO embed_sessions
      (token_hash, tenant_id, worker_id, customer_id, origin, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sha256(token),
    String(tenantId),
    String(workerId),
    String(customerId),
    String(origin),
    now.toISOString(),
    expires.toISOString(),
    now.toISOString(),
  );
  return { ok: true, token, customerId, expiresAt: expires.toISOString() };
}

export function authenticateEmbedSession(db, req, { origin = '' } = {}) {
  const auth = String(req?.headers?.authorization ?? '');
  const token = auth.startsWith('Embed ') ? auth.slice('Embed '.length).trim() : '';
  if (!token.startsWith('emb_')) return { ok: false, error: 'embed_session_required' };
  const tokenHash = sha256(token);
  const row = db.prepare(
    `SELECT tenant_id AS tenantId, worker_id AS workerId, customer_id AS customerId,
            origin, expires_at AS expiresAt, revoked_at AS revokedAt
       FROM embed_sessions WHERE token_hash = ?`
  ).get(tokenHash);
  if (!row || row.revokedAt) return { ok: false, error: 'embed_session_invalid' };
  if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, error: 'embed_session_expired' };
  if (!origin || origin !== row.origin) return { ok: false, error: 'embed_origin_mismatch' };
  try {
    db.prepare('UPDATE embed_sessions SET last_used_at = ? WHERE token_hash = ?').run(new Date().toISOString(), tokenHash);
  } catch {}
  return { ok: true, ...row, tokenHash };
}

export function pruneEmbedSessions(db) {
  try {
    return db.prepare('DELETE FROM embed_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').run(new Date().toISOString());
  } catch {
    return null;
  }
}
