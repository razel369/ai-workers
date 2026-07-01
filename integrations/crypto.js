import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

export function integrationSecret() {
  return process.env.INTEGRATIONS_SECRET || process.env.ADMIN_TOKEN || 'dev-insecure-integrations-key';
}

function deriveTenantKey(tenantId, secret) {
  return crypto.scryptSync(`${secret}:integrations:${tenantId}`, 'ai-workers-integrations-v1', 32);
}

export function encryptConfig(tenantId, config, secret = integrationSecret()) {
  const key = deriveTenantKey(tenantId, secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(config ?? {});
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptConfig(tenantId, blob, secret = integrationSecret()) {
  if (!blob || typeof blob !== 'string') return {};
  if (!blob.startsWith(PREFIX)) return {};
  try {
    const raw = Buffer.from(blob.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const key = deriveTenantKey(tenantId, secret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch {
    return {};
  }
}
