// Usage metering — what a customer actually costs to serve.
//
// The product sells a flat monthly subscription that "covers all usage and
// tokens". Until this module existed nothing counted those tokens, so there was
// no way to answer the only question that decides whether the business works:
// does a 249 ₪/mo tenant cost 40 ₪ or 900 ₪ to serve? Combined with a quota of
// UNLIMITED_CALLS and a publicly embeddable chat widget, one busy site could
// quietly consume a month of revenue.
//
// Every LLM call now lands here: tokens in, tokens out, model, estimated cost,
// attributed to a tenant and worker. Quotas are enforced from the plan, and the
// admin gets margin per tenant.
//
// ENV:
//   MODEL_PRICING_JSON={"gpt-4o-mini":{"in":0.15,"out":0.6}}   # USD / 1M tokens
//   USD_TO_ILS=3.7
//   QUOTA_ENFORCE=1            # 0 = measure only, do not block (safe rollout)
//   QUOTA_SOFT_WARN_PCT=80
//   PLAN_COST_CEILING_PCT=35   # block once LLM cost passes this share of plan revenue

import * as registry from './tenant-registry.js';

let db = null;

const USD_TO_ILS = Number(process.env.USD_TO_ILS ?? 3.7);
const QUOTA_ENFORCE = process.env.QUOTA_ENFORCE !== '0';
const SOFT_WARN_PCT = Number(process.env.QUOTA_SOFT_WARN_PCT ?? 80);
// The message quota is a fair-use ceiling; this is the actual margin guard.
// A tenant with a huge knowledge base running the full agent loop can cost 10x
// a typical tenant for the same message count, so cost has to be capped
// directly rather than through a message-count proxy.
const COST_CEILING_PCT = Number(process.env.PLAN_COST_CEILING_PCT ?? 35);

/**
 * USD per 1M tokens. These are defaults for cost *estimation* only — provider
 * list prices change, so verify against your provider's pricing page and
 * override with MODEL_PRICING_JSON rather than trusting these numbers for
 * accounting. An unknown model falls back to DEFAULT_PRICE.
 */
const DEFAULT_PRICE = { in: 1.0, out: 3.0 };
const BASE_PRICING = {
  // DeepSeek moved to peak/off-peak pricing on 16 Aug 2026. The off-peak rate
  // is used here; peak (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri) is roughly
  // double, so a tenant's real cost lands between this and 2x.
  'deepseek-v4-flash': { in: 0.22, out: 0.66, cachedIn: 0.007 },
  'deepseek-v4-pro': { in: 0.66, out: 1.98, cachedIn: 0.022 },
  'gpt-5.6-luna': { in: 0.20, out: 1.20, cachedIn: 0.02 },
  'gpt-4o-mini': { in: 0.15, out: 0.6, cachedIn: 0.075 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gemini-2.5-flash-lite': { in: 0.10, out: 0.40, cachedIn: 0.010 },
  'llama-4-8b-instant': { in: 0.05, out: 0.08 },
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0, cachedIn: 0.1 },
};

function pricingTable() {
  try {
    const override = JSON.parse(process.env.MODEL_PRICING_JSON ?? '{}');
    return { ...BASE_PRICING, ...override };
  } catch {
    return BASE_PRICING;
  }
}

export function priceForModel(model) {
  const table = pricingTable();
  const key = String(model ?? '').trim();
  if (table[key]) return table[key];
  // Match on prefix so dated model ids (…-20251001) still resolve.
  const prefix = Object.keys(table).find((k) => key.startsWith(k) || k.startsWith(key));
  return prefix ? table[prefix] : DEFAULT_PRICE;
}

export function estimateCostUsd({ model, promptTokens = 0, completionTokens = 0, cachedTokens = 0 }) {
  const p = priceForModel(model);
  // Cached prefix tokens are billed at a steep discount (90-98% depending on
  // provider). This workload re-sends the same system prompt on every agent
  // step, so ignoring the discount materially overstates cost.
  const cached = Math.min(cachedTokens, promptTokens);
  const fresh = promptTokens - cached;
  const cachedRate = p.cachedIn ?? p.in;
  return (fresh / 1e6) * p.in + (cached / 1e6) * cachedRate + (completionTokens / 1e6) * p.out;
}

