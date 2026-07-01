// Google Gemini API client — image (Nano Banana) & video (Veo 3.1 Lite).
// API key via Google AI Studio (simplest + cheapest path for startups).

import crypto from 'node:crypto';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
export const DEFAULT_VIDEO_MODEL = 'veo-3.1-lite-generate-preview';

export function getGoogleApiKey() {
  return (process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
}

export function isMockMode() {
  return !getGoogleApiKey();
}

export const isMediaMockMode = isMockMode;

export function getImageModel() {
  return (process.env.GOOGLE_MEDIA_IMAGE_MODEL || DEFAULT_IMAGE_MODEL).trim();
}

export function getVideoModel() {
  return (process.env.GOOGLE_MEDIA_VIDEO_MODEL || DEFAULT_VIDEO_MODEL).trim();
}

function apiHeaders() {
  return {
    'content-type': 'application/json',
    'x-goog-api-key': getGoogleApiKey(),
  };
}

function mockPlaceholderSvg(prompt, aspectRatio, kind) {
  const label = kind === 'video' ? 'Mock Video (Veo 3.1 Lite)' : 'Mock Image (Nano Banana)';
  const short = String(prompt || '').slice(0, 80).replace(/[<>&"]/g, '');
  const [w, h] = aspectRatio === '9:16' ? [360, 640] : aspectRatio === '1:1' ? [512, 512] : [640, 360];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1a73e8"/><stop offset="100%" stop-color="#34a853"/></linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="50%" y="42%" fill="#fff" font-family="Arial,sans-serif" font-size="20" text-anchor="middle" font-weight="bold">${label}</text>
  <text x="50%" y="58%" fill="#e8f0fe" font-family="Arial,sans-serif" font-size="12" text-anchor="middle">${short}</text>
</svg>`;
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function extractImageFromInteraction(body) {
  if (body?.output_image?.data) {
    return { mimeType: body.output_image.mime_type || 'image/png', data: body.output_image.data };
  }
  const outputs = body?.outputs ?? body?.output ?? [];
  const list = Array.isArray(outputs) ? outputs : [outputs];
  for (const block of list) {
    if (block?.type === 'image' && block?.data) {
      return { mimeType: block.mime_type || block.mimeType || 'image/png', data: block.data };
    }
    if (block?.image?.data) {
      return { mimeType: block.image.mime_type || 'image/png', data: block.image.data };
    }
  }
  const preds = body?.predictions;
  if (Array.isArray(preds) && preds[0]?.bytesBase64Encoded) {
    return { mimeType: preds[0].mimeType || 'image/png', data: preds[0].bytesBase64Encoded };
  }
  return null;
}

async function generateImageViaInteractions({ prompt, model }) {
  const r = await fetch(`${API_BASE}/interactions`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ model, input: [{ type: 'text', text: prompt }] }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || body?.message || `interactions HTTP ${r.status}`);
  const img = extractImageFromInteraction(body);
  if (!img) throw new Error('no_image_in_response');
  return { base64: img.data, mimeType: img.mimeType, model, mock: false };
}

async function generateImageViaImagen({ prompt, model }) {
  const r = await fetch(`${API_BASE}/models/${model}:predict`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1 } }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || body?.message || `imagen HTTP ${r.status}`);
  const img = extractImageFromInteraction(body);
  if (!img) throw new Error('no_image_in_response');
  return { base64: img.data, mimeType: img.mimeType, model, mock: false };
}

export async function generateImage({ prompt, aspectRatio = '1:1' }) {
  if (isMockMode()) {
    const svg = mockPlaceholderSvg(prompt, aspectRatio, 'image');
    const base64 = Buffer.from(svg).toString('base64');
    return {
      mock: true,
      dataUrl: svgDataUrl(svg),
      base64,
      mimeType: 'image/svg+xml',
      model: 'mock',
      caption: 'מצב דמו — הגדר GOOGLE_AI_API_KEY לתמונות אמיתיות',
    };
  }
  const model = getImageModel();
  const enriched = aspectRatio && aspectRatio !== '1:1' ? `${prompt}\n\nAspect ratio: ${aspectRatio}.` : prompt;
  if (model.startsWith('imagen-')) return generateImageViaImagen({ prompt: enriched, model });
  try {
    return await generateImageViaInteractions({ prompt: enriched, model });
  } catch (e) {
    if (model === 'imagen-4.0-fast-generate-001') throw e;
    return generateImageViaImagen({ prompt: enriched, model: 'imagen-4.0-fast-generate-001' });
  }
}

export async function startVideoGeneration({
  prompt,
  imageBase64,
  imageMime,
  imageMimeType,
  aspectRatio = '16:9',
  durationSeconds = 4,
  resolution = '720p',
}) {
  const mime = imageMime || imageMimeType || 'image/png';
  if (isMockMode()) {
    const op = `mock://video/${crypto.randomBytes(8).toString('hex')}`;
    return { operationName: op, done: false, mock: true, model: 'mock' };
  }
  const model = getVideoModel();
  const instance = { prompt };
  if (imageBase64) {
    instance.image = { bytesBase64Encoded: imageBase64, mimeType: mime };
  }
  const r = await fetch(`${API_BASE}/models/${model}:predictLongRunning`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      instances: [instance],
      parameters: {
        aspectRatio,
        durationSeconds: Math.min(8, Math.max(4, durationSeconds)),
        resolution,
        sampleCount: 1,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || body?.message || `video start HTTP ${r.status}`);
  if (!body?.name) throw new Error('no_operation_name');
  return { operationName: body.name, done: false, mock: false, model };
}

export async function pollVideoOperation(operationName, { maxWaitMs, pollMs = 8_000 } = {}) {
  if (isMockMode() || String(operationName).startsWith('mock://')) {
    const svg = mockPlaceholderSvg('mock video', '16:9', 'video');
    return { done: true, mock: true, videoUri: svgDataUrl(svg) };
  }
  const opPath = operationName.startsWith('http') ? operationName.replace(`${API_BASE}/`, '') : operationName;
  const deadline = Date.now() + (maxWaitMs ?? (Number(process.env.GOOGLE_MEDIA_VIDEO_MAX_WAIT_MS) || 90_000));
  while (Date.now() < deadline) {
    const r = await fetch(`${API_BASE}/${opPath}`, {
      headers: apiHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error?.message || `poll HTTP ${r.status}`);
    if (body.done) {
      const uri = body?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
        || body?.response?.generatedVideos?.[0]?.video?.uri;
      if (!uri) {
        const filtered = body?.response?.generateVideoResponse?.raiMediaFilteredReasons;
        throw new Error(filtered?.[0] || 'video_generation_failed');
      }
      return { done: true, mock: false, videoUri: uri };
    }
    if (maxWaitMs == null) return { done: false, mock: false };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('video_poll_timeout');
}

export async function downloadGoogleMediaFile(uri) {
  if (!uri || uri.startsWith('data:') || uri.startsWith('mock://')) return null;
  const r = await fetch(uri, { headers: apiHeaders(), redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const buffer = Buffer.from(await r.arrayBuffer());
  const mimeType = r.headers.get('content-type') || 'video/mp4';
  return { buffer, mimeType };
}
