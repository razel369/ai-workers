const base = 'https://paid-agent-demo-production.up.railway.app';
(async () => {
  try {
    const r = await fetch(base + '/brand/logo-nightdesk-icon.svg', { signal: AbortSignal.timeout(8000) });
    console.log('status:', r.status, 'ct:', r.headers.get('content-type'));
    if (r.status === 200) {
      const t = await r.text();
      console.log('size:', t.length, 'starts:', t.slice(0, 80));
    } else {
      const t = await r.text();
      console.log('body:', t.slice(0, 200));
    }
  } catch (e) {
    console.log('err:', e.message);
  }
})();