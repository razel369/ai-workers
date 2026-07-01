// Spawns the cloudflared binary against the running agent server.
// Gives you a public *.trycloudflare.com URL with no account needed.
// The URL changes every restart. For a permanent URL, run
// `cloudflared tunnel login` once to bind a named tunnel.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT ?? 8765;
const __dirname = dirname(fileURLToPath(import.meta.url));

const exe = process.platform === 'win32'
  ? join(__dirname, 'cloudflared.exe')
  : 'cloudflared';

if (process.platform !== 'win32' && !existsSync('/usr/local/bin/cloudflared') && !existsSync('/usr/bin/cloudflared')) {
  console.error('cloudflared not found in PATH. On Linux/Mac run:');
  console.error('  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared');
  console.error('On macOS: brew install cloudflared');
  process.exit(1);
}

console.log(`Starting cloudflared quick tunnel to http://localhost:${PORT} ...`);
console.log('(Quick tunnels are temporary. Bind a named tunnel for a permanent URL.)');
console.log('');
console.log('Your public URL will appear below in ~5 seconds:');
console.log('');

const child = spawn(exe, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
let printed = false;

const onLine = (line) => {
  const m = line.toString().match(urlRe);
  if (m && !printed) {
    printed = true;
    console.log('');
    console.log('============================================================');
    console.log(`PUBLIC URL: ${m[0]}`);
    console.log('============================================================');
    console.log('');
    console.log(`  Dashboard:  ${m[0]}/`);
    console.log(`  Invoice:    ${m[0]}/invoice`);
    console.log(`  A2A card:   ${m[0]}/.well-known/agent.json`);
    console.log(`  Health:     ${m[0]}/health`);
    console.log('');
  }
  process.stdout.write(line);
};

child.stdout.on('data', (b) => b.toString().split(/\r?\n/).forEach(onLine));
child.stderr.on('data', (b) => b.toString().split(/\r?\n/).forEach(onLine));
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
