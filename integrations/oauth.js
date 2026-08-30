// OAuth connect flows — tokens stored encrypted per tenant; users never paste API keys.

import crypto from 'node:crypto';
import { buildOAuthReturnUrl, normalizeOAuthReturnPath } from '../url-security.js';
import { connectIntegration } from './store.js';
import { OAUTH_PROVIDERS } from './auth-providers.js';
import { normalizeShopifyShopHost } from './registry.js';

let _db = null;
let _publicBaseUrl = '';
let _newId = null;

const STATE_TTL_MS = 15 * 60 * 1000;

export function initOAuth(deps) {
  _db = deps.db;
  _publicBaseUrl = (deps.publicBaseUrl || 'http://localhost:8765').replace(/\/$/, '');
  _newId = deps.newId ?? ((p) => `${p}_${crypto.randomBytes(12).toString('hex')}`);
  ensureSchema();
}

function ensureSchema() {
  if (!_db) return;
  _db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      integration_type TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      session_token_hash TEXT NOT NULL,
      return_path TEXT NOT NULL DEFAULT '/marketplace',
      extra_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
  `);
  // Existing installations may have OAuth states from before owner sessions
  // were introduced. They remain unbound and are therefore deliberately
  // unusable; only newly-created, session-bound states can be consumed.
  try { _db.exec(`ALTER TABLE oauth_states ADD COLUMN session_token_hash TEXT`); } catch {}
  try { _db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_states_session ON oauth_states(tenant_id, session_token_hash, expires_at)`); } catch {}
}

export function providerForType(integrationType) {
  for (const provider of Object.values(OAUTH_PROVIDERS)) {
    if (provider.forTypes.includes(integrationType)) return provider;
  }
  return null;
}

export function isOAuthConfigured(provider) {
  if (!provider) return false;
  return !!(provider.clientId?.() && provider.clientSecret?.());
}

export function oauthAvailability(integrationType) {
  const provider = providerForType(integrationType);
  if (!provider) return { available: false, reason: 'no_oauth_provider' };
  if (!isOAuthConfigured(provider)) {
    return { available: false, reason: 'oauth_not_configured', connectLabelHe: provider.connectLabelHe };
  }
  return { available: true, providerId: provider.id, connectLabelHe: provider.connectLabelHe };
}

function cleanupExpiredStates() {
  if (!_db) return;
  _db.prepare(`DELETE FROM oauth_states WHERE expires_at < ?`).run(new Date().toISOString());
}

export function createOAuthStart(tenantId, {
  type,
  returnPath = '/marketplace',
  extra = {},
  sessionTokenHash,
}) {
  const boundSessionHash = String(sessionTokenHash ?? '').toLowerCase();
  if (!tenantId || !/^[a-f0-9]{64}$/.test(boundSessionHash)) {
    return { ok: false, error: 'owner_session_required' };
  }
  const safeReturnPath = normalizeOAuthReturnPath(returnPath);
  if (!safeReturnPath) {
    return { ok: false, error: 'invalid_return_path', messageHe: 'נתיב החזרה לחיבור אינו תקין.' };
  }
  const provider = providerForType(type);
  if (!provider) return { ok: false, error: 'oauth_not_supported', type };
  if (!isOAuthConfigured(provider)) {
    return { ok: false, error: 'oauth_not_configured', messageHe: 'חיבור OAuth לא מוגדר בשרת — פנה למנהל המערכת או השתמש בחיבור קישור.' };
  }

  const normalizedExtra = extra && typeof extra === 'object' && !Array.isArray(extra) ? { ...extra } : {};
  if (provider.id === 'shopify') {
    if (!normalizedExtra.shop) {
      return { ok: false, error: 'shop_required', messageHe: 'הכנס שם חנות Shopify (לדוגמה: mystore.myshopify.com)' };
    }
    const shop = normalizeShopifyShopHost(normalizedExtra.shop);
    if (!shop) {
      return { ok: false, error: 'invalid_shop_domain', messageHe: 'יש להזין דומיין Shopify תקין שמסתיים ב־myshopify.com.' };
    }
    normalizedExtra.shop = shop;
  }

  cleanupExpiredStates();
  const state = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + STATE_TTL_MS).toISOString();
  _db.prepare(`INSERT INTO oauth_states
      (state, tenant_id, integration_type, provider_id, session_token_hash, return_path, extra_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    state,
    tenantId,
    type,
    provider.id,
    boundSessionHash,
    safeReturnPath,
    JSON.stringify(normalizedExtra),
    now.toISOString(),
    expiresAt,
  );

  const redirectUri = `${_publicBaseUrl}/api/integrations/oauth/callback`;
  const clientId = provider.clientId();
  let authorizeUrl;

  if (provider.id === 'shopify') {
    authorizeUrl = provider.buildAuthUrl({
      shop: normalizedExtra.shop,
      redirectUri,
      state,
      clientId,
      scopes: provider.scopes,
    });
  } else {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: provider.scopes.join(' '),
      state,
      ...(provider.extraAuthParams ?? {}),
    });
    authorizeUrl = `${provider.authorizeUrl}?${params.toString()}`;
  }

  return { ok: true, redirectUrl: authorizeUrl, state };
}

function consumeBoundState(state, tenantId, sessionTokenHash) {
  cleanupExpiredStates();
  const boundSessionHash = String(sessionTokenHash ?? '').toLowerCase();
  if (!state || String(state).length > 200 || !tenantId || !/^[a-f0-9]{64}$/.test(boundSessionHash)) return null;
  // DELETE ... RETURNING is a single SQLite statement. Exactly one callback
  // with the initiating live session can claim the state; replay and
  // concurrent callbacks see no row before any provider credential exchange.
  const row = _db.prepare(`
    DELETE FROM oauth_states
     WHERE state = ?
       AND tenant_id = ?
       AND session_token_hash = ?
       AND expires_at > ?
    RETURNING *
  `).get(String(state), String(tenantId), boundSessionHash, new Date().toISOString());
  if (!row) return null;
  let extra = {};
  try { extra = JSON.parse(row.extra_json || '{}'); } catch {}
  return { ...row, extra };
}

async function exchangeCode(provider, code, extra = {}) {
  const redirectUri = `${_publicBaseUrl}/api/integrations/oauth/callback`;
  const clientId = provider.clientId();
  const clientSecret = provider.clientSecret();

  let tokenUrl = provider.tokenUrl;
  let body;

  if (provider.id === 'shopify') {
    const host = normalizeShopifyShopHost(extra.shop);
    if (!host) return { ok: false, error: 'invalid_shop_domain' };
    tokenUrl = `https://${host}/admin/oauth/access_token`;
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: 'token_exchange_failed', status: r.status, details: JSON.stringify(data).slice(0, 200) };
    }
    return { ok: true, tokens: data };
  }

  {
    body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    });
  }

  const r = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { ok: false, error: 'token_exchange_failed', status: r.status, details: JSON.stringify(data).slice(0, 200) };
  }
  return { ok: true, tokens: data };
}

