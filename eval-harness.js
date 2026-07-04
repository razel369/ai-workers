// AI evaluation harness — runs scenarios against the worker chat logic
// without requiring a live LLM (mock mode) or with one if LLM_API_KEY is set.
//
// Usage:
//   node eval-harness.js                    # mock mode, fast
//   LLM_API_KEY=... node eval-harness.js    # real LLM mode, slower
//
// Each scenario produces a score 0-100 in 5 dimensions:
//   - intent   : did the reply address the user's intent?
//   - hebrew   : is the reply in Hebrew (or appropriate language)?
//   - length   : is the reply a reasonable length?
//   - tools    : did the agent use the right tools (or none, for chat)?
//   - safety   : did the reply avoid hallucinating prices/PII?

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buyTemplate, chatWithWorker } from './workers.js';

const SCENARIOS_PATH = new URL('./eval-scenarios.js', import.meta.url);

function ensureTenantDir(tenantId) {
  const dir = path.join(process.cwd(), 'data', 'tenants', tenantId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let failures = 0;
let total = 0;
const ok = (line) => console.log(`OK    ${line}`);
const fail = (line, detail) => { failures++; console.log(`FAIL  ${line}${detail ? ' \u2014 ' + detail : ''}`); };
const expect = (line, cond, detail) => cond ? ok(line) : fail(line, detail);

function makeTenant() {
  const tenantId = 'ten_eval_' + crypto.randomBytes(6).toString('hex');
  ensureTenantDir(tenantId);
  return tenantId;
}

async function setupWorkerForTemplate(tenantId, templateId) {
  const res = buyTemplate({ tenantId, templateId });
  if (!res.ok) throw new Error(`buyTemplate failed for ${templateId}: ${JSON.stringify(res)}`);
  return res.workerId;
}

async function runOne(tenantId, workerId, scenario) {
  const result = await chatWithWorker({
    tenantId,
    workerId,
    userMessage: scenario.userMessage,
    testMode: true,
    demoMode: true,
  });
  if (!result.ok) {
    return { ok: false, error: result.error || 'chat_failed' };
  }
  const reply = result.reply || '';
  const toolCalls = result.toolCalls || [];
  const runtime = result.runtime || 'unknown';
  const scores = scoreReply(reply, toolCalls, scenario);
  return { ok: true, reply, toolCalls, runtime, scores };
}

function scoreReply(reply, toolCalls, scenario) {
  const out = { intent: 0, hebrew: 0, length: 0, tools: 0, safety: 100 };
  const text = String(reply ?? '');
  const trimmed = text.trim();

  // --- Hebrew detection ---
  const hebrewChars = (trimmed.match(/[\u0590-\u05FF]/g) || []).length;
  const totalChars = trimmed.replace(/\s/g, '').length;
  const hebrewRatio = totalChars > 0 ? hebrewChars / totalChars : 0;
  out.hebrew = scenario.allowEnglish
    ? (hebrewRatio >= 0.4 || /\b(the|is|how|can|will)\b/i.test(trimmed) ? 100 : 30)
    : (hebrewRatio >= 0.5 ? 100 : Math.round(hebrewRatio * 200));

  // --- Length: penalize empty or absurdly long ---
  if (trimmed.length === 0) out.length = 0;
  else if (trimmed.length < 8) out.length = 30;
  else if (trimmed.length > 1200) out.length = 40;
  else if (trimmed.length < 30) out.length = 70;
  else out.length = 100;

  // --- Intent: must contain at least one expected keyword/phrase ---
  const must = scenario.mustContain ?? [];
  const should = scenario.shouldContain ?? [];
  const mustHit = must.filter((needle) => {
    if (needle instanceof RegExp) return needle.test(text);
    return text.includes(needle);
  });
  if (must.length === 0) {
    out.intent = should.length > 0
      ? Math.round((should.filter((n) => text.includes(n)).length / should.length) * 100)
      : 80;
  } else {
    out.intent = Math.round((mustHit.length / must.length) * 100);
    if (should.length > 0 && mustHit.length === must.length) {
      const bonus = Math.round((should.filter((n) => text.includes(n)).length / should.length) * 20);
      out.intent = Math.min(100, out.intent + bonus);
    }
  }

  // --- Tools: required tool calls / forbidden ones ---
  if (scenario.requireTools && scenario.requireTools.length) {
    const got = new Set(toolCalls.map((t) => t.name));
    const hits = scenario.requireTools.filter((t) => got.has(t));
    out.tools = Math.round((hits.length / scenario.requireTools.length) * 100);
  } else if (scenario.forbidTools && scenario.forbidTools.length) {
    const got = toolCalls.map((t) => t.name);
    const banned = got.filter((t) => scenario.forbidTools.includes(t));
    out.tools = banned.length === 0 ? 100 : 0;
  } else {
    out.tools = toolCalls.length === 0 ? 100 : 80;
  }

  // --- Safety: hallucinated prices, fake appointments ---
  if (scenario.safety) {
    for (const pattern of scenario.safety.hallucinatedPriceRe) {
      if (pattern.test(text)) out.safety -= 40;
    }
    if (scenario.safety.noPii) {
      if (/\b\d{4}[-\s]?\d{4}\b/.test(text)) out.safety -= 25; // credit-card-like
      if (/\b\d{9}\b/.test(text)) out.safety -= 10;
    }
    out.safety = Math.max(0, out.safety);
  }

  out.total = Math.round((out.intent + out.hebrew + out.length + out.tools + out.safety) / 5);
  return out;
}

function fmtScoreLine(scenarioId, scores, runtime, ok) {
  const tag = ok ? 'PASS' : 'FAIL';
  return `${tag.padEnd(4)} ${scenarioId.padEnd(40)} runtime=${runtime.padEnd(14)} total=${String(scores.total).padStart(3)} ` +
    `intent=${String(scores.intent).padStart(3)} hebrew=${String(scores.hebrew).padStart(3)} ` +
    `length=${String(scores.length).padStart(3)} tools=${String(scores.tools).padStart(3)} safety=${String(scores.safety).padStart(3)}`;
}

async function main() {
  const { SCENARIOS } = await import(SCENARIOS_PATH);
  console.log(`Running ${SCENARIOS.length} scenarios across ${new Set(SCENARIOS.map((s) => s.templateId)).size} templates\n`);

  const tenantId = makeTenant();
  const workerCache = new Map();
  const byTemplate = new Map();
  for (const s of SCENARIOS) {
    if (!byTemplate.has(s.templateId)) byTemplate.set(s.templateId, []);
    byTemplate.get(s.templateId).push(s);
  }

  const startedAt = Date.now();
  const totals = { intent: 0, hebrew: 0, length: 0, tools: 0, safety: 0, total: 0 };
  let passed = 0;

  for (const [templateId, scenarios] of byTemplate) {
    let workerId = workerCache.get(templateId);
    if (!workerId) {
      workerId = await setupWorkerForTemplate(tenantId, templateId);
      workerCache.set(templateId, workerId);
    }
    console.log(`\n--- ${templateId} (${scenarios.length} scenarios) ---`);
    for (const scenario of scenarios) {
      const result = await runOne(tenantId, workerId, scenario);
      total++;
      if (!result.ok) {
        fail(scenario.id, `chat failed: ${result.error}`);
        continue;
      }
      const passedScenario = result.scores.total >= scenario.minScore;
      if (passedScenario) passed++; else failures++;
      console.log(fmtScoreLine(scenario.id, result.scores, result.runtime, passedScenario));
      totals.intent += result.scores.intent;
      totals.hebrew += result.scores.hebrew;
      totals.length += result.scores.length;
      totals.tools += result.scores.tools;
      totals.safety += result.scores.safety;
      totals.total += result.scores.total;
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log(`\n=========================================`);
  console.log(`Scenarios: ${total} · Passed: ${passed} · Failed: ${failures}`);
  if (total > 0) {
    console.log(`Average scores:`);
    for (const k of Object.keys(totals)) {
      console.log(`  ${k.padEnd(8)} ${Math.round(totals[k] / total)}/100`);
    }
  }
  console.log(`Elapsed: ${(elapsed / 1000).toFixed(1)}s`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});