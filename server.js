// Minimal paid AI agent — Israel-friendly edition.
//
// Three payment paths:
//   1. x402 / USDC          (crypto, for AI agents)
//   2. PayPal.me / Bit / Buy Me a Coffee / bank invoice / Ko-fi
//                            (oldschool, no business needed in Israel)
//   3. Free with API key    (issued after off-platform payment)
//
// Auth on POST /entrypoints/:key/invoke:
//   - Authorization: Bearer sk_...  -> consumes one API key credit
//   - X-PAYMENT: <x402 proof>       -> verifies on-chain USDC payment
//   - otherwise                     -> 402 with both options listed
//
// ENV:
//   PORT=3000
//   NETWORK=base-sepolia                 (x402 only)
//   WALLET_ADDRESS=0x...                 (x402 receiver)
//   PRICE_USDC=0.05                      (x402 default price)
//   FACILITATOR_URL=https://x402.org/facilitator
//   PUBLIC_BASE_URL=https://your.host
//   AGENT_NAME, AGENT_DESCRIPTION, AGENT_VERSION, AGENT_OWNER_CONTACT
//
//   -- Tip jar / contact (any combination) --
//   PAYPAL_ME=razel                                 -> https://paypal.me/razel
//   BUY_ME_A_COFFEE=https://buymeacoffee.com/razel
//   KO_FI=https://ko-fi.com/razel
//   BIT_PHONE=972541234567                         -> shows a Bit payment link
//   GITHUB_SPONSORS=razel                           -> https://github.com/sponsors/razel
//   GUMROAD_URL=https://razel.gumroad.com/l/paid-agent
//
//   -- Bank invoice (Israeli-friendly) --
//   PAYEE_NAME=Razel M.
//   BANK_NAME=Bank Hapoalim
//   BANK_BRANCH=620
//   BANK_ACCOUNT=123456
//   IBAN=IL62...  (optional, for cross-border)
//   SWIFT=POALILIT  (optional)
//
//   -- Admin (issue API keys after off-platform payment) --
//   ADMIN_TOKEN=some-long-random-string
//   DB_PATH=./data/earnings.db

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);
const NETWORK = process.env.NETWORK ?? 'base-sepolia';
const PRICE_USDC = process.env.PRICE_USDC ?? '0.05';
const WALLET_ADDRESS = process.env.WALLET_ADDRESS ?? '';
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? '';
const PAYMENT_MODE = process.env.PAYMENT_MODE ?? (FACILITATOR_URL ? 'live' : 'mock');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const AGENT_NAME = process.env.AGENT_NAME ?? 'Paid Agent Demo';
const AGENT_DESCRIPTION = process.env.AGENT_DESCRIPTION ?? 'AI agent with x402 (USDC) and oldschool payment options.';
const AGENT_VERSION = process.env.AGENT_VERSION ?? '0.4.0';
const AGENT_OWNER_CONTACT = process.env.AGENT_OWNER_CONTACT ?? '';
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 120);
const DB_PATH = process.env.DB_PATH ?? join(__dirname, 'data', 'earnings.db');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

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

// --- USDC config ----------------------------------------------------------

