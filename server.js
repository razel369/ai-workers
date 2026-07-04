// AI Workers — Israeli businesses hire AI employees, not APIs.
//
// Businesses pick a worker template (Lead Qualifier, Hebrew Support, etc.),
// customize it, and deploy it. Workers chat with customers 24/7 on web chat
// (WhatsApp coming soon). Monthly subscription covers all usage and tokens.
//
// ENV:
//   PORT=8765
//   PUBLIC_BASE_URL=https://your.host
//   AGENT_NAME=AI Workers
//   AGENT_OWNER_CONTACT=you@example.com
//
//   -- Server LLM (required for real AI replies) --
//   LLM_API_KEY=sk-...                              # OpenAI / Anthropic API key
//   LLM_PROVIDER=openai_compatible                  # or: anthropic
//   LLM_MODEL=gpt-5.5                               # model name
//   LLM_BASE_URL=https://api.openai.com             # base URL (change for Ollama, Groq, etc.)
//
//   -- Oldschool payment channels (any subset) --
//   PAYPAL_ME=you                                  -> https://paypal.me/you
//   BUY_ME_A_COFFEE=https://buymeacoffee.com/you
//   KO_FI=https://ko-fi.com/you
//   BIT_PHONE=972541234567                         -> shows a Bit payment link
//   GITHUB_SPONSORS=you
//   GUMROAD_URL=https://you.gumroad.com/l/ai-workers
//
//   -- Bank invoice (Israeli-friendly) --
//   PAYEE_NAME=Your Name
//   BANK_NAME=Bank Hapoalim
//   BANK_BRANCH=620
//   BANK_ACCOUNT=123456
//   IBAN=IL62...  (optional, for cross-border)
//   SWIFT=POALILIT  (optional)
//
//   -- Admin (issue API keys, manage workers) --
//   ADMIN_TOKEN=some-long-random-string
//   DB_PATH=./data/earnings.db

import './bootstrap-env.js';
import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as workers from './workers.js';
import * as mcpClient from './mcp-client.js';
import { SKILLS, getSkill, handleLegalRoutes } from './skills.js';
import * as integrations from './integrations/index.js';
import { handleWhatsAppWebhook, whatsappConfigStatus } from './whatsapp-webhook.js';
import { processWhatsAppInbound, registerWhatsAppRoute } from './whatsapp-router.js';
import {
  handlePaymentWebhooks,
  paymentConfigStatus,
  activationSlaTextHe,
  tryAutoVerifyActivationProof,
  autoActivateWorker,
} from './payment-webhooks.js';
import {
  paddleEnabled,
  paddleConfigStatus,
  buildPaddleCheckoutConfig,
  handlePaddleWebhook,
} from './paddle-billing.js';
import { buildEmbedScript } from './embed-widget.js';
import * as urlSecurity from './url-security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8765);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const AGENT_NAME = process.env.AGENT_NAME ?? 'AI Workers';
const AGENT_DESCRIPTION = process.env.AGENT_DESCRIPTION ?? 'AI employees for Israeli businesses.';
const AGENT_OWNER_CONTACT = process.env.AGENT_OWNER_CONTACT ?? '';
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 120);
const SIGNUP_LIMIT_PER_HOUR = Number(process.env.SIGNUP_LIMIT_PER_HOUR ?? 12);
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, 'data', 'earnings.db');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN ?? '';
const ALLOW_PRIVATE_NETWORK_URLS = process.env.ALLOW_PRIVATE_NETWORK_URLS === '1';
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === '1';

// Oldschool channels
const PAYPAL_ME = process.env.PAYPAL_ME ?? '';
const BUY_ME_A_COFFEE = process.env.BUY_ME_A_COFFEE ?? '';
const KO_FI = process.env.KO_FI ?? '';
const BIT_PHONE = process.env.BIT_PHONE ?? '';
const GITHUB_SPONSORS = process.env.GITHUB_SPONSORS ?? '';
const GUMROAD_URL = process.env.GUMROAD_URL ?? '';

// Bank invoice
const PAYEE_NAME = process.env.PAYEE_NAME ?? '';
const BANK_NAME = process.env.BANK_NAME ?? '';
const BANK_BRANCH = process.env.BANK_BRANCH ?? '';
const BANK_ACCOUNT = process.env.BANK_ACCOUNT ?? '';
const IBAN = process.env.IBAN ?? '';
const SWIFT = process.env.SWIFT ?? '';

// Server LLM (not BYOK — the platform provides the AI)
const LLM_API_KEY = process.env.LLM_API_KEY ?? '';
const LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'openai_compatible';
const LLM_MODEL = process.env.LLM_MODEL ?? 'gpt-5.5';
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? '';

// --- Named constants ------------------------------------------------------

const UNLIMITED_CALLS = 999_999_999;
const BODY_TINY = 1024 * 16;
const BODY_SMALL = 1024 * 64;
const BODY_LARGE = 1024 * 256;
const STATS_POLL_MS = 10000;
const TEMPLATE_ANIM_DELAY = 0.08;
const RECENT_CALLS_DEFAULT = 50;
const CSV_EXPORT_LIMIT = 1000;
const ADMIN_KEYS_LIMIT = 200;
const ADMIN_AUDIT_LIMIT = 200;
const ASSETS_CACHE_MAX_AGE = 86400;
const DEFAULT_RENT_DAYS = 30;
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS ?? 0);
const EMBED_ALLOW_PUBLIC = process.env.EMBED_ALLOW_PUBLIC !== '0';
const VERCEL_INLINE_SCRIPT = process.env.VERCEL ? '<script>window.__VERCEL__=true;</script>' : '';
const ANALYTICS_LANDING_SCRIPT = '<script type="module">import{initAnalytics}from"/analytics-client.js";void initAnalytics();</script>';

/** Platform-managed MCP presets — users connect via button, never paste URLs/tokens */
const MCP_PRESETS = {
  filesystem: {
    labelHe: 'קבצים מקומיים',
    descriptionHe: 'גישה לקבצים דרך שרת MCP מנוהל',
    url: process.env.MCP_PRESET_FILESYSTEM_URL || 'https://mcp.example.com/filesystem',
  },
  github: {
    labelHe: 'GitHub',
    descriptionHe: 'כלים מ-GitHub דרך OAuth',
    url: process.env.MCP_PRESET_GITHUB_URL || 'https://api.githubcopilot.com/mcp/',
  },
};

// --- SQLite ---------------------------------------------------------------

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, endpoint TEXT NOT NULL, network TEXT NOT NULL,
    amount_usdc TEXT NOT NULL, payer TEXT NOT NULL, tx_hash TEXT NOT NULL,
    mock INTEGER NOT NULL, input_chars INTEGER NOT NULL DEFAULT 0,
    auth_method TEXT NOT NULL DEFAULT 'x402'
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    tenant_id TEXT,
    plan TEXT NOT NULL, calls_limit INTEGER NOT NULL, calls_used INTEGER NOT NULL DEFAULT 0,
    period_start TEXT NOT NULL, period_end TEXT,
    payment_channel TEXT NOT NULL DEFAULT 'manual',
    payment_reference TEXT,
    created_at TEXT NOT NULL, revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, channel TEXT NOT NULL, amount TEXT,
    note TEXT, donor TEXT
  );
  CREATE TABLE IF NOT EXISTS activation_requests (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    worker_name TEXT NOT NULL,
    template_id TEXT NOT NULL,
    amount_ils INTEGER NOT NULL DEFAULT 0,
    channel TEXT NOT NULL,
    reference TEXT,
    contact TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS admin_audit_events (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    ip TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    status TEXT NOT NULL,
    metadata TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  CREATE INDEX IF NOT EXISTS idx_activation_requests_status ON activation_requests(status, at);
  CREATE INDEX IF NOT EXISTS idx_admin_audit_events_at ON admin_audit_events(at);
  CREATE INDEX IF NOT EXISTS idx_admin_audit_events_action ON admin_audit_events(action, at);
  CREATE TABLE IF NOT EXISTS whatsapp_routes (
    phone_key TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'meta',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_routes_tenant ON whatsapp_routes(tenant_id);
`);
try { db.exec(`ALTER TABLE api_keys ADD COLUMN tenant_id TEXT`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id)`); } catch {}

// --- Helpers --------------------------------------------------------------

const newId = (p) => `${p}_${crypto.randomBytes(16).toString('hex')}`;
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

integrations.initOAuth({ db, publicBaseUrl: PUBLIC_BASE_URL, newId });

// API key validation: check the key exists in the api_keys table (not just any sk_ string)
function requireAuth(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (!token.startsWith('sk_')) return null;
  const check = validateApiKey(token);
  return check.valid ? check.tenantId : null;
}

function recordCall(o) {
  db.prepare('INSERT INTO calls (at, endpoint, network, amount_usdc, payer, tx_hash, mock, input_chars, auth_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    new Date().toISOString(), o.endpoint, o.network, o.amountUsdc, o.payer, o.txHash, o.mock ? 1 : 0, o.inputChars, o.authMethod
  );
}
function recordTip(o) {
  db.prepare('INSERT INTO tips (at, channel, amount, note, donor) VALUES (?, ?, ?, ?, ?)').run(new Date().toISOString(), o.channel, o.amount ?? null, o.note ?? null, o.donor ?? null);
}

function cleanText(value, max = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function ipv4ToInt(address) {
  const parts = address.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts.reduce((acc, p) => ((acc << 8) + p) >>> 0, 0);
}

function ipv4InCidr(address, base, bits) {
  const ip = ipv4ToInt(address);
  const baseIp = ipv4ToInt(base);
  if (ip === null || baseIp === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (baseIp & mask);
}

function isPrivateOrReservedIp(address) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateOrReservedIp(mapped[1]);
  const family = net.isIP(address);
  if (family === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, bits]) => ipv4InCidr(address, base, bits));
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff');
  }
  return false;
}

async function validatePublicHttpUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl ?? '')); }
  catch { return { ok: false, error: 'invalid_url' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, error: 'unsupported_protocol' };
  if (!parsed.hostname) return { ok: false, error: 'host_required' };
  if (parsed.username || parsed.password) return { ok: false, error: 'credentials_not_allowed' };
  if (String(rawUrl).length > 2048) return { ok: false, error: 'url_too_long' };
  if (ALLOW_PRIVATE_NETWORK_URLS) return { ok: true, url: parsed.toString() };

  const literalFamily = net.isIP(parsed.hostname);
  let resolved = [];
  if (literalFamily) {
    resolved = [{ address: parsed.hostname, family: literalFamily }];
  } else {
    try {
      resolved = await dns.lookup(parsed.hostname, { all: true, verbatim: false });
    } catch {
      return { ok: false, error: 'host_resolution_failed' };
    }
  }
  if (resolved.length === 0) return { ok: false, error: 'host_resolution_failed' };
  if (resolved.some((r) => isPrivateOrReservedIp(r.address))) return { ok: false, error: 'private_network_blocked' };
  return { ok: true, url: parsed.toString(), resolved };
}

function pinnedLookup(resolved) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const family = Number(options?.family || 0);
    const allowed = family ? resolved.filter((r) => r.family === family) : resolved;
    if (allowed.length === 0) {
      const err = new Error('No allowed public address for host');
      err.code = 'ENOTFOUND';
      return callback(err);
    }
    if (options?.all) return callback(null, allowed);
    return callback(null, allowed[0].address, allowed[0].family);
  };
}

const SENSITIVE_AUDIT_KEYS = new Set(['key', 'apiKey', 'token', 'authorization', 'password', 'secret']);
function redactAuditMetadata(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 4) return '[depth_limit]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactAuditMetadata(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      out[k] = SENSITIVE_AUDIT_KEYS.has(k) ? '[redacted]' : redactAuditMetadata(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return cleanText(value, 300);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return cleanText(String(value), 120);
}

