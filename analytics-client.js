/** Vercel Web Analytics for vanilla browser pages (no bundler). */

export function shouldEnableAnalytics() {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false;
  if (host.endsWith('.vercel.app')) return true;
  return window.__VERCEL__ === true;
}

export async function initAnalytics(options = {}) {
  if (typeof window === 'undefined') return;
  if (options.spa) {
    const reportProductRoute = () => {
      if (!location.hash.startsWith('#/magic')) return;
      const key = 'aiw_product_event_magic_started';
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
      void fetch('/api/public/product-event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'magic_started' }),
        keepalive: true,
      }).catch(() => {});
    };
    reportProductRoute();
    window.addEventListener('hashchange', reportProductRoute);
  }
  if (!shouldEnableAnalytics()) return;
  try {
    const { inject, pageview } = await import('/vendor/vercel-analytics.mjs');
    inject({ mode: 'production', debug: false });
    if (options.spa) {
      const report = () => pageview({ path: location.pathname + location.hash });
      report();
      window.addEventListener('hashchange', report);
    }
  } catch (err) {
    console.warn('[analytics] init skipped:', err);
  }
}

/** @deprecated use initAnalytics({ spa: true }) */
export function initVercelAnalytics() {
  return initAnalytics({ spa: true });
}