// --- Schema ---------------------------------------------------------------

export function initUsageMetering(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      period TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'chat',
      estimated INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_period ON usage_events(tenant_id, period);
    CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_events(at);

    CREATE TABLE IF NOT EXISTS usage_counters (
      tenant_id TEXT NOT NULL,
      period TEXT NOT NULL,
      -- messages = LLM calls (cost). chat_turns = customer messages (what the
      -- plan is sold in). One customer message can trigger up to 5 LLM calls,
      -- so quoting the plan in LLM calls understated it by an order of magnitude.
      messages INTEGER NOT NULL DEFAULT 0,
      chat_turns INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      warned_at TEXT,
      blocked_at TEXT,
      PRIMARY KEY (tenant_id, period)
    );
  `);
  try { db.exec(`ALTER TABLE usage_counters ADD COLUMN chat_turns INTEGER NOT NULL DEFAULT 0`); } catch {}
  return db;
}

/** Billing period key — quotas reset on the calendar month. */
export function currentPeriod(d = new Date()) {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

// --- Recording ------------------------------------------------------------

/**
 * Some OpenAI-compatible gateways omit the `usage` block. Rather than record
 * zero (which would understate cost and defeat the point), approximate from
 * character counts and flag the row as estimated so reports stay honest.
 */
export function approximateTokens(text) {
  const chars = String(text ?? '').length;
  // Hebrew is roughly 2 chars/token under cl100k-style BPE; English ~4.
  const hebrewRatio = (String(text ?? '').match(/[֐-׿]/g) ?? []).length / Math.max(chars, 1);
  const perToken = hebrewRatio > 0.3 ? 2.2 : 3.8;
  return Math.ceil(chars / perToken);
}

export function recordUsage({
  tenantId, workerId = '', provider = '', model = '',
  promptTokens = 0, completionTokens = 0, cachedTokens = 0,
  kind = 'chat', estimated = false,
}) {
  if (!db || !tenantId) return null;
  const period = currentPeriod();
  const costUsd = estimateCostUsd({ model, promptTokens, completionTokens, cachedTokens });
  const now = new Date().toISOString();
  try {
    db.prepare(`INSERT INTO usage_events
      (at, period, tenant_id, worker_id, provider, model, prompt_tokens, completion_tokens, cost_usd, kind, estimated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(now, period, tenantId, workerId, provider, model,
        Math.max(0, promptTokens | 0), Math.max(0, completionTokens | 0),
        costUsd, kind, estimated ? 1 : 0);
    db.prepare(`INSERT INTO usage_counters (tenant_id, period, messages, prompt_tokens, completion_tokens, cost_usd)
      VALUES (?,?,1,?,?,?)
      ON CONFLICT(tenant_id, period) DO UPDATE SET
        messages = messages + 1,
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens,
        cost_usd = cost_usd + excluded.cost_usd`)
      .run(tenantId, period, Math.max(0, promptTokens | 0), Math.max(0, completionTokens | 0), costUsd);
  } catch {
    return null;
  }
  return { costUsd, costIls: costUsd * USD_TO_ILS, period };
}

/**
 * One customer message, regardless of how many LLM calls it takes to answer.
 * This is the unit the plan is sold in and the unit the quota counts.
 */
export function recordChatTurn(tenantId) {
  if (!db || !tenantId) return;
  try {
    db.prepare(`INSERT INTO usage_counters (tenant_id, period, chat_turns) VALUES (?,?,1)
      ON CONFLICT(tenant_id, period) DO UPDATE SET chat_turns = chat_turns + 1`)
      .run(tenantId, currentPeriod());
  } catch {}
}

/** Pull token counts out of whichever shape the provider returned. */
export function extractUsage(json, provider) {
  if (!json) return null;
  if (provider === 'anthropic' && json.usage) {
    return {
      promptTokens: Number(json.usage.input_tokens ?? 0),
      completionTokens: Number(json.usage.output_tokens ?? 0),
      cachedTokens: Number(json.usage.cache_read_input_tokens ?? 0),
      estimated: false,
    };
  }
  if (json.usage) {
    // OpenAI reports cache hits under prompt_tokens_details.cached_tokens;
    // DeepSeek reports them as prompt_cache_hit_tokens. Both are already
    // included in prompt_tokens, so they are a discount, not an addition.
    const cached = Number(
      json.usage.prompt_tokens_details?.cached_tokens
      ?? json.usage.prompt_cache_hit_tokens
      ?? 0
    );
    return {
      promptTokens: Number(json.usage.prompt_tokens ?? json.usage.input_tokens ?? 0),
      completionTokens: Number(json.usage.completion_tokens ?? json.usage.output_tokens ?? 0),
      cachedTokens: cached,
      estimated: false,
    };
  }
  return null;
}