function recordAdminAudit(req, { action, targetType = null, targetId = null, status = 'ok', metadata = null }) {
  try {
    const pathOnly = new URL(req.url, `http://${req.headers.host}`).pathname;
    db.prepare(
      `INSERT INTO admin_audit_events
        (id, at, ip, method, path, action, target_type, target_id, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newId('audit'),
      new Date().toISOString(),
      cleanText(clientIp(req), 80),
      cleanText(req.method, 12),
      cleanText(pathOnly, 160),
      cleanText(action, 80),
      targetType ? cleanText(targetType, 80) : null,
      targetId ? cleanText(targetId, 160) : null,
      cleanText(status, 40),
      metadata ? JSON.stringify(redactAuditMetadata(metadata)).slice(0, 4000) : null
    );
  } catch (e) {
    console.error('recordAdminAudit failed:', e);
  }
}

function listAdminAuditEvents({ limit = ADMIN_AUDIT_LIMIT } = {}) {
  const limitSafe = Math.max(1, Math.min(Number(limit) || ADMIN_AUDIT_LIMIT, ADMIN_AUDIT_LIMIT));
  const rows = db.prepare(
    `SELECT id, at, ip, method, path, action, target_type AS targetType,
            target_id AS targetId, status, metadata
       FROM admin_audit_events
      ORDER BY at DESC
      LIMIT ?`
  ).all(limitSafe);
  return rows.map((r) => {
    let metadata = null;
    if (r.metadata) {
      try { metadata = JSON.parse(r.metadata); } catch { metadata = null; }
    }
    return { ...r, metadata };
  });
}

function issueSelfServeTenant({ businessName, contact }) {
  const label = cleanText(businessName, 80) || 'Self-serve tenant';
  const contactClean = cleanText(contact, 120);
  const issued = issueApiKey({
    plan: 'worker-tenant',
    callsLimit: UNLIMITED_CALLS,
    paymentChannel: 'self-serve-signup',
    paymentReference: contactClean || null,
    label,
  });
  return { ...issued, label, contact: contactClean };
}

function recordActivationRequest({ tenantId, worker, channel, reference, contact, note, amountIls }) {
  const id = newId('act');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO activation_requests
      (id, at, tenant_id, worker_id, worker_name, template_id, amount_ils, channel, reference, contact, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, now, tenantId, worker.id, worker.name, worker.templateId,
    amountIls ?? 0, cleanText(channel, 40) || 'manual', cleanText(reference, 120) || null,
    cleanText(contact, 160), cleanText(note, 300) || null
  );
  return { id, at: now };
}

function listActivationRequests({ status = '', limit = 200 } = {}) {
  const limitSafe = Math.max(1, Math.min(Number(limit) || 200, 500));
  if (status) {
    return db.prepare(
      `SELECT id, at, tenant_id AS tenantId, worker_id AS workerId, worker_name AS workerName,
              template_id AS templateId, amount_ils AS amountIls, channel, reference, contact,
              note, status, reviewed_at AS reviewedAt
         FROM activation_requests
        WHERE status = ?
        ORDER BY at DESC
        LIMIT ?`
    ).all(status, limitSafe);
  }
  return db.prepare(
    `SELECT id, at, tenant_id AS tenantId, worker_id AS workerId, worker_name AS workerName,
            template_id AS templateId, amount_ils AS amountIls, channel, reference, contact,
            note, status, reviewed_at AS reviewedAt
       FROM activation_requests
      ORDER BY status = 'pending' DESC, at DESC
      LIMIT ?`
  ).all(limitSafe);
}

function markActivationRequestReviewed(id, status) {
  if (!id) return;
  db.prepare('UPDATE activation_requests SET status = ?, reviewed_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
}

function findPendingActivation({ tenantId, workerId, reference }) {
  const rows = listActivationRequests({ status: 'pending', limit: 50 });
  return rows.find((r) =>
    r.tenantId === tenantId
    && r.workerId === workerId
    && (!reference || !r.reference || r.reference === reference)
  ) ?? null;
}

function validateActivationRequestForPayment({ id, tenantId, workerId }) {
  if (!id) return { ok: true };
  const req = db.prepare(
    `SELECT id, tenant_id AS tenantId, worker_id AS workerId, status
       FROM activation_requests
      WHERE id = ?`
  ).get(id);
  if (!req) return { ok: false, error: 'activation_request_not_found' };
  if (req.status !== 'pending') return { ok: false, error: 'activation_request_not_pending', status: req.status };
  if (req.tenantId !== tenantId || req.workerId !== workerId) {
    return { ok: false, error: 'activation_request_mismatch' };
  }
  return { ok: true, request: req };
}

function getEarningsSummary() {
  const totals = db.prepare(`SELECT COUNT(*) AS total_calls, COALESCE(SUM(CAST(amount_usdc AS REAL)), 0) AS total_usdc, COUNT(DISTINCT payer) AS unique_payers, MAX(at) AS last_call_at FROM calls`).get();
  const byAuth = db.prepare(`SELECT auth_method, COUNT(*) AS calls FROM calls GROUP BY auth_method ORDER BY calls DESC`).all();
  const byEndpoint = db.prepare(`SELECT endpoint, COUNT(*) AS calls, COALESCE(SUM(CAST(amount_usdc AS REAL)), 0) AS usdc FROM calls GROUP BY endpoint ORDER BY calls DESC`).all();
  const tips = db.prepare(`SELECT COUNT(*) AS c FROM tips`).get();
  return {
    totalCalls: totals.total_calls ?? 0,
    totalUsdcReceived: Number((totals.total_usdc ?? 0).toFixed(6)),
    uniquePayers: totals.unique_payers ?? 0,
    lastCallAt: totals.last_call_at ?? null,
    tipCount: tips.c ?? 0,
    byAuthMethod: byAuth, byEndpoint,
  };
}

function getRecentCalls(n = 50) {
  return db.prepare('SELECT id, at, endpoint, network, amount_usdc AS amountUsdc, payer, tx_hash AS txHash, mock, input_chars AS inputChars, auth_method AS authMethod FROM calls ORDER BY id DESC LIMIT ?').all(n);
}

const buckets = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: RATE_LIMIT_PER_MIN, last: now };
  const elapsed = (now - b.last) / 60_000;
  b.tokens = Math.min(RATE_LIMIT_PER_MIN, b.tokens + elapsed * RATE_LIMIT_PER_MIN);
  b.last = now;
  if (b.tokens < 1) { buckets.set(ip, b); return false; }
  b.tokens -= 1; buckets.set(ip, b); return true;
}

const signupBuckets = new Map();
function signupRateLimit(ip) {
  const now = Date.now();
  const b = signupBuckets.get(ip) ?? { tokens: SIGNUP_LIMIT_PER_HOUR, last: now };
  const elapsed = (now - b.last) / 3_600_000;
  b.tokens = Math.min(SIGNUP_LIMIT_PER_HOUR, b.tokens + elapsed * SIGNUP_LIMIT_PER_HOUR);
  b.last = now;
  if (b.tokens < 1) { signupBuckets.set(ip, b); return false; }
  b.tokens -= 1; signupBuckets.set(ip, b); return true;
}

// --- Entrypoints (reserved for future use) --------------------------------

// --- API keys -------------------------------------------------------------

function issueApiKey({ plan, callsLimit, callsUsed = 0, periodEnd = null, paymentChannel, paymentReference, label, tenantId }) {
  const key = newId('sk');
  const id = newId('key');
  const tenant = tenantId || newId('ten');
  db.prepare(
    `INSERT INTO api_keys (id, key_hash, label, tenant_id, plan, calls_limit, calls_used, period_start, period_end, payment_channel, payment_reference, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, hashKey(key), label ?? 'Customer', tenant, plan, callsLimit, callsUsed, new Date().toISOString(), periodEnd, paymentChannel ?? 'manual', paymentReference ?? null, new Date().toISOString());
  return { id, key, tenantId: tenant };
}
function validateApiKey(token) {
  const kh = hashKey(token);
  const r = db.prepare('SELECT id, tenant_id AS tenantId, calls_used, calls_limit, plan, label, period_end, revoked_at FROM api_keys WHERE key_hash = ?').get(kh);
  if (!r) return { valid: false, reason: 'unknown_key' };
  if (r.revoked_at) return { valid: false, reason: 'revoked' };
  if (r.period_end && new Date(r.period_end) < new Date()) return { valid: false, reason: 'expired' };
  const tenantId = r.tenantId || workers.tenantIdFromApiKey(token);
  if (!r.tenantId) db.prepare('UPDATE api_keys SET tenant_id = ? WHERE id = ?').run(tenantId, r.id);
  return { valid: true, plan: r.plan, label: r.label, keyId: r.id, tenantId, calls_used: r.calls_used, calls_limit: r.calls_limit, period_end: r.period_end };
}
function consumeApiCall(kh) {
  const r = db.prepare('SELECT id, tenant_id AS tenantId, calls_used, calls_limit, plan, label FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(kh);
  if (!r) return { valid: false, reason: 'unknown_key' };
  if (r.calls_used >= r.calls_limit) return { valid: false, reason: 'quota_exceeded', used: r.calls_used, limit: r.calls_limit };
  db.prepare('UPDATE api_keys SET calls_used = calls_used + 1 WHERE id = ?').run(r.id);
  return { valid: true, plan: r.plan, used: r.calls_used + 1, limit: r.calls_limit, label: r.label, tenantId: r.tenantId };
}
function rotateApiKey(token) {
  const current = validateApiKey(token);
  if (!current.valid) return current;
  const issued = issueApiKey({
    tenantId: current.tenantId,
    plan: current.plan,
    callsLimit: current.calls_limit,
    callsUsed: current.calls_used,
    periodEnd: current.period_end,
    paymentChannel: 'key-rotation',
    paymentReference: current.keyId,
    label: current.label,
  });
  db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), current.keyId);
  return { valid: true, ...issued, oldKeyId: current.keyId };
}

function replaceTenantKey({ tenantId, label }) {
  const tenant = cleanText(tenantId, 80);
  if (!tenant) return { ok: false, error: 'tenantId_required' };
  const template = db.prepare(
    `SELECT label, plan, calls_limit AS callsLimit, calls_used AS callsUsed, period_end AS periodEnd
       FROM api_keys
      WHERE tenant_id = ?
      ORDER BY revoked_at IS NULL DESC, created_at DESC
      LIMIT 1`
  ).get(tenant);
  const tenantHasWorkers = workers.adminListAllWorkers().some((w) => w.tenantId === tenant);
  if (!template && !tenantHasWorkers) return { ok: false, error: 'unknown_tenant' };
  const issued = issueApiKey({
    tenantId: tenant,
    plan: template?.plan ?? 'worker-tenant',
    callsLimit: template?.callsLimit ?? UNLIMITED_CALLS,
    callsUsed: template?.callsUsed ?? 0,
    periodEnd: template?.periodEnd ?? null,
    paymentChannel: 'admin-recovery',
    paymentReference: 'tenant-key-replacement',
    label: cleanText(label, 80) || template?.label || `Recovered ${tenant}`,
  });
  const now = new Date().toISOString();
  db.prepare('UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id <> ? AND revoked_at IS NULL').run(now, tenant, issued.id);
  return { ok: true, ...issued, revokedExisting: true };
}

function gatherWorkerStats() {
  const all = workers.adminListAllWorkers();
  const active = all.filter((w) => w.status === 'active' && w.paidUntil && new Date(w.paidUntil) > new Date());
  const uniqueTenants = new Set(all.map((w) => w.tenantId));
  let monthlyRevenueIls = 0;
  for (const w of active) {
    const tpl = workers.getTemplate(w.templateId);
    if (tpl) monthlyRevenueIls += tpl.rentPriceIls;
  }
  return { activeWorkers: active.length, tenantCount: uniqueTenants.size, monthlyRevenueIls };
}

function getPublicMarketplaceStats() {
  const prices = workers.TEMPLATES.map((t) => t.buyPriceIls).filter((n) => Number.isFinite(n));
  let tenantCount = 0;
  let workerCount = 0;
  let messageCount = 0;
  try {
    const db = getMainDb();
    tenantCount = db.prepare(`SELECT COUNT(*) AS c FROM tenants`).get()?.c ?? 0;
    workerCount = db.prepare(`SELECT COUNT(*) AS c FROM workers`).get()?.c ?? 0;
    messageCount = db.prepare(`SELECT COUNT(*) AS c FROM messages`).get()?.c ?? 0;
  } catch {}
  return {
    templateCount: workers.TEMPLATES.length,
    categoryCount: new Set(workers.TEMPLATES.map((t) => t.category).filter(Boolean)).size,
    startingPriceIls: prices.length ? Math.min(...prices) : 0,
    paymentChannelCount: buildAcquireChannels().length,
    tenantCount,
    workerCount,
    messageCount,
  };
}

// --- HTTP helpers ---------------------------------------------------------

function vercelAnalyticsScripts() {
  return VERCEL_INLINE_SCRIPT + ANALYTICS_LANDING_SCRIPT;
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

function embedCorsHeaders(req) {
  if (CORS_ALLOW_ORIGIN) {
    return {
      'access-control-allow-origin': CORS_ALLOW_ORIGIN,
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
  }
  if (!EMBED_ALLOW_PUBLIC) return {};
  const origin = req.headers.origin;
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'vary': 'Origin',
  };
}

function send(res, status, body, h = {}) {
  let payload; const ct = h['content-type'] ?? 'application/json';
  if (ct === 'application/json' && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body)) payload = JSON.stringify(body, null, 2);
  else if (typeof body === 'string' || Buffer.isBuffer(body)) payload = body;
  else payload = '';
  const securityHeaders = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=(), microphone=(), camera=()',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'cross-origin-opener-policy': 'same-origin',
  };
  const corsHeaders = CORS_ALLOW_ORIGIN ? {
    'access-control-allow-origin': CORS_ALLOW_ORIGIN,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  } : {};
  res.writeHead(status, {
    'content-type': ct, 'content-length': Buffer.byteLength(payload),
    ...securityHeaders,
    ...corsHeaders,
    ...h,
  });
  res.end(payload);
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (TRUST_PROXY_HEADERS && typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

// Resolve the public base URL for the current request.
// Trusts X-Forwarded-* headers (set by Cloudflare Tunnel, Fly, Render, Railway)
// so the dashboard and invoice always show the real public URL, not localhost.
function resolveBaseUrl(req) {
  const host = TRUST_PROXY_HEADERS ? (req.headers['x-forwarded-host'] ?? req.headers.host) : req.headers.host;
  const proto = TRUST_PROXY_HEADERS ? (req.headers['x-forwarded-proto'] ?? 'http') : 'http';
  if (host) return `${proto}://${host}`;
  return PUBLIC_BASE_URL;
}
async function readBody(req, max = 1024 * 64) {
  const cs = []; let t = 0;
  for await (const c of req) { t += c.length; if (t > max) return { tooLarge: true }; cs.push(c); }
  return { text: Buffer.concat(cs).toString('utf8') };
}

function buildAcquireChannels() {
  const list = [];
  if (PAYPAL_ME) list.push({ kind: 'paypal', url: `https://paypal.me/${PAYPAL_ME}`, howToGetKey: 'Create a marketplace key, pay, then submit activation proof from the worker paywall', note: 'Admin approves activation after payment review' });
  if (paddleEnabled()) list.push({ kind: 'paddle', url: `${PUBLIC_BASE_URL}/marketplace`, note: 'Credit card checkout via Paddle (auto-activation)' });
  if (BUY_ME_A_COFFEE) list.push({ kind: 'buymeacoffee', url: BUY_ME_A_COFFEE });
  if (KO_FI) list.push({ kind: 'kofi', url: KO_FI });
  if (BIT_PHONE) list.push({ kind: 'bit', url: `https://www.bitpay.co.il/app/me/${BIT_PHONE.replace(/\D/g,'')}`, phone: BIT_PHONE });
  if (GITHUB_SPONSORS) list.push({ kind: 'github-sponsors', url: `https://github.com/sponsors/${GITHUB_SPONSORS}` });
  if (GUMROAD_URL) list.push({ kind: 'gumroad', url: GUMROAD_URL });
  if (BANK_ACCOUNT) list.push({ kind: 'bank-transfer', payee: PAYEE_NAME, bank: BANK_NAME, branch: BANK_BRANCH, account: BANK_ACCOUNT, iban: IBAN || null, swift: SWIFT || null, note: 'Israeli-friendly bank transfer (masheh)' });
  return list;
}

// --- HTML pages -----------------------------------------------------------

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function buildDashboard(baseUrl = PUBLIC_BASE_URL) {
  const stats = getPublicMarketplaceStats();
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>עובדי AI — העסק שלך עובד 24/7</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Hebrew:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Secular+One&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/material3-theme.css?v=nightdesk10">
  <style>
    :root {
      color-scheme: dark;
      --font: 'Heebo', system-ui, sans-serif;
      --bg: #080b10;
      --surface: #12161e;
      --surface2: #181e28;
      --border: #2a3340;
      --text: #e8e4dc;
      --body: #b8bfc9;
      --muted: #7a8494;
      --accent: #d4844a;
      --accent2: #a86438;
      --green: #4a9b6e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font: 16px/1.55 var(--font);
      background: var(--bg);
      color: var(--body);
      overflow-x: hidden;
    }

    /* === Ambient background layers === */

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
      html { scroll-behavior: auto; }
    }

    body::before { display: none; }

    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 1040px; margin: 0 auto; padding: 0 24px; position: relative; z-index: 1; }
    nav { display: flex; align-items: center; gap: 24px; padding: 14px 0; flex-wrap: wrap; position: relative; z-index: 2; }
    nav .logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
    nav .logo .logo-icon { font-size: 14px; font-weight: 800; font-family: 'Sora', system-ui, sans-serif; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; color: var(--accent); }
    nav .logo .logo-main { font-family: 'Sora', system-ui, sans-serif; font-size: 19px; font-weight: 800; color: var(--text); background: none; -webkit-text-fill-color: unset; }
    nav .logo .logo-sub { font-size: 10px; color: var(--muted); font-weight: 500; letter-spacing: .04em; }
    nav .links { display: flex; gap: 2px; margin-right: auto; flex-wrap: wrap; }
    nav .links a { color: var(--muted); padding: 6px 12px; border-radius: 8px; font-size: 14px; font-weight: 500; transition: .15s; }
    nav .links a:hover { background: var(--surface); color: var(--text); text-decoration: none; }

    .tpl-card, .stat-card, .pillar-card, .step-card, .faq-item, .vertical-card, .price-card {
      background: var(--surface);
      border: 1px solid var(--border);
      position: relative;
    }

    /* === Hero === */
    .hero { text-align: center; padding: 48px 0 32px; position: relative; }
    @media (min-width: 768px) { .hero { padding: 72px 0 40px; } }
    .hero .badge { display: inline-block; background: rgba(125,168,106,.12); color: var(--green); font-size: 13px; font-weight: 600; padding: 6px 16px; border-radius: 8px; margin-bottom: 20px; border: 1px solid rgba(125,168,106,.2); }
    .hero h1 { font-size: clamp(32px, 5vw, 56px); font-weight: 800; line-height: 1.15; margin-bottom: 16px; color: var(--text); letter-spacing: -.02em; }
    .hero h1 .highlight { color: var(--accent); background: none; -webkit-text-fill-color: unset; }
    .hero .subtitle { font-size: 17px; color: var(--body); max-width: 620px; margin: 0 auto 28px; line-height: 1.65; }
    .hero .cta-group { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; position: relative; z-index: 1; }
    .hero .cta { display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: #1a1008; padding: 14px 32px; border-radius: 8px; font-size: 17px; font-weight: 700; transition: .2s; }
    .hero .cta:hover { filter: brightness(1.05); text-decoration: none; transform: none; box-shadow: none; }
    .hero .cta-secondary { display: inline-flex; align-items: center; gap: 8px; background: rgba(22,19,16,.65); backdrop-filter: blur(8px); color: var(--text); padding: 14px 28px; border-radius: 12px; font-size: 17px; font-weight: 600; border: 1px solid var(--border); transition: .2s; }
    .hero .cta-secondary:hover { background: var(--surface2); border-color: rgba(201,149,62,.3); text-decoration: none; }
    .hero .trust { margin-top: 20px; font-size: 14px; color: var(--muted); display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; position: relative; z-index: 1; }
    .hero .trust span { display: flex; align-items: center; gap: 4px; }

    /* === Animations === */
    @keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    .anim { animation: fadeUp .6s cubic-bezier(.22,1,.36,1) both; }
    .anim-1 { animation-delay: .05s; }
    .anim-2 { animation-delay: .15s; }
    .anim-3 { animation-delay: .25s; }
    .anim-4 { animation-delay: .35s; }

    /* === Sections === */
    section { padding: 64px 0; }
    .section-title { font-size: 28px; font-weight: 700; text-align: center; margin-bottom: 8px; color: var(--text); letter-spacing: -.02em; }
    .section-sub { text-align: center; color: var(--body); font-size: 16px; margin-bottom: 40px; }

    /* === Stats === */
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    @media (max-width: 700px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } }
    .stat-card { border-radius: 14px; padding: 22px 16px; text-align: center; transition: .25s; }
    .stat-card:hover { transform: translateY(-2px); }
    .stat-card .v { font-size: 28px; font-weight: 800; font-family: 'Sora', system-ui, sans-serif; color: var(--accent); }
    .stat-card .k { color: var(--muted); font-size: 13px; margin-top: 2px; font-weight: 500; }

    /* === Pillars (how it works) === */
    .pillars-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    @media (max-width: 700px) { .pillars-grid { grid-template-columns: 1fr; } }
    .pillar-card { border-radius: 16px; padding: 32px 24px; text-align: center; transition: .25s; overflow: hidden; }
    .pillar-card:hover { transform: translateY(-3px); }
    .pillar-card .icon { font-size: 40px; margin-bottom: 14px; display: block; }
    .pillar-card h3 { font-size: 18px; margin-bottom: 8px; font-weight: 700; color: var(--text); }
    .pillar-card p { color: var(--body); font-size: 14px; line-height: 1.7; margin: 0; }

    /* === Templates grid === */
    .tpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
    .tpl-card { border-radius: 14px; padding: 24px; transition: .25s; display: flex; flex-direction: column; overflow: hidden; }
    .tpl-card:hover { border-color: rgba(212,162,74,.35); }
    .tpl-card .icon { font-size: 28px; margin-bottom: 8px; }
    .tpl-card h4 { font-size: 16px; font-weight: 700; margin-bottom: 6px; color: var(--text); }
    .tpl-card .desc { color: var(--body); font-size: 13px; line-height: 1.6; margin-bottom: 12px; flex: 1; }
    .tpl-card .price { font-size: 13px; color: var(--muted); margin-bottom: 14px; }
    .tpl-card .price b { color: var(--green); font-weight: 700; }
    .tpl-card .cta-sm { display: inline-flex; align-items: center; gap: 4px; align-self: flex-start; background: var(--accent); color: white; padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; transition: .2s; }
    .tpl-card .cta-sm:hover { background: #b88430; text-decoration: none; }

    /* === Steps === */
    .steps-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    @media (max-width: 700px) { .steps-grid { grid-template-columns: 1fr; } }
    .step-card { border-radius: 16px; padding: 32px 24px; text-align: center; overflow: hidden; }
    .step-card .num { width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent2)); color: white; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; font-size: 16px; margin-bottom: 14px; }
    .step-card h3 { font-size: 17px; font-weight: 700; margin-bottom: 8px; color: var(--text); }
    .step-card p { color: var(--body); font-size: 14px; line-height: 1.7; margin: 0; }

    /* === FAQ === */
    .faq-grid { max-width: 680px; margin: 0 auto; display: flex; flex-direction: column; gap: 8px; }
    .faq-item { border-radius: 12px; overflow: hidden; transition: .2s; }
    .faq-item:hover { border-color: rgba(201,149,62,.2); }
    .faq-item summary { cursor: pointer; padding: 16px 20px; font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 10px; color: var(--text); }
    .faq-item summary::-webkit-details-marker { display: none; }
    .faq-item summary::before { content: '+'; font-size: 16px; font-weight: 700; color: var(--accent); transition: .2s; }
    .faq-item[open] summary::before { content: '−'; }
    .faq-item .content { padding: 0 20px 16px; color: var(--body); font-size: 14px; line-height: 1.7; }

    /* === Footer === */
    .footer { text-align: center; padding: 40px 0; color: var(--muted); font-size: 13px; border-top: 1px solid var(--border); }
    .footer a { color: var(--accent); }
    .footer .fm { display: flex; gap: 14px; justify-content: center; margin-bottom: 12px; flex-wrap: wrap; }

    /* === Utilities === */
    code { background: var(--surface2); padding: 2px 8px; border-radius: 4px; font-size: 13px; }
    .btn-mkt { display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: #1a1008; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 700; transition: .2s; }
    .btn-mkt:hover { filter: brightness(1.05); text-decoration: none; transform: none; box-shadow: none; }
    .text-center { text-align: center; }
    .mt-8 { margin-top: 32px; }

    .verticals-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 700px) { .verticals-grid { grid-template-columns: repeat(3, 1fr); } }
    .vertical-card { border-radius: 14px; padding: 24px; display: flex; flex-direction: column; gap: 10px; }
    .vertical-card .v-icon { font-size: 32px; }
    .vertical-card h3 { font-size: 18px; color: var(--text); font-weight: 700; }
    .vertical-card p { font-size: 14px; color: var(--body); line-height: 1.65; margin: 0; flex: 1; }
    .vertical-card .v-price { font-size: 13px; color: var(--muted); }
    .vertical-card .v-price b { color: var(--accent); }

    .pricing-grid { display: grid; grid-template-columns: 1fr; gap: 12px; max-width: 720px; margin: 0 auto; }
    @media (min-width: 600px) { .pricing-grid { grid-template-columns: repeat(2, 1fr); } }
    .price-card { border-radius: 14px; padding: 28px 24px; text-align: center; }
    .price-card.featured { border-color: rgba(212,162,74,.45); }
    .price-card .amount { font-size: 36px; font-weight: 800; color: var(--text); }
    .price-card .amount span { font-size: 16px; color: var(--muted); font-weight: 500; }
    .price-card ul { list-style: none; margin: 16px 0 0; padding: 0; text-align: right; font-size: 14px; color: var(--body); }
    .price-card li { padding: 6px 0; border-bottom: 1px solid var(--border); }
    .price-card li:last-child { border: 0; }

    .proof-strip { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; padding: 20px 0 8px; }
    .proof-item { font-size: 13px; color: var(--body); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; }
    .proof-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; max-width: 760px; margin: 0 auto 28px; }
    .proof-stat { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 16px; text-align: center; }
    .proof-stat-n { font-size: 32px; font-weight: 800; color: var(--text); line-height: 1.1; letter-spacing: -.02em; background: linear-gradient(135deg, var(--text), var(--accent)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
    .proof-stat-l { font-size: 12.5px; color: var(--muted); margin-top: 4px; font-weight: 500; }
    .trust-bar { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin: 24px 0 8px; }
    .trust-pill { font-size: 12px; font-weight: 600; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 6px 14px; background: var(--surface); }

    .section-order-templates { order: 1; }
    .section-order-verticals { order: 2; }
    .section-order-pricing { order: 3; }
    .section-order-how { order: 4; }
    .sections-flow { display: flex; flex-direction: column; }
    @media (max-width: 699px) {
      .section-order-hero-cta { margin-bottom: 8px; }
    }
  </style>
</head>
<body class="landing-page night-desk">
  <div class="container">
    <nav>
      <span class="logo">
        <img src="/assets/logo-mark.png" alt="עובדי AI" class="logo-img">
        <span class="logo-text">
          <span class="logo-main">עובדי AI</span>
          <span class="logo-sub">שירות לעסקים בישראל</span>
        </span>
      </span>
      <div class="links">
        <a href="/marketplace">שוק העובדים</a>
        <a href="/marketplace#/workers">העובדים שלי</a>
        <a href="#pricing">מחירים</a>
        <a href="/marketplace#/magic" class="nav-cta">התחל ניסיון</a>
      </div>
    </nav>

    <div class="hero anim anim-1 section-order-hero-cta hero-split">
      <div class="hero-copy">
      <div class="badge">פתרון B2B · עברית · תשלום מקומי</div>
      <h1>העסק <strong class="highlight">לא ישן</strong> — גם כשאתה כן</h1>
      <p class="subtitle">מרפאות, נדל״ן ומסעדות בישראל — עובד AI שמקבל פניות ב-23:00, עונה ללקוחות, ומעביר רק מה שדחוף.</p>
      <div class="cta-group">
        <a href="/marketplace#/magic" class="cta">נסה עכשיו בחינם ←</a>
        <a href="/marketplace" class="cta-secondary">לשוק העובדים ←</a>
      </div>
      <div class="proof-strip">
        <span class="proof-item">✓ בלי כרטיס אשראי — מתחילים תוך דקה</span>
        <span class="proof-item">✓ דוגמה חיה לפני תשלום</span>
        <span class="proof-item">✓ ניסיון ${TRIAL_DAYS > 0 ? TRIAL_DAYS + ' ימים' : '14 ימים'} ללא תשלום</span>
      </div>
      <div class="hero-stat-eyebrow">דוגמה · כך זה נראה בלילה</div>
      <div class="hero-stat-row" aria-label="נתוני משמרת הלילה — דוגמה">
        <span class="hs-live"><span class="hs-pip"></span>דוגמה</span>
        <div class="hero-stat"><div class="hs-num">3</div><div class="hs-lbl">פניות טופלו הלילה</div></div>
        <div class="hero-stat"><div class="hs-num sage">0</div><div class="hs-lbl">המתינו לתשובה</div></div>
        <div class="hero-stat"><div class="hs-num">40<span class="hs-unit">ש'</span></div><div class="hs-lbl">תגובה ממוצעת</div></div>
      </div>
      </div>
      <div class="monitor-wrap">
      <aside class="shift-board" aria-label="דוח משמרת">
        <div class="sb-header">
          <div>
            <div class="sb-title">דוח משמרת · הלילה</div>
            <span class="sb-status"><span class="sb-dot"></span> נועה · קבלה</span>
          </div>
          <span class="sb-clock" id="landing-shift-feed-clock">23:14</span>
        </div>
        <div class="sb-feed" id="landing-shift-feed">
          <div class="sb-event"><time>23:11</time><span class="sb-check">✓</span><span>לקוח כתב בוואטסאפ — נענה</span></div>
          <div class="sb-event"><time>23:12</time><span class="sb-check">✓</span><span>תור נקבע למחר ב-10:00</span></div>
          <div class="sb-event"><time>23:14</time><span class="sb-check">✓</span><span>ליד חם הועבר לבעל העסק</span></div>
        </div>
        <div class="sb-foot-note">דוגמה — עד עכשיו הכל שקט. 3 פניות טופלו, אפס המתינו.</div>
      </aside>
      </div>
    </div>

    <div class="sections-flow">
    <section class="anim anim-2 section-order-templates" id="templates">
      <h2 class="section-title">תבניות מוכנות להפעלה</h2>
      <p class="section-sub">בחר תבנית, התאם אישית, שלח בקשת הפעלה — תוך דקות</p>
      <div class="tpl-grid" id="tpl-list">
        <div style="text-align:center;grid-column:1/-1;color:var(--muted);padding:32px">טוען תבניות...</div>
      </div>
      <div class="text-center mt-8">
        <a href="/marketplace" class="btn-mkt">לכל התבניות בשוק ←</a>
      </div>
    </section>

    <section class="anim anim-2 section-order-verticals" id="verticals">
      <h2 class="section-title">לפי תחום העסק</h2>
      <p class="section-sub">תבניות מותאמות לשוק הישראלי — לא משחק, לא צעצוע</p>
      <div class="verticals-grid">
        <div class="vertical-card">
          <div class="v-icon">🏥</div>
          <h3>מרפאות וקליניקות</h3>
          <p>קביעת תורים, שאלות על שעות וביטוח, ביטולים. ללא ייעוץ רפואי — מעביר מקרים דחופים לאדם.</p>
          <div class="v-price">מ-<b>299 ₪</b>/חודש · מזכיר/ת רפואי/ת</div>
          <a href="/marketplace" class="cta-sm">לתבנית המרפאה ←</a>
        </div>
        <div class="vertical-card">
          <div class="v-icon">🏠</div>
          <h3>נדל״ן ותיווך</h3>
          <p>סינון מחפשי דירות, איסוף תקציב ואזור, תיאום ביקורים, ייצוא לידים ל-JSON/CSV לסוכן.</p>
          <div class="v-price">מ-<b>249 ₪</b>/חודש · סוכן נדל״ן</div>
          <a href="/marketplace" class="cta-sm">לתבנית הנדל״ן ←</a>
        </div>
        <div class="vertical-card">
          <div class="v-icon">🍽️</div>
          <h3>מסעדות ואירוח</h3>
          <p>הזמנות, שאלות תפריט, טייק אווי. בודק שעות פעילות לפני אישור הזמנה.</p>
          <div class="v-price">מ-<b>249 ₪</b>/חודש · מנהל מסעדה</div>
          <a href="/marketplace" class="cta-sm">לתבנית המסעדה ←</a>
        </div>
      </div>
    </section>

    <section class="anim anim-3 section-order-case-studies" id="case-studies">
      <h2 class="section-title">סיפורי לקוחות (פיילוט)</h2>
      <p class="section-sub">תיקי עובדים מעסקים ישראליים — תוצאות ראשונות</p>
      <div class="proof-stats">
        <div class="proof-stat"><div class="proof-stat-n">${stats.tenantCount}+</div><div class="proof-stat-l">עסקים פעילים</div></div>
        <div class="proof-stat"><div class="proof-stat-n">${stats.workerCount}</div><div class="proof-stat-l">עובדי AI פעילים</div></div>
        <div class="proof-stat"><div class="proof-stat-n">${(stats.messageCount || 0).toLocaleString('he-IL')}</div><div class="proof-stat-l">שיחות עם לקוחות</div></div>
        <div class="proof-stat"><div class="proof-stat-n">${stats.templateCount}</div><div class="proof-stat-l">תבניות מוכנות</div></div>
      </div>
      <div class="employee-files">
        <div class="employee-file">
          <div class="ef-tab">תיק עובד · קליניקה</div>
          <div class="ef-body">
            <h3>קליניקת שיניים — תל אביב</h3>
            <p>מזכירה וירטואלית ענתה על 340 פניות בחודש הראשון. 78% קבעו תור ללא שיחה עם אדם.</p>
            <div class="ef-result">−62% עומס טלפוני</div>
          </div>
        </div>
        <div class="employee-file">
          <div class="ef-tab">תיק עובד · נדל״ן</div>
          <div class="ef-body">
            <h3>משרד תיווך — חיפה</h3>
            <p>סוכן נדל״ן סינן 120 לידים בחודש. 31 לידים חמים הועברו לסוכן עם תקציב ואזור מוגדרים.</p>
            <div class="ef-result">3× יותר פגישות</div>
          </div>
        </div>
        <div class="employee-file">
          <div class="ef-tab">תיק עובד · מסעדה</div>
          <div class="ef-body">
            <h3>מסעדת שף — ירושלים</h3>
            <p>מנהל מסעדה טיפל בהזמנות ושאלות תפריט בערב שישי. 94% מהשאלות נענו ללא הסלמה.</p>
            <div class="ef-result">הפעלה תוך יום עסקים</div>
          </div>
        </div>
      </div>
    </section>

    <section class="anim anim-3 section-order-pricing" id="pricing">
      <div class="pricing-eyebrow">// מחירון שקוף</div>
      <h2 class="section-title">מחירון שקוף</h2>
      <p class="section-sub">ללא דמי הקמה · ללא חוזה ארוך · ביטול בכל עת</p>
      <div class="pricing-grid">
        <div class="price-card">
          <div class="amount">₪199<span>/חודש</span></div>
          <div class="price-cat">תפעול ונתונים</div>
          <ul>
            <li><span class="price-check">✓</span> הזנת נתונים, מבנה JSON/CSV</li>
            <li><span class="price-check">✓</span> זיכרון לקוח ו-webhook</li>
            <li><span class="price-check">✓</span> צ'אט 24/7 לאחר אישור</li>
          </ul>
          <a href="/marketplace#/magic" class="price-cta">התחל ניסיון ←</a>
        </div>
        <div class="price-card featured">
          <div class="price-ribbon">הכי נבחר</div>
          <div class="amount">₪249–299<span>/חודש</span></div>
          <div class="price-cat">מכירות · שירות · נדל״ן · מסעדות</div>
          <ul>
            <li><span class="price-check">✓</span> תבנית מותאמת לתחום</li>
            <li><span class="price-check">✓</span> לידים, תורים, escalation</li>
            <li><span class="price-check">✓</span> תמיכה בעברית מלאה</li>
          </ul>
          <a href="/marketplace#/magic" class="price-cta">התחל עכשיו ←</a>
        </div>
      </div>
      <p class="text-center muted" style="margin-top:16px;font-size:13px">רכישה חד-פעמית: לרוב ₪0 (SaaS חודשי). פרטים מלאים ב-<a href="/invoice">חשבונית</a>.</p>
    </section>

    <section class="anim anim-3 section-order-how">
      <h2 class="section-title">איך מתחילים</h2>
      <p class="section-sub">שלושה צעדים — בלי מפתחות API ובלי מפתח</p>
      <div class="timeline-steps">
        <div class="timeline-step">
          <div class="ts-marker">🏢</div>
          <h3>שם העסק</h3>
          <p>כותבים איך קוראים לעסק — 30 שניות.</p>
        </div>
        <div class="timeline-step">
          <div class="ts-marker">👤</div>
          <h3>בוחרים תפקיד</h3>
          <p>מכירות, מזכירות, נדל״ן — תבנית מוכנה בעברית.</p>
        </div>
        <div class="timeline-step">
          <div class="ts-marker">💬</div>
          <h3>שיחה ראשונה</h3>
          <p>דוגמה חיה לפני תשלום — ניסיון ${TRIAL_DAYS > 0 ? TRIAL_DAYS + ' ימים' : '14 ימים'}.</p>
        </div>
      </div>
    </section>
    </div>

    <section class="anim anim-4">
      <div class="stats-grid" id="stats">
        <div class="stat-card"><div class="v" id="s-workers">-</div><div class="k">תבניות</div></div>
        <div class="stat-card"><div class="v" id="s-tenants">-</div><div class="k">קטגוריות</div></div>
        <div class="stat-card"><div class="v" id="s-revenue">-</div><div class="k">מחיר התחלה</div></div>
        <div class="stat-card"><div class="v" id="s-tips">-</div><div class="k">אמצעי תשלום</div></div>
      </div>
    </section>

    <section class="anim anim-4">
      <h2 class="section-title">שאלות נפוצות</h2>
      <p class="section-sub">כל מה שרצית לדעת על עובדי AI</p>
      <div class="faq-grid">
        <details class="faq-item">
          <summary>מה זה "עובד AI"?</summary>
          <div class="content">עובד AI הוא עובד וירטואלי שמבוסס על בינה מלאכותית. הוא מנהל שיחות עם לקוחות, עונה על שאלות, מסנן לידים, מתאם פגישות ומבצע משימות שירות — בדיוק כמו עובד אנושי, אבל זול בהרבה ועובד 24/7.</div>
        </details>
        <details class="faq-item">
          <summary>כמה זה עולה?</summary>
          <div class="content">מנוי חודשי מ-199 ₪ (תפעול) עד 299 ₪ (מרפאות). לרוב אין דמי הקמה. תשלום ב-PayPal, Bit או העברה בנקאית. פירוט מלא בדף החשבונית.</div>
        </details>
        <details class="faq-item">
          <summary>האם אני צריך כרטיס אשראי?</summary>
          <div class="content">לא. אנחנו תומכים ב-PayPal, Bit, והעברה בנקאית. מתאים במיוחד לבעלי עסקים בישראל.</div>
        </details>
        <details class="faq-item">
          <summary>איך העובד לומד על העסק שלי?</summary>
          <div class="content">אתה כותב לו ידע ספציפי — שאלות נפוצות, מחירונים, מדיניות. יכולות השפה מסופקות אוטומטית על ידי הפלטפורמה — בלי צורך במפתח אישי.</div>
        </details>
        <details class="faq-item">
          <summary>האם העובד זוכר לקוחות?</summary>
          <div class="content">כן! העובד זוכר עובדות על לקוחות לאורך שיחות — העדפות, פרטי קשר, היסטוריית רכישות. הכל מאובטח בשרת שלך.</div>
        </details>
      </div>
    </section>
  </div>

  <div class="footer">
    <div class="fm">
      <a href="/marketplace">שוק העובדים</a>
      <a href="/invoice">איך משלמים</a>
      <a href="/privacy">מדיניות פרטיות</a>
      <a href="/terms">תנאי שימוש</a>
      ${AGENT_OWNER_CONTACT ? `<a href="mailto:${escapeHtml(AGENT_OWNER_CONTACT)}">צור קשר</a>` : ''}
    </div>
    <p>${escapeHtml(AGENT_NAME)} · ${escapeHtml(AGENT_DESCRIPTION)}</p>
    <p class="footer-legal-note">תשלום בכרטיס אשראי (Paddle), Bit, PayPal או העברה בנקאית</p>
  </div>

  <script>
    function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
    function animateValue(el, start, end, suffix, duration) {
      if (!el) return;
      let startTime = null;
      const step = (time) => {
        if (!startTime) startTime = time;
        const p = Math.min((time - startTime) / duration, 1);
        const ease = 1 - Math.pow(1 - p, 3);
        const val = Math.floor(start + (end - start) * ease);
        el.textContent = val + (suffix || '');
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    async function loadStats() {
      try {
        const r = await fetch('/api/public/stats');
        if (!r.ok) return;
        const j = await r.json();
        animateValue(document.getElementById('s-workers'), 0, j.templateCount ?? 0, '', 800);
        animateValue(document.getElementById('s-tenants'), 0, j.categoryCount ?? 0, '', 800);
        const priceEl = document.getElementById('s-revenue');
        if (priceEl) priceEl.textContent = (j.startingPriceIls ?? 0) + ' ₪+';
        animateValue(document.getElementById('s-tips'), 0, j.paymentChannelCount ?? 0, '', 600);
      } catch (e) { console.error('loadStats failed:', e); }
    }
    async function loadTemplates() {
      try {
        const r = await fetch('/api/workers/templates'); const j = await r.json();
        const tpls = j.templates ?? [];
        const container = document.getElementById('tpl-list');
        if (!tpls.length) { container.innerHTML = '<div style="text-align:center;grid-column:1/-1;color:var(--muted);padding:40px">אין תבניות כרגע</div>'; return; }
        container.innerHTML = tpls.map((t, i) => \`
          <div class="tpl-card anim" style="animation-delay:\${i * ${TEMPLATE_ANIM_DELAY}}s">
            <div class="icon">\${esc(t.icon)}</div>
            <h4>\${esc(t.nameHe || t.name)}</h4>
            <div class="desc">\${esc(t.description)}</div>
            <div class="price">שכירות: <b>\${t.rentPriceIls} ₪/חודש</b>\${t.buyPriceIls > 0 ? ' · הקמה: ' + t.buyPriceIls + ' ₪' : ''}</div>
            <a href="/marketplace" class="cta-sm">הוסף לעסק ←</a>
          </div>
        \`).join('');
      } catch (e) { console.error(e); }
    }
    loadStats(); setInterval(loadStats, ${STATS_POLL_MS});
    loadTemplates();
    (function initLandingShift() {
      const feed = document.getElementById('landing-shift-feed');
      const clock = document.getElementById('landing-shift-feed-clock');
      if (clock) {
        const tick = function() {
          var d = new Date();
          clock.textContent = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
        };
        tick(); setInterval(tick, 15000);
      }
      if (!feed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const events = [
        { t: '23:11', m: 'לקוח כתב בוואטסאפ — נענה' },
        { t: '23:12', m: 'תור נקבע למחר ב-10:00' },
        { t: '23:14', m: 'ליד חם הועבר לבעל העסק' },
        { t: '23:16', m: 'אישור הזמנה נשלח ב-SMS' },
        { t: '23:19', m: 'שאלה חוזרת — נענתה מהידע' },
      ];
      let i = 3;
      setInterval(function() {
        i = (i + 1) % events.length;
        var el = document.createElement('div');
        el.className = 'sb-event sb-event-new';
        el.innerHTML = '<time>' + events[i].t + '</time><span class="sb-check">✓</span><span>' + events[i].m + '</span>';
        feed.insertBefore(el, feed.firstChild);
        while (feed.children.length > 4) feed.lastChild.remove();
      }, 4600);
    })();
  </script>
  ${vercelAnalyticsScripts()}
</body>
</html>`;
}

function buildTryPage(workerId, workerName, baseUrl = PUBLIC_BASE_URL) {
  const name = workerName || 'עובד וירטואלי';
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>שיחה עם ${name}</title>
  <style>body{margin:0;min-height:100vh;background:#121218;color:#e8e8e8;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}p{color:#9a9aa8;max-width:420px;line-height:1.5}a{color:#d4a24a}</style>
</head>
<body>
  <div>
    <h1 style="font-size:1.25rem;font-weight:600;margin:0 0 8px">${name}</h1>
    <p>לחצו על הכפתור בפינה לפתיחת שיחה. מופעל על ידי AI Workers.</p>
    <p><a href="${baseUrl}/marketplace">לשוק העובדים ←</a></p>
  </div>
  <script src="${baseUrl}/embed.js" data-worker="${workerId}"></script>
</body>
</html>`;
}

function buildInvoiceText(baseUrl = PUBLIC_BASE_URL) {
  const TEMPLATES = workers.TEMPLATES ?? [];
  const tplRows = TEMPLATES.map((t) =>
    `  ${(t.name + ' (' + t.nameHe + ')').padEnd(50)}  buy ${String(t.buyPriceIls).padStart(4)} ILS  |  rent ${String(t.rentPriceIls).padStart(4)} ILS/mo`
  ).join('\n');

  const lines = [];
  lines.push(`INVOICE / HATZAMAT HESHBON`);
  lines.push('='.repeat(60));
  lines.push(`From:    ${AGENT_NAME}`);
  if (PAYEE_NAME) lines.push(`Payee:   ${PAYEE_NAME}`);
  if (AGENT_OWNER_CONTACT) lines.push(`Email:   ${AGENT_OWNER_CONTACT}`);
  if (baseUrl) lines.push(`URL:     ${baseUrl}`);
  lines.push(`Date:    ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('AI WORKER TEMPLATES');
  lines.push('-'.repeat(60));
  lines.push(tplRows);
  lines.push('');
  lines.push('PAYMENT OPTIONS');
  lines.push('-'.repeat(60));
  if (PAYPAL_ME) lines.push(`  PayPal:       https://paypal.me/${PAYPAL_ME}`);
  if (BUY_ME_A_COFFEE) lines.push(`  Buy Me Coffee: ${BUY_ME_A_COFFEE}`);
  if (KO_FI) lines.push(`  Ko-fi:        ${KO_FI}`);
  if (BIT_PHONE) lines.push(`  Bit:          https://www.bitpay.co.il/app/me/${BIT_PHONE.replace(/\D/g,'')}  (${BIT_PHONE})`);
  if (GITHUB_SPONSORS) lines.push(`  GitHub:       https://github.com/sponsors/${GITHUB_SPONSORS}`);
  if (GUMROAD_URL) lines.push(`  Gumroad:      ${GUMROAD_URL}`);
  lines.push('');
  if (BANK_ACCOUNT) {
    lines.push('BANK TRANSFER (Israeli-friendly)');
    lines.push('-'.repeat(60));
    if (PAYEE_NAME) lines.push(`  Payee name:   ${PAYEE_NAME}`);
    if (BANK_NAME) lines.push(`  Bank:         ${BANK_NAME}`);
    if (BANK_BRANCH) lines.push(`  Branch:       ${BANK_BRANCH}`);
    if (BANK_ACCOUNT) lines.push(`  Account #:    ${BANK_ACCOUNT}`);
    if (IBAN) lines.push(`  IBAN:         ${IBAN}`);
    if (SWIFT) lines.push(`  SWIFT/BIC:    ${SWIFT}`);
    lines.push('  Reference:    include the template id (e.g. "real-estate-il") so I can match the payment.');
    lines.push('');
  }
  lines.push('HOW TO ORDER');
  lines.push('-'.repeat(60));
  lines.push(`  1. Open the marketplace and create your tenant key: ${baseUrl}/marketplace`);
  lines.push(`  2. Pick a worker template and customize it.`);
  lines.push(`  3. Pay the first month's rent via any channel above.`);
  lines.push(`  4. Submit payment proof from the worker paywall.`);
  lines.push(`  5. Admin approves the request and your worker opens for chat.`);
  return lines.join('\n');
}

function buildWorkerInvoiceHtml({ worker, tenantId, template, baseUrl }) {
  const date = new Date().toISOString().slice(0, 10);
  const rent = template?.rentPriceIls ?? 0;
  const vatRate = process.env.VAT_RATE ?? '17';
  const vatNote = process.env.VAT_REGISTERED === '1'
    ? `מע"מ ${vatRate}% יחושב בחשבונית מס`
    : 'מע"מ: לפי סטטוס עוסק (מורשה / פטור) — יש למלא בחשבונית';
  const paidUntil = worker.paidUntil ? new Date(worker.paidUntil).toLocaleDateString('he-IL') : '—';
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>חשבונית — ${worker.name}</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:24px;color:#111;line-height:1.6}
    h1{font-size:22px;margin:0 0 8px} .muted{color:#666;font-size:14px}
    table{width:100%;border-collapse:collapse;margin:20px 0} th,td{border:1px solid #ddd;padding:10px;text-align:right}
    th{background:#f6f6f6} .total{font-size:18px;font-weight:700}
    @media print{body{margin:0}}
  </style>
</head>
<body>
  <h1>חשבונית / קבלה — ${AGENT_NAME}</h1>
  <p class="muted">תאריך: ${date} · מזהה עובד: ${worker.id}</p>
  ${PAYEE_NAME ? `<p><strong>לכבוד:</strong> ${PAYEE_NAME}</p>` : ''}
  ${AGENT_OWNER_CONTACT ? `<p><strong>יצירת קשר:</strong> ${AGENT_OWNER_CONTACT}</p>` : ''}
  <table>
    <thead><tr><th>פריט</th><th>תקופה</th><th>סכום (₪)</th></tr></thead>
    <tbody>
      <tr>
        <td>${template?.nameHe || template?.name || worker.name}</td>
        <td>שכירות חודשית · בתוקף עד ${paidUntil}</td>
        <td>${rent}</td>
      </tr>
    </tbody>
  </table>
  <p class="total">סה"כ לפני מע"מ: ₪${rent}</p>
  <p class="muted">${vatNote}</p>
  <p class="muted">Tenant: ${tenantId} · ${baseUrl}</p>
  <p class="muted" style="margin-top:24px">מסמך זה נוצר אוטומטית לצורכי תיעוד. לחשבונית מס רשמית פנו לתמיכה.</p>
</body>
</html>`;
}

// --- Admin ----------------------------------------------------------------

function isAdmin(req, parsedUrl) {
  if (!ADMIN_TOKEN) return false;
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length);
    const ok = token.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    if (!ok) recordAdminAudit(req, { action: 'admin_auth_failed', status: 'denied', metadata: { reason: 'invalid_bearer' } });
    return ok;
  }
  if (parsedUrl.searchParams.has('token')) {
    console.warn('Rejected admin token in query string');
    recordAdminAudit(req, { action: 'admin_auth_failed', status: 'denied', metadata: { reason: 'query_token_rejected' } });
  } else {
    recordAdminAudit(req, { action: 'admin_auth_failed', status: 'denied', metadata: { reason: 'missing_bearer' } });
  }
  return false;
}

// --- Routes ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'OPTIONS') {
    const embedPath = url.pathname.startsWith('/api/embed/');
    const preflight = embedPath ? embedCorsHeaders(req) : (CORS_ALLOW_ORIGIN ? {
      'access-control-allow-origin': CORS_ALLOW_ORIGIN,
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    } : {});
    return send(res, 204, '', preflight);
  }
  if (!rateLimit(clientIp(req))) return send(res, 429, { error: 'rate_limited' });

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, buildDashboard(resolveBaseUrl(req)), { 'content-type': 'text/html; charset=utf-8' });
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      ok: true, agent: AGENT_NAME,
      statusHe: LLM_API_KEY ? 'מוכן לעבודה' : 'צריך הגדרה',
      channels: buildAcquireChannels().map((c) => c.kind),
      adminEnabled: !!ADMIN_TOKEN,
      llmConfigured: !!LLM_API_KEY,
      llmProvider: LLM_PROVIDER,
      llmModel: LLM_MODEL,
      publicBaseUrl: resolveBaseUrl(req),
      dbPath: DB_PATH,
      tenantsDir: process.env.TENANTS_DIR ?? path.join(__dirname, 'data', 'tenants'),
      persistentStorage: !DB_PATH.includes('/tmp'),
      whatsapp: whatsappConfigStatus(),
      integrationsCatalog: integrations.listCatalog().length,
      payment: { ...paymentConfigStatus(), paddle: paddleConfigStatus() },
      trialDays: TRIAL_DAYS,
    });
  }
  if (handleLegalRoutes(req, res, url, send)) return;

  if (await handlePaddleWebhook(req, res, url, { send, readBody, recordAdminAudit })) return;

  if (await handlePaymentWebhooks(req, res, url, {
    send,
    readBody,
    markActivationRequestReviewed,
    recordAdminAudit,
    findPendingActivation,
  })) return;

  // WhatsApp inbound webhook (no tenant auth — provider verification)
  if (await handleWhatsAppWebhook(req, res, url, {
    send,
    readBody,
    processInbound: (inbound) => processWhatsAppInbound(db, {
      chatWithWorker: workers.chatWithWorker,
      logAgentActions: workers.logAgentActions,
      getWorker: workers.getWorker,
    }, inbound),
  })) return;

  if (req.method === 'GET' && url.pathname === '/api/public/stats') {
    return send(res, 200, getPublicMarketplaceStats());
  }
  if (req.method === 'POST' && url.pathname === '/api/public/demo-chat') {
    const { text: raw } = await readBody(req, BODY_SMALL);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid_json' }); }
    if (!body.templateId || !body.message) return send(res, 400, { error: 'templateId_and_message_required' });
    const result = workers.publicTemplateDemoChat({
      templateId: body.templateId,
      userMessage: body.message,
      businessName: cleanText(body.businessName, 80),
    });
    return send(res, result.ok ? 200 : 400, result);
  }
  if (req.method === 'GET' && url.pathname === '/earnings') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    let workerStats = { activeWorkers: 0, tenantCount: 0, monthlyRevenueIls: 0 };
    try { workerStats = gatherWorkerStats(); } catch (e) { console.error('gatherWorkerStats failed:', e); }
    return send(res, 200, { agent: AGENT_NAME, workerStats, summary: getEarningsSummary(), recent: getRecentCalls(RECENT_CALLS_DEFAULT) });
  }
  if (req.method === 'GET' && url.pathname === '/earnings.csv') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    const escCsv = (v) => {
      const s = String(v ?? '');
      return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = getRecentCalls(CSV_EXPORT_LIMIT);
    const header = 'id,at,endpoint,network,amount_usdc,payer,tx_hash,mock,input_chars,auth_method\n';
    const body = rows.map((r) => [r.id, r.at, r.endpoint, r.network, r.amountUsdc, r.payer, r.txHash, r.mock, r.inputChars, r.authMethod].map(escCsv).join(',')).join('\n');
    return send(res, 200, header + body, { 'content-type': 'text/csv; charset=utf-8' });
  }
  if (req.method === 'GET' && url.pathname === '/invoice') {
    return send(res, 200, buildInvoiceText(resolveBaseUrl(req)), { 'content-type': 'text/plain; charset=utf-8' });
  }
  if (req.method === 'GET' && url.pathname === '/invoice.txt') return send(res, 200, buildInvoiceText(resolveBaseUrl(req)), { 'content-type': 'text/plain; charset=utf-8' });

  const workerInvoiceMatch = url.pathname.match(/^\/invoice\/([A-Za-z0-9_]+)$/);
  if (req.method === 'GET' && workerInvoiceMatch) {
    const found = workers.adminFindWorker(workerInvoiceMatch[1]);
    if (!found) return send(res, 404, { error: 'worker_not_found' });
    const worker = workers.getWorker(found.tenantId, found.id);
    const template = workers.getTemplate(worker.templateId);
    const html = buildWorkerInvoiceHtml({
      worker,
      tenantId: found.tenantId,
      template,
      baseUrl: resolveBaseUrl(req),
    });
    return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
  }

  if (req.method === 'GET' && url.pathname === '/embed.js') {
    const script = buildEmbedScript(resolveBaseUrl(req));
    return send(res, 200, script, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public,max-age=' + ASSETS_CACHE_MAX_AGE,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/embed/config') {
    const workerId = url.searchParams.get('workerId') ?? '';
    const found = workers.adminFindWorker(workerId);
    if (!found) return send(res, 404, { error: 'not_found' }, embedCorsHeaders(req));
    const worker = workers.getWorker(found.tenantId, found.id);
    if (!EMBED_ALLOW_PUBLIC && !worker.isActive) return send(res, 403, { error: 'embed_disabled' }, embedCorsHeaders(req));
    return send(res, 200, { workerId, name: worker.name, isActive: worker.isActive, templateId: worker.templateId }, embedCorsHeaders(req));
  }

  if (req.method === 'POST' && url.pathname === '/api/embed/chat') {
    const cors = embedCorsHeaders(req);
    const { text: raw } = await readBody(req, BODY_SMALL);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid_json' }, cors); }
    if (!body.workerId || !body.message) return send(res, 400, { error: 'workerId_and_message_required' }, cors);
    const tenantFromKey = requireAuth(req);
    const found = workers.adminFindWorker(body.workerId);
    if (!found) return send(res, 404, { error: 'not_found' }, cors);
    if (tenantFromKey && tenantFromKey !== found.tenantId) return send(res, 403, { error: 'forbidden' }, cors);
    const worker = workers.getWorker(found.tenantId, found.id);
    if (!worker.isActive && !EMBED_ALLOW_PUBLIC) return send(res, 402, { error: 'payment_required', message: 'Worker is not active' }, cors);
    const res2 = await workers.chatWithWorker({
      tenantId: found.tenantId,
      workerId: found.id,
      userMessage: body.message,
      customerId: body.customerId ?? 'embed_visitor',
      demoMode: !worker.isActive,
    });
    return send(res, res2.status ?? 200, { reply: res2.reply ?? res2.message, ...res2 }, cors);
  }

  // Admin: issue an API key for a new tenant
  if (req.method === 'POST' && url.pathname === '/admin/issue-key') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    const { text: raw } = await readBody(req, BODY_TINY);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const issued = issueApiKey({
      plan: 'worker-tenant', callsLimit: UNLIMITED_CALLS,
      paymentChannel: body.channel ?? 'manual', paymentReference: body.reference ?? null,
      label: body.label ?? `Tenant (${body.channel ?? 'manual'})`,
    });
    recordAdminAudit(req, {
      action: 'admin_issue_key',
      targetType: 'tenant',
      targetId: issued.tenantId,
      metadata: { keyId: issued.id, label: body.label, channel: body.channel, reference: body.reference },
    });
    return send(res, 200, { ok: true, key: issued.key, keyId: issued.id, tenantId: issued.tenantId, note: 'API key for the worker marketplace. Paste it in the marketplace to manage your workers.' });
  }

  // Admin: list issued keys (no secrets)
  if (req.method === 'GET' && url.pathname === '/admin/keys') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    const rows = db.prepare(
      `SELECT id, label, plan, calls_limit AS callsLimit, calls_used AS callsUsed,
              tenant_id AS tenantId,
              payment_channel AS paymentChannel, payment_reference AS paymentReference,
              created_at AS createdAt, revoked_at AS revokedAt
               FROM api_keys ORDER BY created_at DESC LIMIT ${ADMIN_KEYS_LIMIT}`
    ).all();
    return send(res, 200, { keys: rows });
  }

  // Admin: revoke a key
  if (req.method === 'POST' && url.pathname === '/admin/revoke') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    const { text: raw } = await readBody(req, BODY_TINY);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!body.keyId) return send(res, 400, { error: 'keyId_required' });
    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), body.keyId);
    recordAdminAudit(req, { action: 'admin_revoke_key', targetType: 'api_key', targetId: body.keyId });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/replace-tenant-key') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    const { text: raw } = await readBody(req, BODY_TINY);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid_json' }); }
    const result = replaceTenantKey({ tenantId: body.tenantId, label: body.label });
    if (!result.ok) {
      recordAdminAudit(req, { action: 'admin_replace_tenant_key', targetType: 'tenant', targetId: body.tenantId, status: 'failed', metadata: { error: result.error } });
      return send(res, 400, result);
    }
    recordAdminAudit(req, {
      action: 'admin_replace_tenant_key',
      targetType: 'tenant',
      targetId: result.tenantId,
      metadata: { keyId: result.id, label: body.label, revokedExisting: result.revokedExisting },
    });
    return send(res, 200, {
      ok: true,
      key: result.key,
      keyId: result.id,
      tenantId: result.tenantId,
      revokedExisting: result.revokedExisting,
      note: 'Send this key through a verified support channel. It is shown only in this response.',
    });
  }

  // Tip jar endpoint (records a tip; doesn't issue a key)
  if (req.method === 'POST' && url.pathname === '/tip') {
    const { text: raw } = await readBody(req, BODY_TINY);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    recordTip({ channel: body.channel ?? 'unknown', amount: body.amount, note: body.note, donor: body.donor });
    return send(res, 200, { ok: true, thanks: true });
  }

  // Self-serve tenant signup. The key can create/configure workers, but chat
  // remains payment-gated until an admin approves a rental.
  if (req.method === 'POST' && url.pathname === '/api/signup') {
    if (!signupRateLimit(clientIp(req))) return send(res, 429, { error: 'signup_rate_limited' });
    const { text: raw, tooLarge } = await readBody(req, BODY_TINY);
    if (tooLarge) return send(res, 413, { error: 'body_too_large' });
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid_json' }); }
    const businessName = cleanText(body.businessName, 80);
    const contact = cleanText(body.contact, 160);
    if (!businessName) return send(res, 400, { error: 'business_name_required' });
    if (!contact) return send(res, 400, { error: 'contact_required' });
    const issued = issueSelfServeTenant({ businessName, contact });
    return send(res, 200, {
      ok: true,
      key: issued.key,
      keyId: issued.id,
      tenantId: issued.tenantId,
      label: issued.label,
      note: 'Store this key locally. It lets you configure workers; activation still requires payment approval.',
    });
  }

  // --- Workers: marketplace + builder + chat -----------------------------
  const tryMatch = url.pathname.match(/^\/try\/([A-Za-z0-9_]+)$/);
  if (req.method === 'GET' && tryMatch) {
    const found = workers.adminFindWorker(tryMatch[1]);
    if (!found) return send(res, 404, { error: 'not_found' });
    const worker = workers.getWorker(found.tenantId, found.id);
    const html = buildTryPage(found.id, worker.name, resolveBaseUrl(req));
    return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
  }
  // HTML pages
  if (req.method === 'GET' && (url.pathname === '/marketplace' || url.pathname === '/builder' || url.pathname.startsWith('/workers/') || url.pathname === '/workers')) {
    let html = fs.readFileSync(path.join(__dirname, 'workers-ui.html'), 'utf8');
    const payCfg = JSON.stringify({
      bitPhone: BIT_PHONE || '',
      paypalMe: PAYPAL_ME || '',
      bankName: BANK_NAME || '',
      bankBranch: BANK_BRANCH || '',
      bankAccount: BANK_ACCOUNT || '',
      payeeName: PAYEE_NAME || '',
      activationSlaHe: activationSlaTextHe(),
      trialDays: TRIAL_DAYS,
      paddleEnabled: paddleEnabled(),
      ownerContact: AGENT_OWNER_CONTACT || '',
    });
    html = html.replace('</body>', `${VERCEL_INLINE_SCRIPT}<script>const PAYMENT_CONFIG = ${payCfg};const BIT_PHONE=PAYMENT_CONFIG.bitPhone;const PAYPAL_ME=PAYMENT_CONFIG.paypalMe;const BANK_NAME=PAYMENT_CONFIG.bankName;const BANK_BRANCH=PAYMENT_CONFIG.bankBranch;const BANK_ACCOUNT=PAYMENT_CONFIG.bankAccount;const PAYEE_NAME=PAYMENT_CONFIG.payeeName;const ACTIVATION_SLA_HE=PAYMENT_CONFIG.activationSlaHe;const TRIAL_DAYS=PAYMENT_CONFIG.trialDays;const PADDLE_ENABLED=PAYMENT_CONFIG.paddleEnabled;const AGENT_OWNER_CONTACT=PAYMENT_CONFIG.ownerContact;</script></body>`);
    return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
  }

  // API: learn from website (generate worker config)
  if (req.method === 'POST' && url.pathname === '/api/workers/learn-from-site') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_TINY);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!body.url) return send(res, 400, { error: 'url_required' });
    const checked = await validatePublicHttpUrl(body.url);
    if (!checked.ok) return send(res, 400, { error: 'unsafe_url', reason: checked.error });
    const result = await workers.generateFromUrl(checked.url);
    return send(res, 200, result);
  }

  // API: smart knowledge boilerplate per template
  if (req.method === 'GET' && url.pathname === '/api/workers/smart-knowledge') {
    const templateId = url.searchParams.get('templateId') || '';
    const businessName = cleanText(url.searchParams.get('businessName'), 120) || 'העסק שלי';
    if (!templateId) return send(res, 400, { error: 'templateId_required' });
    return send(res, 200, { knowledge: workers.buildSmartKnowledge(templateId, businessName) });
  }

  // API: list templates
  if (req.method === 'GET' && url.pathname === '/api/workers/templates') {
    return send(res, 200, {
      templates: workers.TEMPLATES.map((t) => ({
        id: t.id, name: t.name, nameHe: t.nameHe, description: t.description,
        icon: t.icon, category: t.category, buyPriceIls: t.buyPriceIls, rentPriceIls: t.rentPriceIls,
        defaultPersona: t.defaultPersona, defaultTasks: t.defaultTasks,
        defaultKnowledge: t.defaultKnowledge, defaultTools: t.defaultTools,
        agentCapabilitiesHe: t.agentCapabilitiesHe ?? '',
        suggestions: workers.getTemplateSuggestions(t.id),
      })),
    });
  }

  // API: buy template (creates worker in pending_payment state)
  if (req.method === 'POST' && url.pathname === '/api/workers/buy') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required', message: 'Send Authorization: Bearer sk_...' });
    const { text: raw } = await readBody(req, BODY_TINY);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!body.templateId) return send(res, 400, { error: 'templateId_required' });
    const res2 = workers.buyTemplate({ tenantId, templateId: body.templateId, paymentChannel: body.paymentChannel, paymentReference: body.paymentReference });
    if (!res2.ok) return send(res, 400, res2);
    return send(res, 200, { ok: true, workerId: res2.workerId, template: { id: res2.template.id, name: res2.template.name, rentPriceIls: res2.template.rentPriceIls }, message: 'Worker instantiated in pending_payment state. Pay via /invoice and ask the admin to mark the worker paid.' });
  }

  // API: create worker from template (used by Builder "new" flow)
  if (req.method === 'POST' && url.pathname === '/api/workers') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_LARGE);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!body.templateId) return send(res, 400, { error: 'templateId_required' });
    const res2 = workers.buyTemplate({ tenantId, templateId: body.templateId });
    if (!res2.ok) return send(res, 400, res2);
    const updated = workers.updateWorker(tenantId, res2.workerId, {
      name: body.name, persona: body.persona, tasks: body.tasks,
      knowledge: body.knowledge, tools: body.tools, agentMode: body.agentMode,
      llm: body.llm ? { provider: body.llm.provider, model: body.llm.model, baseUrl: body.llm.baseUrl } : undefined,
    });
    if (!updated.ok) return send(res, 500, { error: 'update_failed', reason: updated.error, workerId: res2.workerId });
    return send(res, 200, { ok: true, workerId: res2.workerId });
  }

  // API: list my workers
  if (req.method === 'GET' && url.pathname === '/api/workers') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    return send(res, 200, { workers: workers.listWorkers(tenantId) });
  }

  if (req.method === 'GET' && url.pathname === '/api/account') {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    const check = token ? validateApiKey(token) : { valid: false };
    if (!check.valid) return send(res, 401, { error: 'auth_required' });
    return send(res, 200, {
      keyId: check.keyId,
      tenantId: check.tenantId,
      label: check.label,
      plan: check.plan,
      callsUsed: check.calls_used,
      callsLimit: check.calls_limit,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/account/rotate-key') {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    if (!token.startsWith('sk_')) return send(res, 401, { error: 'auth_required' });
    const rotated = rotateApiKey(token);
    if (!rotated.valid) return send(res, 401, { error: 'auth_required', reason: rotated.reason });
    return send(res, 200, {
      ok: true,
      key: rotated.key,
      keyId: rotated.id,
      tenantId: rotated.tenantId,
      oldKeyId: rotated.oldKeyId,
      note: 'Replace your stored key with this new key. The old key has been revoked.',
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/workers/tools') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    return send(res, 200, { tools: workers.getToolCatalog() });
  }

  // API: get worker
  const getWorkerMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)$/);
  if (req.method === 'GET' && getWorkerMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const w = workers.getWorker(tenantId, getWorkerMatch[1]);
    if (!w) return send(res, 404, { error: 'not_found' });
    return send(res, 200, {
      worker: w,
      health: workers.getWorkerHealth(w),
      suggestions: workers.getTemplateSuggestions(w.templateId),
    });
  }

  // API: update worker
  if (req.method === 'PATCH' && getWorkerMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_LARGE);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (body.mcpServers !== undefined) {
      if (!Array.isArray(body.mcpServers) || body.mcpServers.length > 10) return send(res, 400, { error: 'invalid_mcp_servers' });
      const safeServers = [];
      for (const srv of body.mcpServers) {
        const checked = await validatePublicHttpUrl(srv?.url);
        if (!checked.ok) return send(res, 400, { error: 'unsafe_mcp_server_url', reason: checked.error, url: cleanText(srv?.url, 160) });
        safeServers.push({ ...srv, url: checked.url });
      }
      body.mcpServers = safeServers;
    }
    const res2 = workers.updateWorker(tenantId, getWorkerMatch[1], body);
    if (!res2.ok) return send(res, res2.error === 'not_found' ? 404 : 400, res2);
    return send(res, 200, { ok: true });
  }

  // API: delete worker
  if (req.method === 'DELETE' && getWorkerMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const ok = workers.deleteWorker(tenantId, getWorkerMatch[1]);
    if (!ok) return send(res, 404, { error: 'not_found' });
    return send(res, 200, { ok: true });
  }

  // API: list messages
  const msgMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/messages$/);
  if (req.method === 'GET' && msgMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const messages = workers.listMessages(tenantId, msgMatch[1]);
    return send(res, 200, { messages });
  }

  // API: chat with worker (SSE stream)
  const chatStreamMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/chat\/stream$/);
  if (req.method === 'POST' && chatStreamMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_SMALL);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!body.message || typeof body.message !== 'string') return send(res, 400, { error: 'message_required' });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const writeSse = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      await workers.streamChatWithWorker({
        tenantId,
        workerId: chatStreamMatch[1],
        userMessage: body.message,
        customerId: body.customerId ?? '',
        testMode: !!body.testMode,
        demoMode: !!body.demoMode,
      }, writeSse);
    } catch (e) {
      writeSse('error', { message: 'שגיאה בשליחה — נסו שוב בעוד רגע.' });
    }
    res.end();
    return;
  }

  // API: chat with worker
  const chatMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/chat$/);
  if (req.method === 'POST' && chatMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_SMALL);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!body.message || typeof body.message !== 'string') return send(res, 400, { error: 'message_required' });
    const res2 = await workers.chatWithWorker({
      tenantId,
      workerId: chatMatch[1],
      userMessage: body.message,
      customerId: body.customerId ?? '',
      testMode: !!body.testMode,
      demoMode: !!body.demoMode,
    });
    return send(res, res2.status ?? 200, res2);
  }

  const testAgentMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/test-agent$/);
  if (req.method === 'POST' && testAgentMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_LARGE);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!body.message || typeof body.message !== 'string') return send(res, 400, { error: 'message_required' });
    const res2 = await workers.chatWithWorker({ tenantId, workerId: testAgentMatch[1], userMessage: body.message, customerId: body.customerId ?? 'test_customer', testMode: true });
    return send(res, res2.status ?? 200, res2);
  }

  const learnMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/learn-correction$/);
  if (req.method === 'POST' && learnMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_LARGE);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const res2 = workers.learnFromCorrection(tenantId, learnMatch[1], {
      original: body.original,
      corrected: body.corrected,
      userMessage: body.userMessage,
    });
    if (!res2.ok) return send(res, res2.error === 'not_found' ? 404 : 400, res2);
    return send(res, 200, res2);
  }

  // API: Paddle checkout config (client opens Paddle.js overlay)
  if (req.method === 'POST' && url.pathname === '/api/paddle/checkout') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_TINY);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid_json' }); }
    const workerId = String(body.workerId ?? '').trim();
    if (!workerId) return send(res, 400, { error: 'workerId_required' });
    const worker = workers.getWorker(tenantId, workerId);
    if (!worker) return send(res, 404, { error: 'not_found' });
    const cfg = buildPaddleCheckoutConfig({ workerId, tenantId, templateId: worker.templateId });
    return send(res, cfg.ok ? 200 : 400, cfg);
  }

  // API: request activation after payment/proof submission
  const activateMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/activation-request$/);
  if (req.method === 'POST' && activateMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const worker = workers.getWorker(tenantId, activateMatch[1]);
    if (!worker) return send(res, 404, { error: 'not_found' });
    const { text: raw, tooLarge } = await readBody(req, BODY_TINY);
    if (tooLarge) return send(res, 413, { error: 'body_too_large' });
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid_json' }); }
    const contact = cleanText(body.contact, 160);
    if (!contact) return send(res, 400, { error: 'contact_required' });
    const tpl = workers.getTemplate(worker.templateId);
    const req2 = recordActivationRequest({
      tenantId,
      worker,
      channel: body.channel,
      reference: body.reference,
      contact,
      note: body.note,
      amountIls: tpl?.rentPriceIls ?? 0,
    });
    const verify = tryAutoVerifyActivationProof({ reference: body.reference, channel: body.channel });
    if (verify.verified) {
      const activated = autoActivateWorker({
        workerId: worker.id,
        tenantId,
        channel: body.channel || verify.channel,
        reference: body.reference,
        days: DEFAULT_RENT_DAYS,
        amountIls: tpl?.rentPriceIls ?? 0,
        source: 'auto-verify-stub',
      });
      if (activated.ok) {
        markActivationRequestReviewed(req2.id, 'approved');
        return send(res, 200, {
          ok: true,
          requestId: req2.id,
          status: 'approved',
          autoActivated: true,
          paidUntil: activated.paidUntil,
          message: 'Payment auto-verified — worker is now active.',
        });
      }
    }
    return send(res, 200, {
      ok: true,
      requestId: req2.id,
      status: 'pending',
      slaHe: activationSlaTextHe(),
      message: 'Activation request received. Admin review is next.',
    });
  }

  // API: list customer memories for a worker
  const memMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/memories$/);
  if (req.method === 'GET' && memMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const customerId = url.searchParams.get('customerId') ?? '';
    const memories = workers.getCustomerMemories(tenantId, memMatch[1], customerId);
    return send(res, 200, { memories });
  }

  // API: list leads for a worker
  const leadsMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/leads$/);
  if (req.method === 'GET' && leadsMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const leads = workers.getLeads(tenantId, leadsMatch[1]);
    return send(res, 200, { leads });
  }

  const leadsCsvMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/leads\.csv$/);
  if (req.method === 'GET' && leadsCsvMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const leads = workers.getLeads(tenantId, leadsCsvMatch[1]);
    const escCsv = (v) => {
      const s = String(v ?? '');
      return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = 'id,full_name,company,phone,email,notes,created_at\n';
    const body = leads.map((r) => [r.id, r.full_name, r.company, r.phone, r.email, r.notes, r.created_at].map(escCsv).join(',')).join('\n');
    return send(res, 200, header + body, { 'content-type': 'text/csv; charset=utf-8' });
  }

  const escMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/escalations$/);
  if (req.method === 'GET' && escMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const escalations = workers.getEscalations(tenantId, escMatch[1]);
    return send(res, 200, { escalations });
  }

  const escCsvMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/escalations\.csv$/);
  if (req.method === 'GET' && escCsvMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const escCsv = (v) => {
      const s = String(v ?? '');
      return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const escalations = workers.getEscalations(tenantId, escCsvMatch[1]);
    const header = 'id,urgency,reason,status,created_at\n';
    const body = escalations.map((r) => [r.id, r.urgency, r.reason, r.status, r.created_at].map(escCsv).join(',')).join('\n');
    return send(res, 200, header + body, { 'content-type': 'text/csv; charset=utf-8' });
  }

  const insightsMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/insights$/);
  if (req.method === 'GET' && insightsMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const insights = workers.getWorkerInsights(tenantId, insightsMatch[1]);
    if (!insights) return send(res, 404, { error: 'not_found' });
    return send(res, 200, insights);
  }

  const digestMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/weekly-digest$/);
  if (digestMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    if (req.method === 'GET') {
      const digest = workers.getWeeklyDigest(tenantId, digestMatch[1]);
      if (!digest) return send(res, 404, { error: 'not_found' });
      return send(res, 200, digest);
    }
    if (req.method === 'POST') {
      const { text: raw } = await readBody(req, BODY_TINY);
      let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid_json' }); }
      const channel = String(body.channel ?? 'webhook').toLowerCase();
      const digest = workers.getWeeklyDigest(tenantId, digestMatch[1]);
      if (!digest) return send(res, 404, { error: 'not_found' });
      const webhookInt = integrations.getIntegrationsByType(tenantId, 'webhook')[0];
      let delivery = null;
      if (channel === 'webhook' && webhookInt?.config?.hookUrl) {
        try {
          const text = workers.formatWeeklyDigestText(digest);
          const html = workers.formatWeeklyDigestHtml(digest);
          const url = webhookInt.config.hookUrl;
          const res = await urlSecurity.fetchPublicHttpContent(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'weekly_digest',
              workerId: digestMatch[1],
              subject: `סיכום שבועי — ${digest.worker.name}`,
              text,
              html,
              digest,
            }),
          });
          delivery = { ok: res.status >= 200 && res.status < 300, status: res.status };
        } catch (e) {
          delivery = { ok: false, error: e.message };
        }
      } else if (channel === 'webhook' && !webhookInt?.config?.hookUrl) {
        return send(res, 400, { ok: false, error: 'no_webhook_configured' });
      }
      const sentAt = workers.recordWeeklyDigest(tenantId, digestMatch[1], digest, channel);
      return send(res, 200, { ok: true, sentAt, delivery });
    }
    return send(res, 405, { error: 'method_not_allowed' });
  }

  const digestHtmlMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/weekly-digest\.html$/);
  if (req.method === 'GET' && digestHtmlMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const digest = workers.getWeeklyDigest(tenantId, digestHtmlMatch[1]);
    if (!digest) return send(res, 404, { error: 'not_found' });
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(workers.formatWeeklyDigestHtml(digest));
  }

  const waRouteMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/whatsapp-route$/);
  if (req.method === 'POST' && waRouteMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_TINY);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid_json' }); }
    const workerId = waRouteMatch[1];
    const w = workers.getWorker(tenantId, workerId);
    if (!w) return send(res, 404, { error: 'not_found' });
    const route = registerWhatsAppRoute(db, {
      phoneNumberId: body.phoneNumberId,
      twilioTo: body.twilioTo,
      tenantId,
      workerId,
      provider: body.provider || 'meta',
    });
    if (!route.ok) return send(res, 400, route);
    return send(res, 200, { ok: true, phoneKey: route.phoneKey, webhookUrl: `${resolveBaseUrl(req)}/api/webhooks/whatsapp` });
  }

  const outboxMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/outbox$/);
  if (req.method === 'GET' && outboxMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const outbox = workers.getOutbox(tenantId, outboxMatch[1]);
    return send(res, 200, { outbox });
  }

  const followupsMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/followups$/);
  if (req.method === 'GET' && followupsMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    return send(res, 200, { followups: workers.getFollowups(tenantId, followupsMatch[1]) });
  }

  const crmMatch = url.pathname.match(/^\/api\/workers\/([A-Za-z0-9_]+)\/crm-notes$/);
  if (req.method === 'GET' && crmMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    return send(res, 200, { notes: workers.getCrmNotes(tenantId, crmMatch[1]) });
  }

  // API (admin): list all workers across all tenants
  if (req.method === 'GET' && url.pathname === '/api/admin/workers') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    const rows = workers.adminListAllWorkers();
    return send(res, 200, { workers: rows });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    return send(res, 200, { summary: workers.adminSummary() });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/admin/worker-health/')) {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    const workerId = decodeURIComponent(url.pathname.slice('/api/admin/worker-health/'.length));
    const row = workers.adminWorkerHealth(workerId);
    if (!row) return send(res, 404, { error: 'not_found' });
    return send(res, 200, { health: row });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/tenant-stats') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    return send(res, 200, { tenants: workers.adminTenantUsageStats() });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/activation-requests') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    return send(res, 200, { requests: listActivationRequests({ status: url.searchParams.get('status') ?? '' }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/audit-events') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    return send(res, 200, { events: listAdminAuditEvents({ limit: url.searchParams.get('limit') ?? ADMIN_AUDIT_LIMIT }) });
  }

  // API (admin): mark worker paid (extend rental)
  if (req.method === 'POST' && url.pathname === '/api/admin/mark-worker-paid') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'admin_only' });
    const { text: raw } = await readBody(req, BODY_TINY);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!body.workerId || !body.tenantId) return send(res, 400, { error: 'workerId_and_tenantId_required' });
    const activationCheck = validateActivationRequestForPayment({
      id: body.activationRequestId,
      tenantId: body.tenantId,
      workerId: body.workerId,
    });
    if (!activationCheck.ok) {
      recordAdminAudit(req, {
        action: 'admin_mark_worker_paid',
        targetType: 'worker',
        targetId: body.workerId,
        status: 'failed',
        metadata: { tenantId: body.tenantId, activationRequestId: body.activationRequestId, error: activationCheck.error },
      });
      return send(res, 400, activationCheck);
    }
    const res2 = workers.adminMarkPaid({
      workerId: body.workerId, tenantId: body.tenantId,
      days: Number(body.days) || DEFAULT_RENT_DAYS,
      paymentChannel: body.paymentChannel, paymentReference: body.paymentReference,
      amountIls: body.amountIls,
    });
    if (!res2.ok) {
      recordAdminAudit(req, {
        action: 'admin_mark_worker_paid',
        targetType: 'worker',
        targetId: body.workerId,
        status: 'failed',
        metadata: { tenantId: body.tenantId, error: res2.error },
      });
      return send(res, 400, res2);
    }
    markActivationRequestReviewed(body.activationRequestId, 'approved');
    recordAdminAudit(req, {
      action: 'admin_mark_worker_paid',
      targetType: 'worker',
      targetId: body.workerId,
      metadata: {
        tenantId: body.tenantId,
        days: Number(body.days) || DEFAULT_RENT_DAYS,
        paymentChannel: body.paymentChannel,
        paymentReference: body.paymentReference,
        amountIls: body.amountIls,
        activationRequestId: body.activationRequestId,
        paidUntil: res2.paidUntil,
      },
    });
    return send(res, 200, res2);
  }

  // --- MCP & Skills API ---

  // API: discover tools from an MCP server
  if (req.method === 'GET' && url.pathname === '/api/mcp/discover') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const mcpUrl = url.searchParams.get('url');
    if (!mcpUrl) return send(res, 400, { error: 'url_required' });
    const checked = await validatePublicHttpUrl(mcpUrl);
    if (!checked.ok) return send(res, 400, { error: 'unsafe_url', reason: checked.error });
    try {
      const tools = await mcpClient.discoverMcpTools(checked.url, {}, { lookup: pinnedLookup(checked.resolved) });
      return send(res, 200, { server: checked.url, tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) });
    } catch (e) {
      return send(res, 400, { error: 'mcp_discovery_failed', message: e.message });
    }
  }

  // API: list all skills
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    return send(res, 200, { skills: SKILLS });
  }

  // API: install a skill on a worker (adds tools + knowledge to the worker's config)
  if (req.method === 'POST' && url.pathname === '/api/workers/skill-install') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_TINY);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!body.workerId || !body.skillId) return send(res, 400, { error: 'workerId_and_skillId_required' });
    const skill = getSkill(body.skillId);
    if (!skill) return send(res, 400, { error: 'unknown_skill' });
    const w = workers.getWorker(tenantId, body.workerId);
    if (!w) return send(res, 404, { error: 'not_found' });
    const mergedTools = [...new Set([...(w.tools ?? []), ...skill.addTools])];
    const wasInstalled = (w.skills ?? []).includes(skill.id);
    const mergedKnowledge = wasInstalled
      ? (w.knowledge ?? '')
      : (w.knowledge ?? '') + '\n\n' + skill.addKnowledge;
    const mergedSkills = [...new Set([...(w.skills ?? []), skill.id])];
    const res2 = workers.updateWorker(tenantId, body.workerId, { tools: mergedTools, knowledge: mergedKnowledge, skills: mergedSkills });
    return send(res, res2.ok ? 200 : 400, res2);
  }

  // API: uninstall a skill from a worker
  if (req.method === 'POST' && url.pathname === '/api/workers/skill-uninstall') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_TINY);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!body.workerId || !body.skillId) return send(res, 400, { error: 'workerId_and_skillId_required' });
    const w = workers.getWorker(tenantId, body.workerId);
    if (!w) return send(res, 404, { error: 'not_found' });
    const skill = getSkill(body.skillId);
    const filteredTools = skill
      ? (w.tools ?? []).filter((t) => !skill.addTools.includes(t))
      : (w.tools ?? []);
    const mergedSkills = (w.skills ?? []).filter((s) => s !== body.skillId);
    const res2 = workers.updateWorker(tenantId, body.workerId, { tools: filteredTools, skills: mergedSkills });
    return send(res, res2.ok ? 200 : 400, res2);
  }

  // --- Integrations hub ---

  if (req.method === 'GET' && url.pathname === '/api/integrations/catalog') {
    return send(res, 200, {
      catalog: integrations.listEnrichedCatalog(integrations.listCatalog),
      categories: integrations.INTEGRATION_CATEGORIES,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/integrations/oauth/start') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_SMALL);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid_json' }); }
    if (!body.type) return send(res, 400, { error: 'type_required' });
    const result = integrations.createOAuthStart(tenantId, {
      type: body.type,
      returnPath: body.returnPath || '/marketplace',
      extra: body.extra ?? {},
    });
    return send(res, result.ok ? 200 : 400, result);
  }

  if (req.method === 'GET' && url.pathname === '/api/integrations/oauth/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');
    const result = await integrations.handleOAuthCallback({ code, state, error: oauthError });
    if (!result.ok) {
      const failPath = '/marketplace?oauth=error&msg=' + encodeURIComponent(result.messageHe || result.error || 'oauth_failed');
      res.writeHead(302, { location: failPath });
      res.end();
      return;
    }
    res.writeHead(302, { location: result.redirectTo });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/integrations/connect') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_SMALL);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid_json' }); }
    if (!body.type) return send(res, 400, { error: 'type_required' });
    const userConfig = body.config ?? {};
    if (userConfig.url) {
      const checked = await validatePublicHttpUrl(userConfig.url);
      if (!checked.ok) return send(res, 400, { error: 'unsafe_url', reason: checked.error });
    }
    if (userConfig.bookingLink) {
      const checked = await validatePublicHttpUrl(userConfig.bookingLink);
      if (!checked.ok) return send(res, 400, { error: 'unsafe_url', reason: checked.error });
      userConfig.bookingLink = checked.url;
    }
    if (body.type === 'mcp' && userConfig.preset) {
      const preset = MCP_PRESETS[userConfig.preset];
      if (!preset) return send(res, 400, { error: 'unknown_mcp_preset' });
      const result = integrations.connectIntegration(tenantId, {
        type: 'mcp',
        label: preset.labelHe,
        config: { url: preset.url, name: preset.labelHe, authMethod: 'platform', preset: userConfig.preset },
        meta: { connectedVia: 'platform_preset' },
      });
      if (!result.ok) return send(res, 400, result);
      const list = integrations.listIntegrations(tenantId);
      const connected = list.find((i) => i.id === result.id);
      return send(res, result.updated ? 200 : 201, { ok: true, integration: connected, id: result.id });
    }
    const result = integrations.connectWithUserFields(tenantId, body.type, userConfig, { baseUrl: resolveBaseUrl(req) });
    if (!result.ok) return send(res, 400, result);
    const list = integrations.listIntegrations(tenantId);
    const connected = list.find((i) => i.id === result.id);
    if (body.type === 'whatsapp' && body.workerId) {
      const phoneNumberId = userConfig.phoneNumberId || connected?.config?.phoneNumberId;
      const twilioTo = userConfig.twilioFrom || connected?.config?.twilioFrom;
      if (phoneNumberId || twilioTo) {
        registerWhatsAppRoute(db, {
          phoneNumberId,
          twilioTo,
          tenantId,
          workerId: body.workerId,
          provider: userConfig.provider || connected?.config?.provider || 'meta',
        });
      } else if (process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID) {
        registerWhatsAppRoute(db, {
          phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID,
          tenantId,
          workerId: body.workerId,
          provider: 'meta',
        });
      }
    }
    return send(res, result.updated ? 200 : 201, { ok: true, integration: connected, id: result.id, hookUrl: connected?.config?.hookUrl });
  }

  const hookMatch = url.pathname.match(/^\/api\/hooks\/([^/]+)\/([a-f0-9]+)$/);
  if (req.method === 'POST' && hookMatch) {
    const [, tenantId, secret] = hookMatch;
    const row = integrations.getIntegrationsByType(tenantId, 'webhook')[0];
    if (!row || row.config?.secret !== secret) return send(res, 403, { error: 'invalid_hook' });
    const { text: raw } = await readBody(req, BODY_SMALL);
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: String(raw).slice(0, 500) }; }
    return send(res, 200, { ok: true, received: true, at: new Date().toISOString(), type: payload.type ?? 'event' });
  }

  if (req.method === 'GET' && url.pathname === '/api/integrations/mcp/presets') {
    return send(res, 200, { presets: Object.entries(MCP_PRESETS).map(([id, p]) => ({ id, labelHe: p.labelHe, descriptionHe: p.descriptionHe })) });
  }

  if (req.method === 'GET' && url.pathname === '/api/integrations') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    return send(res, 200, { integrations: integrations.listIntegrations(tenantId) });
  }

  if (req.method === 'POST' && url.pathname === '/api/integrations') {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const { text: raw } = await readBody(req, BODY_SMALL);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid_json' }); }
    if (!body.type) return send(res, 400, { error: 'type_required' });
    if (body.config?.url) {
      const checked = await validatePublicHttpUrl(body.config.url);
      if (!checked.ok) return send(res, 400, { error: 'unsafe_url', reason: checked.error });
    }
    if (body.type === 'mcp' && body.config?.url) {
      const checked = await validatePublicHttpUrl(body.config.url);
      if (!checked.ok) return send(res, 400, { error: 'unsafe_mcp_url', reason: checked.error });
    }
    const result = integrations.connectIntegration(tenantId, {
      type: body.type,
      label: body.label,
      config: body.config ?? {},
      meta: body.meta,
    });
    if (!result.ok) return send(res, 400, result);
    const list = integrations.listIntegrations(tenantId);
    const connected = list.find((i) => i.id === result.id);
    return send(res, result.updated ? 200 : 201, { ok: true, integration: connected, id: result.id });
  }

  const intDeleteMatch = url.pathname.match(/^\/api\/integrations\/([A-Za-z0-9_]+)$/);
  if (req.method === 'DELETE' && intDeleteMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const result = integrations.deleteIntegration(tenantId, intDeleteMatch[1]);
    return send(res, result.ok ? 200 : 404, result.ok ? { ok: true } : { error: 'not_found' });
  }

  const intTestMatch = url.pathname.match(/^\/api\/integrations\/([A-Za-z0-9_]+)\/test$/);
  if (req.method === 'POST' && intTestMatch) {
    const tenantId = requireAuth(req);
    if (!tenantId) return send(res, 401, { error: 'auth_required' });
    const result = await integrations.testIntegration(tenantId, intTestMatch[1]);
    return send(res, result.ok ? 200 : 400, result);
  }

  if (req.method === 'GET' && url.pathname === '/analytics-client.js') {
    try {
      const content = fs.readFileSync(path.join(__dirname, 'analytics-client.js'), 'utf8');
      return send(res, 200, content, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public,max-age=' + ASSETS_CACHE_MAX_AGE });
    } catch {
      return send(res, 404, { error: 'not_found', path: url.pathname });
    }
  }
  if (req.method === 'GET' && url.pathname === '/vendor/vercel-analytics.mjs') {
    const vendorPath = path.resolve(__dirname, 'node_modules', '@vercel', 'analytics', 'dist', 'index.mjs');
    const vendorRoot = path.resolve(__dirname, 'node_modules', '@vercel', 'analytics');
    if (!vendorPath.startsWith(vendorRoot)) return send(res, 403, { error: 'forbidden' });
    try {
      const content = fs.readFileSync(vendorPath, 'utf8');
      return send(res, 200, content, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public,max-age=31536000' });
    } catch {
      return send(res, 404, { error: 'not_found', path: url.pathname });
    }
  }

  // Serve tenant media assets (unguessable filenames — public read)
  if (req.method === 'GET' && url.pathname.startsWith('/api/media/public/')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const pathTenantId = parts[3];
    const filename = parts[4];
    if (!pathTenantId || !filename) return send(res, 400, { error: 'bad_request' });
    const filePath = workers.resolveMediaFile(pathTenantId, filename);
    if (!filePath) return send(res, 404, { error: 'not_found' });
    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = {
        '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.mp4': 'video/mp4',
      };
      res.writeHead(200, { 'content-type': mime[ext] || 'application/octet-stream', 'cache-control': 'public,max-age=86400' });
      res.end(content);
    } catch {
      return send(res, 404, { error: 'not_found' });
    }
    return;
  }

  // Serve static assets from ./assets/
  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const rawPath = path.join(__dirname, url.pathname);
    const filePath = path.resolve(rawPath);
    const assetsDir = path.resolve(path.join(__dirname, 'assets'));
    if (!filePath.startsWith(assetsDir)) return send(res, 403, { error: 'forbidden' });
    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = { '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.gif':'image/gif', '.ico':'image/x-icon', '.webp':'image/webp', '.css':'text/css; charset=utf-8' };
      res.writeHead(200, { 'content-type': mime[ext] || 'application/octet-stream', 'cache-control': 'public,max-age=' + ASSETS_CACHE_MAX_AGE });
      res.end(content);
    } catch {
      return send(res, 404, { error: 'not_found', path: url.pathname });
    }
    return;
  }

  return send(res, 404, { error: 'not_found', path: url.pathname });
});

workers.setServerLlmConfig({
  apiKey: LLM_API_KEY, provider: LLM_PROVIDER,
  model: LLM_MODEL, baseUrl: LLM_BASE_URL,
});
console.log(`${AGENT_NAME} — platform-provided LLM (no BYOK)`);
if (LLM_API_KEY) console.log(`  LLM: ${LLM_PROVIDER} / ${LLM_MODEL} (configured)`);
else console.warn(`  WARN: no LLM_API_KEY set — workers will use mock replies`);

function startServer() {
  server.listen(PORT, () => {
    console.log(`${AGENT_NAME} listening on ${PUBLIC_BASE_URL}`);
    console.log(`  Marketplace: ${PUBLIC_BASE_URL}/marketplace`);
    console.log(`  Payment channels:`);
    if (PAYPAL_ME) console.log(`    - PayPal.me/${PAYPAL_ME}`);
    if (BUY_ME_A_COFFEE) console.log(`    - Buy Me a Coffee: ${BUY_ME_A_COFFEE}`);
    if (KO_FI) console.log(`    - Ko-fi: ${KO_FI}`);
    if (BIT_PHONE) console.log(`    - Bit: ${BIT_PHONE}`);
    if (GITHUB_SPONSORS) console.log(`    - GitHub Sponsors: ${GITHUB_SPONSORS}`);
    if (GUMROAD_URL) console.log(`    - Gumroad: ${GUMROAD_URL}`);
    if (BANK_ACCOUNT) console.log(`    - Bank transfer: ${BANK_NAME} branch ${BANK_BRANCH} acct ${BANK_ACCOUNT}`);
    console.log(`  Admin: ${ADMIN_TOKEN ? 'ENABLED' : 'DISABLED (set ADMIN_TOKEN to enable)'}`);
    console.log(`  Invoice: ${PUBLIC_BASE_URL}/invoice`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { console.log(`\n${sig}, shutting down`); server.close(() => { db.close(); process.exit(0); }); });
  }
}

// Vercel serverless: export the HTTP server; do not bind a port.
export default server;
if (!process.env.VERCEL) startServer();
