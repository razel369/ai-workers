const base = 'https://paid-agent-demo-production.up.railway.app';
(async () => {
  const tests = [
    '/brand/logo-nightdesk-icon.svg',
    '/brand/logo-nightdesk-mono.svg',
    '/brand/test.txt',
    '/assets/material3-theme.css',
  ];
  for (const p of tests) {
    try {
      const r = await fetch(base + p, { signal: AbortSignal.timeout(5000) });
      console.log(p, '->', r.status);
    } catch (e) {
      console.log(p, '-> ERR:', e.message);
    }
  }
})();