/**
 * Images are billed per image, not per token. Recorded against the same tenant
 * counters so the margin report covers the whole cost of serving a tenant.
 */
export function recordImageUsage({ tenantId, workerId = '', provider = '', model = '', costUsd = 0 }) {
  if (!db || !tenantId || !(costUsd > 0)) return null;
  const period = currentPeriod();
  const now = new Date().toISOString();
  try {
    db.prepare(`INSERT INTO usage_events
      (at, period, tenant_id, worker_id, provider, model, prompt_tokens, completion_tokens, cost_usd, kind, estimated)
      VALUES (?,?,?,?,?,?,0,0,?, 'image', 0)`)
      .run(now, period, tenantId, workerId, provider, model, costUsd);
    db.prepare(`INSERT INTO usage_counters (tenant_id, period, cost_usd) VALUES (?,?,?)
      ON CONFLICT(tenant_id, period) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd`)
      .run(tenantId, period, costUsd);
  } catch {
    return null;
  }
  return { costUsd, costIls: costUsd * USD_TO_ILS, period };
}

// --- Quotas ---------------------------------------------------------------

export function tenantUsage(tenantId, period = currentPeriod()) {
  if (!db || !tenantId) return { messages: 0, chatTurns: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, costIls: 0 };
  const r = db.prepare(`SELECT messages, chat_turns AS chatTurns, prompt_tokens AS promptTokens,
    completion_tokens AS completionTokens, cost_usd AS costUsd
    FROM usage_counters WHERE tenant_id = ? AND period = ?`).get(tenantId, period);
  const base = r ?? { messages: 0, chatTurns: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  return { ...base, costIls: Number(base.costUsd ?? 0) * USD_TO_ILS, period };
}

/**
 * Ask before spending money on a reply.
 *
 * Two independent ceilings, because neither alone is right:
 *
 *  - The message quota is what the plan is sold in and what the customer
 *    understands. It counts CUSTOMER messages, not LLM calls — the agent loop
 *    can make five calls to answer one message, so counting calls would cut a
 *    normal clinic off around day 13 of the month.
 *  - The cost ceiling is the actual margin guard. A tenant with a large
 *    knowledge base running the full agent loop can cost an order of magnitude
 *    more than a typical tenant at the same message count, which a message
 *    count cannot see.
 *
 * With QUOTA_ENFORCE=0 neither blocks — useful for rolling metering out to
 * existing customers before turning limits on.
 */
export function checkQuota(tenantId) {
  const tenant = registry.getTenant(tenantId);
  const plan = registry.getPlan(tenant?.plan);
  const usage = tenantUsage(tenantId);

  const limit = plan.monthlyMessages;
  const used = usage.chatTurns;
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const overMessages = limit > 0 && used >= limit;

  // Monthly revenue for this plan (annual plans are billed up front).
  const monthlyRevenueIls = plan.months > 1 ? plan.priceIls / plan.months : plan.priceIls;
  const costCeilingIls = plan.costCeilingIls ?? (monthlyRevenueIls * (COST_CEILING_PCT / 100));
  const costIls = usage.costIls;
  const costPct = costCeilingIls > 0 ? Math.round((costIls / costCeilingIls) * 100) : 0;
  const overCost = costCeilingIls > 0 && costIls >= costCeilingIls;

  const over = overMessages || overCost;
  return {
    allowed: !over || !QUOTA_ENFORCE,
    enforced: QUOTA_ENFORCE,
    exceeded: over,
    used, limit,
    remaining: Math.max(0, limit - used),
    pct,
    llmCalls: usage.messages,
    costIls: Number(costIls.toFixed(2)),
    costCeilingIls: Number(costCeilingIls.toFixed(2)),
    costPct,
    overCost,
    overMessages,
    nearLimit: pct >= SOFT_WARN_PCT || costPct >= SOFT_WARN_PCT,
    plan: plan.id,
    planNameHe: plan.nameHe,
    reason: overCost ? 'cost_ceiling_exceeded' : overMessages ? 'monthly_message_quota_exceeded' : null,
  };
}

/** Record that we warned/blocked so the billing job does not repeat itself. */
export function markQuotaNotice(tenantId, field) {
  if (!db || !tenantId) return;
  const col = field === 'blocked' ? 'blocked_at' : 'warned_at';
  try {
    db.prepare(`UPDATE usage_counters SET ${col} = ? WHERE tenant_id = ? AND period = ?`)
      .run(new Date().toISOString(), tenantId, currentPeriod());
  } catch {}
}

export function quotaNoticeState(tenantId) {
  if (!db || !tenantId) return { warnedAt: null, blockedAt: null };
  const r = db.prepare(`SELECT warned_at AS warnedAt, blocked_at AS blockedAt
    FROM usage_counters WHERE tenant_id = ? AND period = ?`).get(tenantId, currentPeriod());
  return r ?? { warnedAt: null, blockedAt: null };
}

// --- Margin reporting -----------------------------------------------------

/**
 * Revenue minus estimated LLM cost, per tenant, for the current period.
 * This is the number that tells you whether a plan is priced correctly.
 */
export function marginReport(period = currentPeriod()) {
  if (!db) return { period, tenants: [], totals: {} };
  const rows = db.prepare(`SELECT tenant_id AS tenantId, messages, chat_turns AS chatTurns,
    prompt_tokens AS promptTokens, completion_tokens AS completionTokens, cost_usd AS costUsd
    FROM usage_counters WHERE period = ? ORDER BY cost_usd DESC`).all(period);
  const tenants = rows.map((r) => {
    const t = registry.getTenant(r.tenantId);
    const plan = registry.getPlan(t?.plan);
    // Annual plans are billed up front; compare against the monthly equivalent.
    const revenueIls = plan.months > 1 ? plan.priceIls / plan.months : plan.priceIls;
    const costIls = Number(r.costUsd ?? 0) * USD_TO_ILS;
    return {
      tenantId: r.tenantId,
      businessName: t?.businessName ?? '',
      plan: plan.id,
      messages: r.chatTurns ?? 0,
      llmCalls: r.messages,
      // How many LLM round-trips each customer message costs — the number that
      // explains why two tenants on the same plan cost very different amounts.
      callsPerMessage: r.chatTurns > 0 ? Number((r.messages / r.chatTurns).toFixed(2)) : null,
      tokens: Number(r.promptTokens ?? 0) + Number(r.completionTokens ?? 0),
      costIls: Number(costIls.toFixed(2)),
      revenueIls,
      marginIls: Number((revenueIls - costIls).toFixed(2)),
      marginPct: revenueIls > 0 ? Number((((revenueIls - costIls) / revenueIls) * 100).toFixed(1)) : null,
      quotaPct: plan.monthlyMessages > 0 ? Math.round(((r.chatTurns ?? 0) / plan.monthlyMessages) * 100) : 0,
    };
  });
  const totals = tenants.reduce((acc, t) => ({
    tenants: acc.tenants + 1,
    messages: acc.messages + t.messages,
    costIls: Number((acc.costIls + t.costIls).toFixed(2)),
    revenueIls: acc.revenueIls + t.revenueIls,
    marginIls: Number((acc.marginIls + t.marginIls).toFixed(2)),
  }), { tenants: 0, messages: 0, costIls: 0, revenueIls: 0, marginIls: 0 });
  totals.marginPct = totals.revenueIls > 0
    ? Number(((totals.marginIls / totals.revenueIls) * 100).toFixed(1)) : null;
  // Tenants losing money are the ones to reprice or move up a plan.
  totals.unprofitableTenants = tenants.filter((t) => t.marginIls < 0).length;
  return { period, usdToIls: USD_TO_ILS, tenants, totals };
}

export function usageConfigStatus() {
  return {
    enforced: QUOTA_ENFORCE,
    usdToIls: USD_TO_ILS,
    softWarnPct: SOFT_WARN_PCT,
    costCeilingPct: COST_CEILING_PCT,
    pricedModels: Object.keys(pricingTable()).length,
  };
}
