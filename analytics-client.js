/**
 * Funnel analytics for vanilla browser pages (no bundler).
 *
 * This used to enable itself only on `*.vercel.app`, but production runs on
 * Railway — so on the live site `shouldEnableAnalytics()` returned false and
 * nothing was ever recorded. Every product decision was being made without
 * knowing where signups drop.
 *
 * Two changes: analytics runs on any non-local host, and the funnel steps that
 * actually matter (view → signup → build → activate → pay) are tracked as
 * first-party events posted to /api/track, so the numbers survive ad blockers
 * and do not depend on a third-party script loading.
 */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];

export function shouldEnableAnalytics() {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (LOCAL_HOSTS.includes(host) || host.endsWith('.local')) return false;
  if (window.__ANALYTICS_DISABLED__ === true) return false;
  return true;
}

/** Vercel Web Analytics — only meaningful when actually deployed on Vercel. */
function vercelAnalyticsAvailable() {
  return typeof window !== 'undefined'
    && (window.location.hostname.endsWith('.vercel.app') || window.__VERCEL__ === true);
}

// --- First-party funnel tracking -----------------------------------------

export const FUNNEL_STEPS = [
  'landing_view',
  'marketplace_view',
  'template_selected',
  'signup_started',
  'signup_completed',
  'worker_created',
  'worker_customized',
  'demo_chat_started',
  'activation_requested',
  'checkout_opened',
  'payment_completed',
];

let sessionKey = '';

function getSessionKey() {
  if (sessionKey) return sessionKey;
  try {
    sessionKey = sessionStorage.getItem('aiw_sid') || '';
    if (!sessionKey) {
      sessionKey = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('aiw_sid', sessionKey);
    }
  } catch {
    // Private mode / storage blocked — fall back to a per-page-load id.
    sessionKey = `s_${Math.random().toString(36).slice(2, 12)}`;
  }
  return sessionKey;
}

/**
 * Record one funnel step. Fire-and-forget: analytics must never block or break
 * the page, so failures are swallowed and `keepalive` lets the request finish
 * even if the user navigates away immediately (which is exactly when the most
 * interesting drop-off events happen).
 */
export function trackEvent(step, props = {}) {
  if (!shouldEnableAnalytics()) return;
  try {
    const body = JSON.stringify({
      step: String(step).slice(0, 60),
      sessionKey: getSessionKey(),
      path: location.pathname + location.hash,
      referrer: document.referrer ? new URL(document.referrer).host : '',
      props: props && typeof props === 'object' ? props : {},
      at: new Date().toISOString(),
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch('/api/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

export async function initAnalytics(options = {}) {
  if (!shouldEnableAnalytics()) return;

  if (options.funnelStep) trackEvent(options.funnelStep);

  if (options.spa) {
    let lastPath = location.pathname + location.hash;
    window.addEventListener('hashchange', () => {
      const next = location.pathname + location.hash;
      if (next === lastPath) return;
      lastPath = next;
      trackEvent('route_view', { to: location.hash.slice(0, 60) });
    });
  }

  if (!vercelAnalyticsAvailable()) return;
  try {
    const { inject, pageview } = await import('/vendor/vercel-analytics.mjs');
    inject({ mode: 'production', debug: false });
    if (options.spa) {
      const report = () => pageview({ path: location.pathname + location.hash });
      report();
      window.addEventListener('hashchange', report);
    }
  } catch (err) {
    console.warn('[analytics] vercel init skipped:', err);
  }
}

/** @deprecated use initAnalytics({ spa: true }) */
export function initVercelAnalytics() {
  return initAnalytics({ spa: true });
}