const USDC_ADDRESSES = {
  'base':           { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  'base-sepolia':   { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 },
  'ethereum':       { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  'sepolia':        { address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6 },
  'polygon':        { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  'solana':         { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
};

const NETWORK_META = {
  'base':         { chainId: 8453,     scheme: 'exact', tokenStandard: 'ERC-20' },
  'base-sepolia': { chainId: 84532,    scheme: 'exact', tokenStandard: 'ERC-20' },
  'ethereum':     { chainId: 1,        scheme: 'exact', tokenStandard: 'ERC-20' },
  'sepolia':      { chainId: 11155111, scheme: 'exact', tokenStandard: 'ERC-20' },
  'polygon':      { chainId: 137,      scheme: 'exact', tokenStandard: 'ERC-20' },
  'solana':       { chainId: 101,      scheme: 'exact', tokenStandard: 'SPL'  },
};

function priceToAtomic(usdc) {
  const m = USDC_ADDRESSES[NETWORK] ?? USDC_ADDRESSES['base-sepolia'];
  return String(BigInt(Math.round(parseFloat(usdc) * 10 ** m.decimals)));
}

function buildPaymentRequirements(resourcePath) {
  const cfg = NETWORK_META[NETWORK];
  if (!cfg) throw new Error(`Unsupported network: ${NETWORK}`);
  const m = USDC_ADDRESSES[NETWORK] ?? USDC_ADDRESSES['base-sepolia'];
  return {
    x402Version: 1,
    accepts: [{
      scheme: cfg.scheme, network: NETWORK, chainId: cfg.chainId, tokenStandard: cfg.tokenStandard,
      maxAmountRequired: priceToAtomic(PRICE_USDC), resource: resourcePath,
      description: `${AGENT_NAME} \u2014 paid endpoint`, mimeType: 'application/json',
      payTo: WALLET_ADDRESS,
      extra: { name: 'USD Coin', version: '2', asset: m.address },
    }],
  };
}

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
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
`);

// --- Helpers --------------------------------------------------------------

const newId = (p) => `${p}_${crypto.randomBytes(16).toString('hex')}`;
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

function recordCall(o) {
  db.prepare('INSERT INTO calls (at, endpoint, network, amount_usdc, payer, tx_hash, mock, input_chars, auth_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    new Date().toISOString(), o.endpoint, o.network, o.amountUsdc, o.payer, o.txHash, o.mock ? 1 : 0, o.inputChars, o.authMethod
  );
}
function recordTip(o) {
  db.prepare('INSERT INTO tips (at, channel, amount, note, donor) VALUES (?, ?, ?, ?, ?)').run(new Date().toISOString(), o.channel, o.amount ?? null, o.note ?? null, o.donor ?? null);
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

// --- Entrypoints ----------------------------------------------------------

const entrypoints = [
  { key: 'summarize', description: 'Condense long text into a short summary.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    handler: async ({ text }) => {
      const w = String(text ?? '').trim().split(/\s+/).filter(Boolean);
      return { summary: w.slice(0, 25).join(' ') + (w.length > 25 ? '...' : ''), wordCount: w.length };
    } },
  { key: 'translate', description: 'Translate text. Stub.',
    inputSchema: { type: 'object', required: ['text', 'to'], properties: { text: { type: 'string' }, to: { type: 'string' } } },
    handler: async ({ text, to }) => ({ translation: `[${to}] ${text}`, targetLang: to }) },
  { key: 'sentiment', description: 'Score sentiment on -1..1.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    handler: async ({ text }) => {
      const pos=['good','great','love','awesome','excellent','happy','win'], neg=['bad','hate','terrible','awful','sad','lose','bug'];
      const lower=String(text??'').toLowerCase();
      const s=pos.reduce((n,w)=>n+(lower.includes(w)?0.2:0),0)-neg.reduce((n,w)=>n+(lower.includes(w)?0.2:0),0);
      return { score: Math.max(-1,Math.min(1,Number(s.toFixed(2)))), label: s>0.1?'positive':s<-0.1?'negative':'neutral' };
    } },
  { key: 'extract-entities', description: 'Pull capitalized noun phrases.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    handler: async ({ text }) => {
      const m = String(text ?? '').match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [];
      const u = [...new Set(m)];
      return { entities: u.slice(0, 50), count: u.length };
    } },
  { key: 'word-count', description: 'Free-tier stats.', priceUsdc: '0.001',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    handler: async ({ text }) => {
      const s = String(text ?? '');
      const w = s.trim().split(/\s+/).filter(Boolean);
      return { chars: s.length, words: w.length, sentences: (s.match(/[.!?]+/g)??[]).length, paragraphs: s.split(/\n\s*\n/).filter(Boolean).length, readingMinutes: Math.max(1, Math.round(w.length / 220)) };
    } },
];
const findEntrypoint = (k) => entrypoints.find((e) => e.key === k);

// --- x402 verification ----------------------------------------------------

async function verifyPayment(reqs, header) {
  if (PAYMENT_MODE === 'mock') return { valid: true, payer: '0xMOCK' + crypto.randomBytes(8).toString('hex'), txHash: '0xMOCKTX' + crypto.randomBytes(24).toString('hex'), mock: true };
  if (!FACILITATOR_URL) return { valid: false, reason: 'no facilitator' };
  const res = await fetch(`${FACILITATOR_URL}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x402Version: 1, paymentHeader: header, paymentRequirements: reqs }) });
  if (!res.ok) return { valid: false, reason: `facilitator ${res.status}` };
  const j = await res.json();
  return { valid: !!j.isValid, payer: j.payer, txHash: j.transaction ?? j.txHash, mock: false };
}

// --- API keys -------------------------------------------------------------

