import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const toolCache = new Map();
const CACHE_TTL = 300_000;

function jsonRpcRequest(serverUrl, method, params, headers = {}, requestOptions = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(serverUrl);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const body = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {}, id });
    const mod = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      timeout: 15_000,
    };
    if (typeof requestOptions.lookup === 'function') opts.lookup = requestOptions.lookup;
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error(`Invalid JSON from MCP: ${text.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('MCP request timeout')); });
    req.write(body);
    req.end();
  });
}

export async function discoverMcpTools(serverUrl, headers = {}, opts = {}) {
  const key = serverUrl + '|' + JSON.stringify(headers);
  const cached = toolCache.get(key);
  if (cached && Date.now() - cached.lastFetched < CACHE_TTL) return cached.tools;
  const res = await jsonRpcRequest(serverUrl, 'tools/list', {}, headers, opts);
  if (res.error) throw new Error(`MCP tools/list error: ${res.error.message}`);
  const tools = (res.result?.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description || '',
    parameters: t.inputSchema || { type: 'object', properties: {}, required: [] },
    _mcpServer: serverUrl,
    _mcpHeaders: headers,
  }));
  toolCache.set(key, { tools, lastFetched: Date.now() });
  return tools;
}

export async function callMcpTool(serverUrl, toolName, args, headers = {}, opts = {}) {
  const res = await jsonRpcRequest(serverUrl, 'tools/call', { name: toolName, arguments: args }, headers, opts);
  if (res.error) throw new Error(`MCP tools/call error: ${res.error.message}`);
  const content = res.result?.content ?? [];
  const textParts = content.filter((c) => c.type === 'text').map((c) => c.text);
  const resourceParts = content.filter((c) => c.type === 'resource');
  const extra = resourceParts.map((r) => {
    const b = r.resource;
    return b.text ? `[Resource: ${b.uri}] ${b.text}` : `[Resource: ${b.uri}]`;
  });
  const combined = [...textParts, ...extra].join('\n') || 'Tool executed (no text output)';
  return { result: combined };
}

export function clearMcpCache() { toolCache.clear(); }

export function getMcpCacheStats() {
  const entries = [];
  for (const [key, val] of toolCache) {
    entries.push({ server: key.split('|')[0], toolCount: val.tools.length, age: Date.now() - val.lastFetched });
  }
  return entries;
}
