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

const MAX_PUBLIC_FETCH_REDIRECTS = 5;
const DEFAULT_PUBLIC_FETCH_MAX_BYTES = 512_000;

/**
 * Fetch a public HTTP(S) URL with DNS pinning and per-redirect re-validation (SSRF-safe).
 */
export async function fetchPublicHttpContent(rawUrl, options = {}) {
  const {
    timeoutMs = 12_000,
    headers = {},
    maxBytes = DEFAULT_PUBLIC_FETCH_MAX_BYTES,
    maxRedirects = MAX_PUBLIC_FETCH_REDIRECTS,
    responseType = 'text',
    allowedProtocols = ['http:', 'https:'],
  } = options;

  const protocolValues = allowedProtocols instanceof Set
    ? [...allowedProtocols]
    : Array.isArray(allowedProtocols)
      ? allowedProtocols
      : [allowedProtocols];
  const allowedProtocolSet = new Set(
    protocolValues.map((protocol) => String(protocol ?? '').trim().toLowerCase()).filter(Boolean)
  );

  let current = String(rawUrl ?? '').trim();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const checked = await validatePublicHttpUrl(current);
    if (!checked.ok) return { ok: false, error: checked.error, url: current };

    const parsed = new URL(checked.url);
    if (!allowedProtocolSet.has(parsed.protocol)) {
      return { ok: false, error: 'protocol_not_allowed', url: checked.url };
    }
    const lib = parsed.protocol === 'https:' ? await import('node:https') : await import('node:http');
    const lookup = pinnedLookup(checked.resolved);

    const result = await new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { 'user-agent': 'AI-Workers/1.0', ...headers },
        lookup,
        timeout: timeoutMs,
      }, (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume();
          try {
            resolve({ redirect: new URL(location, checked.url).toString() });
          } catch {
            reject(new Error('invalid_redirect'));
          }
          return;
        }

        const contentType = cleanText(res.headers['content-type'] ?? '', 120);
        const declaredLength = Number(res.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          res.destroy();
          resolve({
            ok: false,
            error: 'response_too_large',
            status,
            contentType,
            url: checked.url,
          });
          return;
        }

        const chunks = [];
        let size = 0;
        let exceeded = false;
        res.on('data', (chunk) => {
          if (exceeded) return;
          size += chunk.length;
          if (size > maxBytes) {
            exceeded = true;
            res.destroy();
            resolve({
              ok: false,
              error: 'response_too_large',
              status,
              contentType,
              url: checked.url,
            });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (exceeded) return;
          const buffer = Buffer.concat(chunks);
          resolve({
            ok: status >= 200 && status < 300,
            status,
            body: responseType === 'buffer' ? buffer : buffer.toString('utf8'),
            contentType,
            url: checked.url,
          });
        });
        res.on('error', (error) => {
          if (!exceeded) reject(error);
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    }).catch((e) => ({ ok: false, error: e?.message ?? String(e), url: checked.url }));

    if (result.redirect) {
      current = result.redirect;
      continue;
    }
    return result;
  }
  return { ok: false, error: 'too_many_redirects', url: current };
}

const OAUTH_MARKETPLACE_HASHES = [
  /^#\/workers\/(?:connect|edit)\/[A-Za-z0-9_-]{1,100}$/,
  /^#\/workers\/new\/[A-Za-z0-9_-]{1,100}$/,
];

/**
 * Restrict post-OAuth navigation to the marketplace surfaces that can start an
 * integration flow. Keeping this as a narrow relative allowlist prevents an
 * OAuth callback from becoming an open redirect, including through URL parser
 * normalization of backslashes, encoded delimiters, or dot segments.
 */
export function normalizeOAuthReturnPath(value) {
  const raw = String(value ?? '');
  if (!raw || raw.length > 300 || raw !== raw.trim()) return null;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\\%]/.test(raw)) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(raw)) return null;

  let parsed;
  try { parsed = new URL(raw, 'https://oauth-return.invalid'); }
  catch { return null; }
  if (parsed.origin !== 'https://oauth-return.invalid'
      || parsed.pathname !== '/marketplace'
      || parsed.search
      || parsed.username
      || parsed.password) {
    return null;
  }
  if (parsed.hash && !OAUTH_MARKETPLACE_HASHES.some((pattern) => pattern.test(parsed.hash))) {
    return null;
  }
  return `/marketplace${parsed.hash}`;
}

/** Put OAuth query params before the hash so SPA routers and location.search both work. */
export function buildOAuthReturnUrl(returnPath, queryString) {
  const path = normalizeOAuthReturnPath(returnPath) ?? '/marketplace';
  const hashIdx = path.indexOf('#');
  const base = hashIdx >= 0 ? path.slice(0, hashIdx) : path;
  const hash = hashIdx >= 0 ? path.slice(hashIdx) : '';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${queryString}${hash}`;
}
