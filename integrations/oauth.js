// OAuth connect flows — tokens stored encrypted per tenant; users never paste API keys.

import crypto from 'node:crypto';
import { connectIntegration } from './store.js';
import { OAUTH_PROVIDERS } from './auth-providers.js';

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
      return_path TEXT NOT NULL DEFAULT '/marketplace',
      extra_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
  `);
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

export function createOAuthStart(tenantId, { type, returnPath = '/marketplace', extra = {} }) {
  const provider = providerForType(type);
  if (!provider) return { ok: false, error: 'oauth_not_supported', type };
  if (!isOAuthConfigured(provider)) {
    return { ok: false, error: 'oauth_not_configured', messageHe: 'חיבור OAuth לא מוגדר בשרת — פנה למנהל המערכת או השתמש בחיבור קישור.' };
  }

  cleanupExpiredStates();
  const state = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + STATE_TTL_MS).toISOString();
  _db.prepare(`INSERT INTO oauth_states (state, tenant_id, integration_type, provider_id, return_path, extra_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    state, tenantId, type, provider.id, returnPath, JSON.stringify(extra ?? {}), now.toISOString(), expiresAt
  );

  const redirectUri = `${_publicBaseUrl}/api/integrations/oauth/callback`;
  const clientId = provider.clientId();
  let authorizeUrl;

  if (provider.id === 'shopify') {
    const shop = extra.shop;
    if (!shop) return { ok: false, error: 'shop_required', messageHe: 'הכנס שם חנות Shopify (לדוגמה: mystore.myshopify.com)' };
    authorizeUrl = provider.buildAuthUrl({
      shop,
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

function loadState(state) {
  cleanupExpiredStates();
  const row = _db.prepare(`SELECT * FROM oauth_states WHERE state = ?`).get(state);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    _db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);
    return null;
  }
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
    const host = String(extra.shop || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!host) throw new Error('shop_required');
    tokenUrl = `https://${host}/admin/oauth/access_token`;
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
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

export async function handleOAuthCallback({ code, state, error }) {
  if (error) {
    return { ok: false, error: 'oauth_denied', messageHe: 'החיבור בוטל או נדחה.' };
  }
  if (!code || !state) return { ok: false, error: 'missing_code_or_state' };

  const row = loadState(state);
  if (!row) return { ok: false, error: 'invalid_or_expired_state', messageHe: 'פג תוקף החיבור — נסה שוב.' };

  const provider = OAUTH_PROVIDERS[row.provider_id];
  if (!provider) return { ok: false, error: 'unknown_provider' };

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

  _db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);

  if (!result.ok) {
    return { ok: false, error: result.error, messageHe: 'שגיאה בשמירת החיבור.' };
  }

  const returnPath = row.return_path || '/marketplace';
  const sep = returnPath.includes('?') ? '&' : (returnPath.includes('#') ? '?' : '?');
  const redirectTo = `${returnPath}${sep}oauth=success&type=${encodeURIComponent(row.integration_type)}`;

  return { ok: true, redirectTo, integrationId: result.id, type: row.integration_type };
}

export function generateWebhookConfig(tenantId) {
  const secret = crypto.randomBytes(16).toString('hex');
  const hookId = _newId ? _newId('hook') : `hook_${crypto.randomBytes(8).toString('hex')}`;
  const hookUrl = `${_publicBaseUrl}/api/hooks/${encodeURIComponent(tenantId)}/${secret}`;
  return {
    mode: 'inbound',
    hookId,
    hookUrl,
    secret,
    authMethod: 'generated',
  };
}

export function connectWithUserFields(tenantId, type, userConfig = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(userConfig)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') clean[k] = String(v).trim();
  }

  if (type === 'webhook' && !clean.url && !clean.hookUrl) {
    const generated = generateWebhookConfig(tenantId);
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