function issueApiKey({ plan, callsLimit, paymentChannel, paymentReference, label }) {
  const key = newId('sk');
  const id = newId('key');
  db.prepare(
    `INSERT INTO api_keys (id, key_hash, label, plan, calls_limit, calls_used, period_start, payment_channel, payment_reference, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
  ).run(id, hashKey(key), label ?? 'Customer', plan, callsLimit, new Date().toISOString(), paymentChannel ?? 'manual', paymentReference ?? null, new Date().toISOString());
  return { id, key };
}
function consumeApiCall(kh) {
  const r = db.prepare('SELECT id, calls_used, calls_limit, plan, label FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(kh);
  if (!r) return { valid: false, reason: 'unknown_key' };
  if (r.calls_used >= r.calls_limit) return { valid: false, reason: 'quota_exceeded', used: r.calls_used, limit: r.calls_limit };
  db.prepare('UPDATE api_keys SET calls_used = calls_used + 1 WHERE id = ?').run(r.id);
  return { valid: true, plan: r.plan, used: r.calls_used + 1, limit: r.calls_limit, label: r.label };
}

// --- HTTP helpers ---------------------------------------------------------

function send(res, status, body, h = {}) {
  let payload; const ct = h['content-type'] ?? 'application/json';
  if (ct === 'application/json' && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body)) payload = JSON.stringify(body, null, 2);
  else if (typeof body === 'string' || Buffer.isBuffer(body)) payload = body;
  else payload = '';
  res.writeHead(status, {
    'content-type': ct, 'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-payment, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    ...h,
  });
  res.end(payload);
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

// Resolve the public base URL for the current request.
// Trusts X-Forwarded-* headers (set by Cloudflare Tunnel, Fly, Render, Railway)
// so the dashboard and invoice always show the real public URL, not localhost.
function resolveBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  if (host) return `${proto}://${host}`;
  return PUBLIC_BASE_URL;
}
async function readBody(req, max = 1024 * 64) {
  const cs = []; let t = 0;
  for await (const c of req) { t += c.length; if (t > max) return { tooLarge: true }; cs.push(c); }
  return { text: Buffer.concat(cs).toString('utf8') };
}

// --- A2A Agent Card -------------------------------------------------------

function buildAgentCard(baseUrl = PUBLIC_BASE_URL) {
  const skills = entrypoints.map((e) => ({
    id: e.key, name: e.key.replace(/-/g, ' '), description: e.description,
    inputSchema: e.inputSchema, outputSchema: { type: 'object' },
    pricing: {
      model: 'per-call',
      amount: e.priceUsdc ?? PRICE_USDC,
      currency: e.priceUsdc ? 'USDC' : 'USD',
      network: e.priceUsdc ? NETWORK : null,
      payTo: e.priceUsdc ? WALLET_ADDRESS : null,
      alternativeAuth: 'api-key',
      protocol: e.priceUsdc ? 'x402' : 'https',
      note: e.priceUsdc ? null : 'Pay via PayPal.me / Bit / bank invoice, then admin issues an API key.',
    },
  }));
  return {
    schema: 'a2a-agent-card/v1',
    name: AGENT_NAME, description: AGENT_DESCRIPTION, version: AGENT_VERSION,     url: baseUrl,
    provider: { organization: AGENT_NAME, contact: AGENT_OWNER_CONTACT || undefined },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    authentication: {
      schemes: ['x402-usdc', 'bearer-api-key'],
      x402: { network: NETWORK, payTo: WALLET_ADDRESS, facilitator: FACILITATOR_URL || null, defaultPriceUsdc: PRICE_USDC },
      apiKey: { acquireVia: buildAcquireChannels() },
    },
    skills, defaultInputModes: ['text'], defaultOutputModes: ['json'],
  };
}

function buildAcquireChannels() {
  const list = [];
  if (PAYPAL_ME) list.push({ kind: 'paypal', url: `https://paypal.me/${PAYPAL_ME}`, howToGetKey: 'Pay any amount, send screenshot to ' + (AGENT_OWNER_CONTACT || 'owner'), note: 'API key issued within 24h' });
  if (BUY_ME_A_COFFEE) list.push({ kind: 'buymeacoffee', url: BUY_ME_A_COFFEE });
  if (KO_FI) list.push({ kind: 'kofi', url: KO_FI });
  if (BIT_PHONE) list.push({ kind: 'bit', url: `https://www.bitpay.co.il/app/me/${BIT_PHONE.replace(/\D/g,'')}`, phone: BIT_PHONE });
  if (GITHUB_SPONSORS) list.push({ kind: 'github-sponsors', url: `https://github.com/sponsors/${GITHUB_SPONSORS}` });
  if (GUMROAD_URL) list.push({ kind: 'gumroad', url: GUMROAD_URL });
  if (BANK_ACCOUNT) list.push({ kind: 'bank-transfer', payee: PAYEE_NAME, bank: BANK_NAME, branch: BANK_BRANCH, account: BANK_ACCOUNT, iban: IBAN || null, swift: SWIFT || null, note: 'Israeli-friendly bank transfer (masheh)' });
  return list;
}

// --- Plans (oldschool, manually issued) -----------------------------------

const PLANS = [
  { id: 'credits-100', name: '100 calls', callsLimit: 100,  priceIls: 18, priceUsd: 5 },
  { id: 'monthly-1k', name: '1,000 calls / month', callsLimit: 1000, priceIls: 35, priceUsd: 9, recurring: 'monthly' },
  { id: 'power-10k',  name: '10,000 calls / month', callsLimit: 10000, priceIls: 280, priceUsd: 75, recurring: 'monthly' },
];

// --- HTML pages -----------------------------------------------------------

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function buildDashboard(baseUrl = PUBLIC_BASE_URL) {
  const channels = buildAcquireChannels();
  const channelButtons = channels.map((c) => {
    if (c.kind === 'paypal') return `<a class="plan" href="${escapeHtml(c.url)}" target="_blank" rel="noopener"><div class="muted">PayPal</div><div class="price">any amount</div><div class="muted">paypal.me/${escapeHtml(PAYPAL_ME)}</div></a>`;
    if (c.kind === 'buymeacoffee') return `<a class="plan" href="${escapeHtml(c.url)}" target="_blank" rel="noopener"><div class="muted">Buy Me a Coffee</div><div class="price">tip jar</div><div class="muted">${escapeHtml(c.url)}</div></a>`;
    if (c.kind === 'kofi') return `<a class="plan" href="${escapeHtml(c.url)}" target="_blank" rel="noopener"><div class="muted">Ko-fi</div><div class="price">tip jar</div><div class="muted">${escapeHtml(c.url)}</div></a>`;
    if (c.kind === 'bit') return `<a class="plan" href="${escapeHtml(c.url)}" target="_blank" rel="noopener"><div class="muted">Bit (Israeli)</div><div class="price">QR / link</div><div class="muted">${escapeHtml(c.phone)}</div></a>`;
    if (c.kind === 'github-sponsors') return `<a class="plan" href="${escapeHtml(c.url)}" target="_blank" rel="noopener"><div class="muted">GitHub Sponsors</div><div class="price">monthly</div><div class="muted">github.com/sponsors/${escapeHtml(GITHUB_SPONSORS)}</div></a>`;
    if (c.kind === 'gumroad') return `<a class="plan" href="${escapeHtml(c.url)}" target="_blank" rel="noopener"><div class="muted">Gumroad (one-time)</div><div class="price">template</div><div class="muted">${escapeHtml(c.url)}</div></a>`;
    if (c.kind === 'bank-transfer') return `<div class="plan"><div class="muted">Bank transfer (masheh)</div><div style="font-size:13px;line-height:1.7"><b>${escapeHtml(c.payee || '')}</b><br>${escapeHtml(c.bank || '')} \u2014 branch ${escapeHtml(c.branch || '')}<br>Account: <code>${escapeHtml(c.account || '')}</code>${c.iban ? `<br>IBAN: <code>${escapeHtml(c.iban)}</code>` : ''}${c.swift ? `<br>SWIFT: <code>${escapeHtml(c.swift)}</code>` : ''}</div><div class="muted">Send screenshot to ${escapeHtml(AGENT_OWNER_CONTACT || 'owner')}</div></div>`;
    return '';
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(AGENT_NAME)}</title>
  <style>
    :root { color-scheme: dark; }
    body { font: 14px/1.5 system-ui, -apple-system, sans-serif; max-width: 960px; margin: 32px auto; padding: 0 16px; background: #0b0b10; color: #e7e7ea; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .sub { color: #9aa0a6; margin-bottom: 24px; }
    .card { background: #15151c; border: 1px solid #2a2a35; border-radius: 12px; padding: 16px 18px; margin: 14px 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .stat { background: #15151c; border: 1px solid #2a2a35; border-radius: 12px; padding: 14px; }
    .stat .v { font-size: 22px; font-weight: 700; }
    .stat .k { color: #9aa0a6; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    code { background: #0f0f15; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    pre { background: #0f0f15; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
    a { color: #7cc4ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #2a2a35; font-size: 12px; margin-right: 4px; }
    .pill.live { background: #143a1f; color: #6ff09d; }
    .pill.mock { background: #3a1f14; color: #ffaa6f; }
    button { background: #2a2a35; color: #e7e7ea; border: 0; padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; }
    button:hover { background: #3a3a48; }
    button.primary { background: #2563eb; }
    button.primary:hover { background: #1d4ed8; }
    textarea { width: 100%; box-sizing: border-box; background: #0f0f15; color: #e7e7ea; border: 1px solid #2a2a35; border-radius: 6px; padding: 8px; font: inherit; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .muted { color: #9aa0a6; font-size: 12px; }
    .err { color: #ff8a8a; }
    .ok { color: #6ff09d; }
    .pricing { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .plan { display: block; border: 1px solid #2a2a35; border-radius: 12px; padding: 16px; background: #0f0f15; }
    .plan .price { font-size: 22px; font-weight: 700; margin: 4px 0; }
    .plan:hover { border-color: #3a3a48; }
  </style>
</head>
<body>
  <h1>${escapeHtml(AGENT_NAME)}</h1>
  <div class="sub">${escapeHtml(AGENT_DESCRIPTION)}</div>
  <div class="row" style="margin-bottom: 16px">
    <span class="pill ${PAYMENT_MODE === 'live' ? 'live' : 'mock'}">x402: ${PAYMENT_MODE}</span>
    <span class="pill">${escapeHtml(NETWORK)}</span>
    <span class="pill">${escapeHtml(PRICE_USDC)} USDC/call</span>
    <span class="pill">v${escapeHtml(AGENT_VERSION)}</span>
  </div>

  <div class="grid" id="stats">
    <div class="stat"><div class="k">Total calls</div><div class="v" id="s-calls">-</div></div>
    <div class="stat"><div class="k">USDC received</div><div class="v" id="s-usdc">-</div></div>
    <div class="stat"><div class="k">Unique payers</div><div class="v" id="s-payers">-</div></div>
    <div class="stat"><div class="k">Tips</div><div class="v" id="s-tips">-</div></div>
  </div>

  <div class="card">
    <h3 style="margin-top:0">Pay for API access (oldschool, no Stripe needed)</h3>
    <div class="muted" style="margin-bottom:12px">Pick any channel. After payment, the owner emails you an API key within 24h. Or use x402 below for instant access.</div>
    <div class="pricing" style="margin-bottom:14px">
      ${PLANS.map((p) => `<div class="plan">
        <div class="muted">${escapeHtml(p.name)}</div>
        <div class="price">${escapeHtml(String(p.priceIls))} ILS${p.recurring ? ' / ' + escapeHtml(p.recurring) : ''} <span style="font-size:13px;color:#9aa0a6">(~$${p.priceUsd})</span></div>
        <div class="muted">plan id: <code>${escapeHtml(p.id)}</code></div>
      </div>`).join('')}
    </div>
    <div class="pricing">${channelButtons}</div>
    <div class="muted" style="margin-top:10px">Pay via any channel above, then email <code>${escapeHtml(AGENT_OWNER_CONTACT || AGENT_OWNER_CONTACT || 'owner')}</code> with the plan id and payment proof. You'll get an API key like <code>sk_abc123...</code> to call this agent.</div>
  </div>

  <div class="card">
    <h3 style="margin-top:0">Pay per call (x402 / USDC, instant)</h3>
    <div class="muted" style="margin-bottom:8px">No signup. Any AI agent or x402 client can call this directly.</div>
    <pre>curl -X POST ${escapeHtml(baseUrl)}/entrypoints/summarize/invoke \\
  -H "x-payment: &lt;x402-payment-proof&gt;" \\
  -H "content-type: application/json" \\
  -d '{"text":"hello world"}'</pre>
    <div class="muted">Per call: <b>${escapeHtml(PRICE_USDC)} USDC</b> on <b>${escapeHtml(NETWORK)}</b> to <code>${escapeHtml(WALLET_ADDRESS || '<set WALLET_ADDRESS>')}</code></div>
  </div>

  <div class="card">
    <h3 style="margin-top:0">Try an endpoint (mock-paid)</h3>
    <div class="muted" style="margin-bottom:6px">In mock mode, any <code>x-payment</code> header is accepted.</div>
    <div class="row" style="margin-bottom:8px">
      <select id="ep" style="background:#0f0f15;color:#e7e7ea;border:1px solid #2a2a35;border-radius:6px;padding:6px"></select>
    </div>
    <textarea id="ep-input" placeholder='{"text":"hello world"}'></textarea>
    <div style="margin-top:8px"><button id="ep-go">Invoke</button> <span id="ep-out" class="muted"></span></div>
  </div>

  <div class="card">
    <h3 style="margin-top:0">For AI agents (discoverability)</h3>
    <ul style="margin:0;padding-left:18px">
      <li><a href="/.well-known/agent.json">/.well-known/agent.json</a> (A2A agent card)</li>
      <li><a href="/requirements">/requirements</a> (x402 payment requirements)</li>
      <li><a href="/billing/plans">/billing/plans</a> (plans + payment channels)</li>
      <li><a href="/invoice">/invoice</a> (text invoice with bank details)</li>
      <li><a href="/earnings.csv">/earnings.csv</a> (accounting export)</li>
    </ul>
  </div>

  <script>
    async function loadStats() {
      try {
        const r = await fetch('/earnings'); const j = await r.json();
        document.getElementById('s-calls').textContent = j.summary?.totalCalls ?? 0;
        document.getElementById('s-usdc').textContent = (j.summary?.totalUsdcReceived ?? 0) + ' USDC';
        document.getElementById('s-payers').textContent = j.summary?.uniquePayers ?? 0;
        document.getElementById('s-tips').textContent = j.summary?.tipCount ?? 0;
        const epSel = document.getElementById('ep');
        if (!epSel.options.length) {
          const card = await (await fetch('/.well-known/agent.json')).json();
          for (const s of card.skills) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.id; epSel.appendChild(o); }
        }
      } catch (e) { console.error(e); }
    }
    document.getElementById('ep-go').onclick = async () => {
      const ep = document.getElementById('ep').value;
      const inp = document.getElementById('ep-input').value;
      const out = document.getElementById('ep-out');
      out.textContent = '...';
      try {
        const r = await fetch('/entrypoints/' + ep + '/invoke', { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': 'mock' }, body: inp });
        const j = await r.json();
        out.className = r.ok ? 'ok' : 'err';
        out.textContent = (r.ok ? '\u2713 ' : '\u2717 ') + r.status + ' \u2014 ' + JSON.stringify(j).slice(0, 240);
        loadStats();
      } catch (e) { out.className = 'err'; out.textContent = String(e); }
    };
    loadStats(); setInterval(loadStats, 5000);
  </script>
</body>
</html>`;
}

function buildInvoiceText(baseUrl = PUBLIC_BASE_URL) {
  const lines = [];
  lines.push(`INVOICE / HATZAMAT HESHBON`);
  lines.push('='.repeat(60));
  lines.push(`From:    ${AGENT_NAME}`);
  if (PAYEE_NAME) lines.push(`Payee:   ${PAYEE_NAME}`);
  if (AGENT_OWNER_CONTACT) lines.push(`Email:   ${AGENT_OWNER_CONTACT}`);
  if (baseUrl) lines.push(`URL:     ${baseUrl}`);
  lines.push(`Date:    ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('SERVICES');
  lines.push('-'.repeat(60));
  for (const p of PLANS) {
    lines.push(`  ${p.name.padEnd(30)}  ${String(p.priceIls).padStart(6)} ILS  (~$${p.priceUsd})  ${p.recurring ?? 'one-time'}`);
    lines.push(`     plan id: ${p.id}`);
  }
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
    lines.push('  Reference:    include the plan id (e.g. "monthly-1k") so I can match the payment.');
    lines.push('');
  }
  lines.push('HOW TO GET YOUR API KEY');
  lines.push('-'.repeat(60));
  lines.push(`  1. Pay via any channel above.`);
  lines.push(`  2. Send the payment confirmation + plan id to ${AGENT_OWNER_CONTACT || 'the owner'}.`);
  lines.push(`  3. You'll receive an API key (sk_...) within 24 hours.`);
  lines.push(`  4. Use it:  curl -H "authorization: Bearer sk_..." \\`);
  lines.push(`                ${baseUrl}/entrypoints/summarize/invoke ...`);
  return lines.join('\n');
}

// --- Admin ----------------------------------------------------------------

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return crypto.timingSafeEqual(Buffer.from(auth.slice(7)), Buffer.from(ADMIN_TOKEN));
  // Also allow ?token=... in query for easy curl from terminal
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get('token') === ADMIN_TOKEN;
}

// --- Routes ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (!rateLimit(clientIp(req))) return send(res, 429, { error: 'rate_limited' });

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, buildDashboard(resolveBaseUrl(req)), { 'content-type': 'text/html; charset=utf-8' });
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      ok: true, agent: AGENT_NAME, version: AGENT_VERSION, network: NETWORK,
      paymentMode: PAYMENT_MODE, priceUsdc: PRICE_USDC, walletAddress: WALLET_ADDRESS || null,
      channels: buildAcquireChannels().map((c) => c.kind),
      adminEnabled: !!ADMIN_TOKEN,
      publicBaseUrl: resolveBaseUrl(req),
    });
  }
  if (req.method === 'GET' && url.pathname === '/.well-known/agent.json') return send(res, 200, buildAgentCard(resolveBaseUrl(req)));
  if (req.method === 'GET' && url.pathname === '/requirements') return send(res, 200, buildPaymentRequirements('/entrypoints/*/invoke'));
  if (req.method === 'GET' && url.pathname === '/earnings') return send(res, 200, { agent: AGENT_NAME, summary: getEarningsSummary(), recent: getRecentCalls(50) });
  if (req.method === 'GET' && url.pathname === '/earnings.csv') {
    const rows = getRecentCalls(1000);
    const header = 'id,at,endpoint,network,amount_usdc,payer,tx_hash,mock,input_chars,auth_method\n';
    const body = rows.map((r) => [r.id, r.at, r.endpoint, r.network, r.amountUsdc, r.payer, r.txHash, r.mock, r.inputChars, r.authMethod].join(',')).join('\n');
    return send(res, 200, header + body, { 'content-type': 'text/csv; charset=utf-8' });
  }
  if (req.method === 'GET' && url.pathname === '/billing/plans') {
    return send(res, 200, { plans: PLANS, channels: buildAcquireChannels() });
  }
  if (req.method === 'GET' && url.pathname === '/invoice') {
    return send(res, 200, buildInvoiceText(resolveBaseUrl(req)), { 'content-type': 'text/plain; charset=utf-8' });
  }
  if (req.method === 'GET' && url.pathname === '/invoice.txt') return send(res, 200, buildInvoiceText(resolveBaseUrl(req)), { 'content-type': 'text/plain; charset=utf-8' });

  // Admin: issue an API key after off-platform payment
  if (req.method === 'POST' && url.pathname === '/admin/issue-key') {
    if (!isAdmin(req)) return send(res, 401, { error: 'admin_only' });
    const { text: raw } = await readBody(req, 1024 * 16);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const plan = PLANS.find((p) => p.id === body.planId);
    if (!plan) return send(res, 400, { error: 'unknown_plan', planIds: PLANS.map((p) => p.id) });
    const issued = issueApiKey({
      plan: plan.id, callsLimit: plan.callsLimit,
      paymentChannel: body.channel ?? 'manual', paymentReference: body.reference ?? null,
      label: body.label ?? `${plan.name} (${body.channel ?? 'manual'})`,
    });
    return send(res, 200, { ok: true, key: issued.key, keyId: issued.id, plan: plan.id, callsLimit: plan.callsLimit, note: 'Send this key to the customer once. They will use it as: authorization: Bearer <key>' });
  }

  // Admin: list issued keys (no secrets)
  if (req.method === 'GET' && url.pathname === '/admin/keys') {
    if (!isAdmin(req)) return send(res, 401, { error: 'admin_only' });
    const rows = db.prepare(
      `SELECT id, label, plan, calls_limit AS callsLimit, calls_used AS callsUsed,
              payment_channel AS paymentChannel, payment_reference AS paymentReference,
              created_at AS createdAt, revoked_at AS revokedAt
       FROM api_keys ORDER BY created_at DESC LIMIT 200`
    ).all();
    return send(res, 200, { keys: rows });
  }

  // Admin: revoke a key
  if (req.method === 'POST' && url.pathname === '/admin/revoke') {
    if (!isAdmin(req)) return send(res, 401, { error: 'admin_only' });
    const { text: raw } = await readBody(req, 1024 * 16);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!body.keyId) return send(res, 400, { error: 'keyId_required' });
    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), body.keyId);
    return send(res, 200, { ok: true });
  }

  // Tip jar endpoint (records a tip; doesn't issue a key)
  if (req.method === 'POST' && url.pathname === '/tip') {
    const { text: raw } = await readBody(req, 1024 * 16);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    recordTip({ channel: body.channel ?? 'unknown', amount: body.amount, note: body.note, donor: body.donor });
    return send(res, 200, { ok: true, thanks: true });
  }

  // Entrypoint invocation
  const epMatch = url.pathname.match(/^\/entrypoints\/([a-z0-9-]+)\/invoke$/);
  if (req.method === 'POST' && epMatch) {
    const ep = findEntrypoint(epMatch[1]);
    if (!ep) return send(res, 404, { error: 'unknown_entrypoint', key: epMatch[1] });
    const { text: raw, tooLarge } = await readBody(req);
    if (tooLarge) return send(res, 413, { error: 'payload_too_large' });

    // 1. API key path
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      const result = consumeApiCall(hashKey(token));
      if (!result.valid) {
        if (result.reason === 'quota_exceeded') return send(res, 402, { error: 'quota_exceeded', used: result.used, limit: result.limit, message: 'Quota exhausted. Pay at /invoice to top up.' });
        return send(res, 401, { error: 'invalid_api_key' });
      }
      let input; try { input = raw ? JSON.parse(raw) : {}; } catch { input = {}; }
      try {
        const output = await ep.handler(input);
        recordCall({ endpoint: ep.key, network: 'api-key', amountUsdc: '0', payer: 'api-key:' + result.label, txHash: 'manual', mock: 0, inputChars: (raw ?? '').length, authMethod: 'api-key' });
        return send(res, 200, { endpoint: ep.key, output, payment: { method: 'api-key', plan: result.plan, callsUsed: result.used, callsLimit: result.limit } });
      } catch (err) { return send(res, 500, { error: 'handler_failed', message: String(err?.message ?? err) }); }
    }

    // 2. x402 paywall
    const price = ep.priceUsdc ?? PRICE_USDC;
    const resourcePath = `/entrypoints/${ep.key}/invoke`;
    const requirements = buildPaymentRequirements(resourcePath);
    if (price !== PRICE_USDC) requirements.accepts[0].maxAmountRequired = priceToAtomic(price);

    const paymentHeader = req.headers['x-payment'];
    if (!paymentHeader) {
      return send(res, 402, {
        error: 'payment_required',
        message: `Pay via PayPal/Bit/bank (see /invoice) for an API key, OR pay ${price} USDC on ${NETWORK} and retry with X-PAYMENT.`,
        invoiceUrl: `${resolveBaseUrl(req)}/invoice`,
        plansUrl: `${resolveBaseUrl(req)}/billing/plans`,
        ...requirements,
      }, { 'x-payment-required': Buffer.from(JSON.stringify(requirements)).toString('base64') });
    }

    const verification = await verifyPayment(requirements, paymentHeader);
    if (!verification.valid) return send(res, 402, { error: 'payment_invalid', reason: verification.reason ?? 'unknown' });

    let input; try { input = raw ? JSON.parse(raw) : {}; } catch { input = {}; }
    try {
      const output = await ep.handler(input);
      recordCall({ endpoint: ep.key, network: NETWORK, amountUsdc: price, payer: verification.payer, txHash: verification.txHash, mock: verification.mock, inputChars: (raw ?? '').length, authMethod: 'x402' });
      return send(res, 200, { endpoint: ep.key, output, payment: { method: 'x402', received: true, amountUsdc: price, network: NETWORK, txHash: verification.txHash, payer: verification.payer } },
        { 'x-payment-receipt': Buffer.from(JSON.stringify({ txHash: verification.txHash, amount: price, network: NETWORK, endpoint: ep.key })).toString('base64') });
    } catch (err) { return send(res, 500, { error: 'handler_failed', message: String(err?.message ?? err) }); }
  }

  return send(res, 404, { error: 'not_found', path: url.pathname });
});

server.listen(PORT, () => {
  console.log(`${AGENT_NAME} v${AGENT_VERSION} listening on ${PUBLIC_BASE_URL}`);
  console.log(`  x402: ${PAYMENT_MODE} on ${NETWORK} \u2014 ${PRICE_USDC} USDC/call`);
  console.log(`  x402 wallet: ${WALLET_ADDRESS || '(none set)'}`);
  console.log(`  Oldschool channels:`);
  if (PAYPAL_ME) console.log(`    - PayPal.me/${PAYPAL_ME}`);
  if (BUY_ME_A_COFFEE) console.log(`    - Buy Me a Coffee: ${BUY_ME_A_COFFEE}`);
  if (KO_FI) console.log(`    - Ko-fi: ${KO_FI}`);
  if (BIT_PHONE) console.log(`    - Bit: ${BIT_PHONE}`);
  if (GITHUB_SPONSORS) console.log(`    - GitHub Sponsors: ${GITHUB_SPONSORS}`);
  if (GUMROAD_URL) console.log(`    - Gumroad: ${GUMROAD_URL}`);
  if (BANK_ACCOUNT) console.log(`    - Bank transfer: ${BANK_NAME} branch ${BANK_BRANCH} acct ${BANK_ACCOUNT}`);
  console.log(`  Admin (key issuance): ${ADMIN_TOKEN ? 'ENABLED (set ADMIN_TOKEN to gate)' : 'DISABLED (set ADMIN_TOKEN to enable)'}`);
  console.log(`  Invoice: ${PUBLIC_BASE_URL}/invoice`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log(`\n${sig}, shutting down`); server.close(() => { db.close(); process.exit(0); }); });
