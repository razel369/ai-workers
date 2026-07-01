import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOW_PRIVATE_NETWORK_URLS = process.env.ALLOW_PRIVATE_NETWORK_URLS === '1';

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

export function isPrivateOrReservedIp(address) {
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

export async function validatePublicHttpUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl ?? '')); }
  catch { return { ok: false, error: 'invalid_url' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, error: 'unsupported_protocol' };
  if (!parsed.hostname) return { ok: false, error: 'host_required' };
  if (parsed.username || parsed.password) return { ok: false, error: 'credentials_not_allowed' };
  if (String(rawUrl).length > 2048) return { ok: false, error: 'url_too_long' };
  if (ALLOW_PRIVATE_NETWORK_URLS) return { ok: true, url: parsed.toString(), resolved: [] };

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

export function pinnedLookup(resolved) {
  if (!resolved?.length) return undefined;
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

export function safeUrlForError(value) {
  return cleanText(value, 160);
}