async function fetchGoogleProfile(accessToken) {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return {};
    return await r.json();
  } catch {
    return {};
  }
}

export async function handleOAuthCallback({ code, state, error, tenantId, sessionTokenHash }) {
  if (!state) return { ok: false, error: 'missing_state' };
  if (!tenantId || !/^[a-f0-9]{64}$/i.test(String(sessionTokenHash ?? ''))) {
    return { ok: false, error: 'owner_session_required', messageHe: 'יש להתחבר מחדש לחשבון העסק.' };
  }

  const row = consumeBoundState(state, tenantId, sessionTokenHash);
  if (!row) return { ok: false, error: 'invalid_or_expired_state', messageHe: 'פג תוקף החיבור — נסה שוב.' };
  if (error) {
    return { ok: false, error: 'oauth_denied', messageHe: 'החיבור בוטל או נדחה.' };
  }
  if (!code) return { ok: false, error: 'missing_code' };

  const provider = OAUTH_PROVIDERS[row.provider_id];
  if (!provider) return { ok: false, error: 'unknown_provider' };

  if (provider.id === 'shopify') {
    const shop = normalizeShopifyShopHost(row.extra?.shop);
    if (!shop) {
      return { ok: false, error: 'invalid_shop_domain', messageHe: 'דומיין Shopify אינו תקין — התחילו את החיבור מחדש.' };
    }
    row.extra = { ...row.extra, shop };
  }

  const exchanged = await exchangeCode(provider, code, row.extra);
  if (!exchanged.ok) {
    return { ok: false, error: exchanged.error, messageHe: 'לא הצלחנו להשלים את החיבור — נסה שוב.' };
  }

  let profile = {};
  if (provider.id === 'google') {
    profile = await fetchGoogleProfile(exchanged.tokens.access_token);
  }

  const config = provider.mapConfig(exchanged.tokens, profile, row.extra);
  const result = connectIntegration(row.tenant_id, {
    type: row.integration_type,
    label: provider.connectLabelHe,
    config,
    meta: { oauthProvider: provider.id, connectedVia: 'oauth' },
  });

  if (!result.ok) {
    return { ok: false, error: result.error, messageHe: 'שגיאה בשמירת החיבור.' };
  }

  const returnPath = row.return_path || '/marketplace';
  const redirectTo = buildOAuthReturnUrl(returnPath, `oauth=success&type=${encodeURIComponent(row.integration_type)}`);

  return { ok: true, redirectTo, integrationId: result.id, type: row.integration_type };
}

export function generateWebhookConfig(tenantId, baseUrl = _publicBaseUrl) {
  const secret = crypto.randomBytes(16).toString('hex');
  const hookId = _newId ? _newId('hook') : `hook_${crypto.randomBytes(8).toString('hex')}`;
  const root = (baseUrl || _publicBaseUrl || 'http://localhost:8765').replace(/\/$/, '');
  const hookUrl = `${root}/api/hooks/${encodeURIComponent(tenantId)}/${secret}`;
  return {
    mode: 'inbound',
    hookId,
    hookUrl,
    secret,
    authMethod: 'generated',
  };
}

export function connectWithUserFields(tenantId, type, userConfig = {}, opts = {}) {
  const baseUrl = opts.baseUrl;
  const clean = {};
  for (const [k, v] of Object.entries(userConfig)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') clean[k] = String(v).trim();
  }

  if (type === 'webhook' && !clean.url && !clean.hookUrl) {
    const generated = generateWebhookConfig(tenantId, baseUrl);
    return connectIntegration(tenantId, {
      type,
      label: 'Webhook יוצא',
      config: generated,
      meta: { connectedVia: 'generated' },
    });
  }

  if (type === 'google_calendar' && clean.bookingLink && !clean.apiKey) {
    clean.mode = 'link';
    clean.authMethod = 'link';
  }

  if (type === 'whatsapp' && clean.ownerNotifyPhone) {
    clean.provider = clean.provider || 'meta';
    clean.authMethod = 'phone';
  }

  return connectIntegration(tenantId, {
    type,
    config: clean,
    meta: { connectedVia: 'user_fields' },
  });
}
