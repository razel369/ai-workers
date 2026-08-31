// Image generation provider layer.
//
// Chat and media now run on different vendors — DeepSeek V4 Flash answers
// customers, GPT Image 2 draws the pictures — so they need separate
// credentials and separate cost accounting. This module picks the image
// provider and normalises the response so media-tools.js does not care which
// one ran.
//
// Order: the configured provider, then any other configured provider as a
// fallback, then a mock placeholder. A worker should never fail a customer
// conversation because an image backend is down.
//
// ENV:
//   MEDIA_IMAGE_PROVIDER=openai|google|mock   (default: openai when keyed)
//   OPENAI_API_KEY=sk-...                     # image generation, NOT chat
//   OPENAI_IMAGE_MODEL=gpt-image-2
//   OPENAI_IMAGE_QUALITY=medium               # low | medium | high
//   OPENAI_IMAGE_BASE_URL=https://api.openai.com

import {
  generateImage as generateGoogleImage,
  isMediaMockMode as isGoogleMockMode,
} from './google-media.js';

const env = (k, d = '') => (process.env[k] ?? d).trim();

export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
const IMAGE_TIMEOUT_MS = 120_000;

function openaiKey() {
  // Deliberately NOT LLM_API_KEY: that key now belongs to DeepSeek.
  return env('OPENAI_API_KEY') || env('OPENAI_IMAGE_API_KEY');
}

export function imageModel() {
  return env('OPENAI_IMAGE_MODEL', DEFAULT_IMAGE_MODEL);
}

export function resolveImageProvider() {
  const explicit = env('MEDIA_IMAGE_PROVIDER').toLowerCase();
  if (explicit) return explicit;
  if (openaiKey()) return 'openai';
  if (!isGoogleMockMode()) return 'google';
  return 'mock';
}

export function imageConfigStatus() {
  const provider = resolveImageProvider();
  return {
    provider,
    model: provider === 'openai' ? imageModel() : undefined,
    quality: provider === 'openai' ? env('OPENAI_IMAGE_QUALITY', 'medium') : undefined,
    openaiKeySet: !!openaiKey(),
    googleKeySet: !isGoogleMockMode(),
    live: provider !== 'mock',
  };
}

/**
 * gpt-image-2 takes concrete pixel sizes, not ratios. Map the ratios the
 * worker tool already exposes onto the supported sizes; anything else falls
 * back to square.
 */
const SIZE_BY_RATIO = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '4:3': '1536x1024',
  '9:16': '1024x1536',
  '3:4': '1024x1536',
};

export function sizeForRatio(aspectRatio) {
  return SIZE_BY_RATIO[aspectRatio] ?? '1024x1024';
}

/** Per-image list price in USD, by quality tier. Override with IMAGE_PRICE_JSON. */
const BASE_IMAGE_PRICES = { low: 0.03, medium: 0.05, high: 0.08 };

export function imagePriceUsd(quality = env('OPENAI_IMAGE_QUALITY', 'medium')) {
  let table = BASE_IMAGE_PRICES;
  try {
    const override = JSON.parse(env('IMAGE_PRICE_JSON', '{}'));
    table = { ...BASE_IMAGE_PRICES, ...override };
  } catch {}
  return table[quality] ?? table.medium ?? 0.05;
}

async function generateOpenAiImage({ prompt, aspectRatio }) {
  const key = openaiKey();
  if (!key) throw new Error('openai_api_key_not_configured');
  const model = imageModel();
  const quality = env('OPENAI_IMAGE_QUALITY', 'medium');
  const baseUrl = env('OPENAI_IMAGE_BASE_URL', 'https://api.openai.com').replace(/\/$/, '');

  const r = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: String(prompt).slice(0, 4000),
      n: 1,
      size: sizeForRatio(aspectRatio),
      quality,
    }),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(body?.error?.message || `openai_images_http_${r.status}`);
  }
  const item = body?.data?.[0];
  if (!item) throw new Error('no_image_in_response');

  // The API returns base64 by default; a hosted URL is also accepted.
  if (item.b64_json) {
    return {
      base64: item.b64_json, mimeType: 'image/png',
      model, provider: 'openai', quality, mock: false,
      costUsd: imagePriceUsd(quality),
      revisedPrompt: item.revised_prompt ?? null,
    };
  }
  if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
    if (!img.ok) throw new Error(`image_download_http_${img.status}`);
    const buf = Buffer.from(await img.arrayBuffer());
    return {
      base64: buf.toString('base64'),
      mimeType: img.headers.get('content-type') || 'image/png',
      model, provider: 'openai', quality, mock: false,
      costUsd: imagePriceUsd(quality),
      revisedPrompt: item.revised_prompt ?? null,
    };
  }
  throw new Error('no_image_in_response');
}

/**
 * Generate one image. Never throws for a provider outage — falls through to
 * the next provider and finally to a mock placeholder, so a chat turn that
 * asked for a picture still completes.
 */
export async function generateImage({ prompt, aspectRatio = '1:1' }) {
  const provider = resolveImageProvider();
  const errors = [];

  if (provider === 'openai') {
    try {
      return await generateOpenAiImage({ prompt, aspectRatio });
    } catch (e) {
      errors.push(`openai: ${e?.message ?? e}`);
      console.warn('[image] gpt-image-2 failed, falling back:', e?.message ?? e);
    }
  }

  if (provider === 'google' || (provider === 'openai' && !isGoogleMockMode())) {
    try {
      const res = await generateGoogleImage({ prompt, aspectRatio });
      return { ...res, provider: res.mock ? 'mock' : 'google', costUsd: res.mock ? 0 : null };
    } catch (e) {
      errors.push(`google: ${e?.message ?? e}`);
    }
  }

  // Mock placeholder — google-media returns an SVG data URL when unkeyed.
  const res = await generateGoogleImage({ prompt, aspectRatio });
  return {
    ...res,
    provider: 'mock',
    costUsd: 0,
    caption: errors.length
      ? `מצב דמו — ספק התמונות לא זמין (${errors[0].slice(0, 80)})`
      : res.caption,
  };
}
