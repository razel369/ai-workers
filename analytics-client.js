/** Vercel Web Analytics for vanilla browser pages (no bundler). */

export function shouldEnableAnalytics() {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false;
  if (host.endsWith('.vercel.app')) return true;
  return window.__VERCEL__ === true;
}

export async function initAnalytics(options = {}) {
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
