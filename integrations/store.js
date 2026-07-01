// Per-tenant integration credentials — encrypted in SQLite (tenant workers.db).

import { validateConnectPayload, getIntegrationType, redactConfig } from './registry.js';
import { encryptConfig, decryptConfig } from './crypto.js';

let _getTenantDb = null;
let _newId = null;

export function initIntegrationStore(deps) {
  _getTenantDb = deps.getTenantDb;
  _newId = deps.newId;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      config_enc TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'connected',
      last_test_at TEXT,
      last_test_ok INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_integrations_type ON integrations(type);
  `);
}

function dbFor(tenantId) {
  if (!_getTenantDb) throw new Error('integration store not initialized');
  const db = _getTenantDb(tenantId);
  ensureSchema(db);
  return db;
}

function rowToPublic(row, tenantId) {
  const config = decryptConfig(tenantId, row.config_enc);
  const def = getIntegrationType(row.type);
  let meta = {};
  try { meta = JSON.parse(row.meta_json || '{}'); } catch {}
  return {
    id: row.id,
    type: row.type,
    label: row.label || def?.labelHe || row.type,
    labelHe: def?.labelHe ?? row.type,
    category: def?.category ?? 'other',
    status: row.status,
    config: redactConfig(config),
    meta,
    workerTools: def?.workerTools ?? [],
    scaffold: def?.scaffold === true ? 'scaffold' : def?.scaffold === 'partial' ? 'partial' : 'working',
    lastTestAt: row.last_test_at ?? null,
    lastTestOk: row.last_test_ok == null ? null : !!row.last_test_ok,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listIntegrations(tenantId) {
  const rows = dbFor(tenantId).prepare(`SELECT * FROM integrations ORDER BY created_at DESC`).all();
  return rows.map((r) => rowToPublic(r, tenantId));
}

export function getIntegrationSecrets(tenantId, id) {
  const row = dbFor(tenantId).prepare(`SELECT * FROM integrations WHERE id = ?`).get(id);
  if (!row) return null;
  const pub = rowToPublic(row, tenantId);
  pub.config = decryptConfig(tenantId, row.config_enc);
  return pub;
}

export function getIntegrationsByType(tenantId, typeId) {
  const rows = dbFor(tenantId).prepare(`SELECT * FROM integrations WHERE type = ? AND status = 'connected'`).all(typeId);
  return rows.map((r) => {
    const pub = rowToPublic(r, tenantId);
    pub.config = decryptConfig(tenantId, r.config_enc);
    return pub;
  });
}

export function getFirstIntegrationConfig(tenantId, typeId) {
  return getIntegrationsByType(tenantId, typeId)[0]?.config ?? null;
}

export function listConnectedTypes(tenantId) {
  return dbFor(tenantId).prepare(`SELECT DISTINCT type FROM integrations WHERE status = 'connected'`).all().map((r) => r.type);
}

export function getWebhookUrlForTenant(tenantId) {
  return getFirstIntegrationConfig(tenantId, 'webhook')?.url ?? null;
}

export function connectIntegration(tenantId, { type, label, config, meta }) {
  const validated = validateConnectPayload(type, config);
  if (!validated.ok && meta?.connectedVia === 'oauth') {
    // OAuth tokens may not match legacy field schema
  } else if (!validated.ok) {
    return validated;
  }
  const finalConfig = validated.ok ? validated.config : { ...config };
  const db = dbFor(tenantId);
  const now = new Date().toISOString();
  const def = getIntegrationType(type);
  const existing = db.prepare(`SELECT id FROM integrations WHERE type = ? LIMIT 1`).get(type);
  const enc = encryptConfig(tenantId, finalConfig);
  const metaJson = JSON.stringify(meta ?? {});

  if (existing) {
    db.prepare(`UPDATE integrations SET label = ?, config_enc = ?, meta_json = ?, status = 'connected', updated_at = ? WHERE id = ?`).run(
      label || def?.labelHe || type, enc, metaJson, now, existing.id
    );
    return { ok: true, id: existing.id, updated: true };
  }

  const id = _newId ? _newId('int') : `int_${Date.now().toString(36)}`;
  db.prepare(`INSERT INTO integrations (id, type, label, config_enc, meta_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'connected', ?, ?)`).run(
    id, type, label || def?.labelHe || type, enc, metaJson, now, now
  );
  return { ok: true, id, updated: false };
}

export function deleteIntegration(tenantId, id) {
  const r = dbFor(tenantId).prepare(`DELETE FROM integrations WHERE id = ?`).run(id);
  return { ok: r.changes > 0 };
}

export function updateTestResult(tenantId, id, { ok }) {
  const now = new Date().toISOString();
  dbFor(tenantId).prepare(`UPDATE integrations SET last_test_at = ?, last_test_ok = ?, updated_at = ? WHERE id = ?`).run(
    now, ok ? 1 : 0, now, id
  );
}
