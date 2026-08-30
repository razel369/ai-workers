// Worker tools: generate_image, generate_video, check_video_status
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  generateImage,
  startVideoGeneration,
  pollVideoOperation,
  downloadGoogleMediaFile,
  isMediaMockMode,
} from './google-media.js';
import { fetchPublicHttpContent } from './url-security.js';

const NSFW_PATTERNS = [
  /\b(nude|naked|nsfw|porn|xxx|erotic|sexual|hentai)\b/i,
  /\b(עירום|פורנו|מין|אירוטי|סקס)\b/,
];

const DEFAULT_MONTHLY_LIMIT = Number(process.env.MEDIA_GEN_LIMIT_PER_MONTH) || 50;

export function isPromptBlocked(prompt = '') {
  const text = String(prompt);
  return NSFW_PATTERNS.some((re) => re.test(text));
}

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function ensureMediaTables(db, tenantId = '') {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_gen_usage (
      tenant_id TEXT NOT NULL,
      period TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, period)
    );
    CREATE TABLE IF NOT EXISTS media_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      worker_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      operation_name TEXT,
      result_path TEXT,
      prompt TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_jobs_worker ON media_jobs(worker_id);
    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      filename TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_assets_owner
      ON media_assets(tenant_id, worker_id, filename);
  `);
  try { db.exec(`ALTER TABLE media_jobs ADD COLUMN tenant_id TEXT`); } catch {}
  if (tenantId) {
    db.prepare(`UPDATE media_jobs SET tenant_id = ? WHERE tenant_id IS NULL OR tenant_id = ''`).run(tenantId);
    backfillTrackedMediaAssets(db, tenantId);
  }
}

function mediaFilenameFromText(value) {
  const match = String(value ?? '').match(/(?:^|\/)(med_[a-f0-9]+\.(?:png|jpe?g|webp|svg|mp4))(?:$|[?#\s)\]])/i);
  return match?.[1] ?? null;
}

function backfillTrackedMediaAssets(db, tenantId) {
  // Older versions stored the worker owner in media_jobs/outbox but did not
  // maintain a dedicated file-ownership table. Backfill only when that exact
  // worker relationship exists; unknown files remain intentionally private.
  const candidates = [];
  try {
    for (const row of db.prepare(`SELECT id, worker_id AS workerId, result_path AS resultPath, created_at AS createdAt
      FROM media_jobs WHERE result_path IS NOT NULL AND result_path <> ''`).all()) {
      const filename = mediaFilenameFromText(row.resultPath);
      if (filename) candidates.push({ id: `legacy_job_${row.id}`, workerId: row.workerId, filename, kind: 'video', mimeType: mimeFromFilename(filename), createdAt: row.createdAt });
    }
  } catch {}
  try {
    for (const row of db.prepare(`SELECT id, worker_id AS workerId, body, created_at AS createdAt
      FROM outbox WHERE recipient = 'media'`).all()) {
      const filename = mediaFilenameFromText(row.body);
      if (filename) candidates.push({ id: `legacy_outbox_${row.id}`, workerId: row.workerId, filename, kind: filename.toLowerCase().endsWith('.mp4') ? 'video' : 'image', mimeType: mimeFromFilename(filename), createdAt: row.createdAt });
    }
  } catch {}
  const insert = db.prepare(`INSERT OR IGNORE INTO media_assets
    (id, tenant_id, worker_id, filename, kind, mime_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const item of candidates) {
    if (!item.workerId) continue;
    insert.run(item.id, tenantId, item.workerId, item.filename, item.kind, item.mimeType, item.createdAt || new Date().toISOString());
  }
}

function mimeFromFilename(filename) {
  const ext = path.extname(String(filename)).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4',
  })[ext] || 'application/octet-stream';
}

function checkRateLimit(db, tenantId) {
  ensureMediaTables(db, tenantId);
  const period = monthKey();
  const row = db.prepare(`SELECT count FROM media_gen_usage WHERE tenant_id=? AND period=?`).get(tenantId, period);
  const count = row?.count ?? 0;
  return { allowed: count < DEFAULT_MONTHLY_LIMIT, count, limit: DEFAULT_MONTHLY_LIMIT, period };
}

function checkAndBumpRateLimit(db, tenantId) {
  ensureMediaTables(db, tenantId);
  const period = monthKey();
  const row = db.prepare(`INSERT INTO media_gen_usage (tenant_id, period, count) VALUES (?, ?, 1)
    ON CONFLICT(tenant_id, period) DO UPDATE SET count = media_gen_usage.count + 1
      WHERE media_gen_usage.count < ?
    RETURNING count`).get(tenantId, period, DEFAULT_MONTHLY_LIMIT);
  if (row) {
    return { allowed: true, count: row.count, limit: DEFAULT_MONTHLY_LIMIT, period };
  }
  const current = db.prepare(`SELECT count FROM media_gen_usage WHERE tenant_id=? AND period=?`).get(tenantId, period);
  return { allowed: false, count: current?.count ?? 0, limit: DEFAULT_MONTHLY_LIMIT, period };
}

function mediaDir(tenantId, ensureTenantDir, { create = true } = {}) {
  const base = ensureTenantDir(tenantId);
  const dir = path.join(base, 'media');
  if (create) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:8765').replace(/\/$/, '');
}

function saveMediaAsset({ db, tenantId, workerId, buffer, ext, mimeType, kind, ensureTenantDir }) {
  ensureMediaTables(db, tenantId);
  const dir = mediaDir(tenantId, ensureTenantDir);
  const id = `med_${crypto.randomBytes(8).toString('hex')}`;
  const filename = `${id}.${ext}`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });
  try {
    db.prepare(`INSERT INTO media_assets
      (id, tenant_id, worker_id, filename, kind, mime_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id, tenantId, workerId, filename, kind, mimeType || mimeFromFilename(filename), new Date().toISOString()
    );
  } catch (error) {
    try { fs.unlinkSync(filePath); } catch {}
    throw error;
  }
  const url = `${publicBaseUrl()}/api/media/public/${tenantId}/${filename}`;
  return { id, filename, filePath, url, mimeType, workerId };
}

function extFromMime(mime = '') {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('svg')) return 'svg';
  if (mime.includes('mp4')) return 'mp4';
  return 'bin';
}

function storeInOutbox(db, ctx, subject, body) {
  db.prepare(`INSERT INTO outbox (worker_id, customer_id, recipient, subject, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    ctx.workerId, ctx.customerId ?? '', 'media', subject, body, new Date().toISOString()
  );
}

export function resolveMediaFile(db, tenantId, filename, ensureTenantDir) {
  const safe = path.basename(filename);
  if (!/^med_[a-f0-9]+\.(png|jpg|jpeg|webp|svg|mp4)$/i.test(safe)) return null;
  ensureMediaTables(db, tenantId);
  const owned = db.prepare(`SELECT 1 AS found FROM media_assets
    WHERE tenant_id = ? AND filename = ? LIMIT 1`).get(tenantId, safe);
  if (!owned) return null;
  const root = mediaDir(tenantId, ensureTenantDir, { create: false });
  const filePath = path.resolve(root, safe);
  if (path.dirname(filePath) !== path.resolve(root)) return null;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(filePath);
    return path.dirname(realFile) === realRoot ? realFile : null;
  } catch {
    return null;
  }
}

export function planWorkerMediaDeletion(db, tenantId, workerId) {
  ensureMediaTables(db, tenantId);
  return db.prepare(`SELECT filename FROM media_assets
    WHERE tenant_id = ? AND worker_id = ? ORDER BY filename`).all(tenantId, workerId)
    .map((row) => row.filename);
}

export function deleteWorkerMediaRecords(db, tenantId, workerId) {
  ensureMediaTables(db, tenantId);
  const assets = db.prepare(`DELETE FROM media_assets WHERE tenant_id = ? AND worker_id = ?`).run(tenantId, workerId).changes;
  const jobs = db.prepare(`DELETE FROM media_jobs
    WHERE worker_id = ? AND (tenant_id = ? OR tenant_id IS NULL OR tenant_id = '')`).run(workerId, tenantId).changes;
  return { assets, jobs };
}

export function deleteWorkerMediaFiles(tenantId, filenames, ensureTenantDir) {
  const root = path.resolve(mediaDir(tenantId, ensureTenantDir, { create: false }));
  let deleted = 0;
  const failed = [];
  for (const filename of new Set(filenames ?? [])) {
    const safe = path.basename(String(filename));
    if (!/^med_[a-f0-9]+\.(png|jpg|jpeg|webp|svg|mp4)$/i.test(safe)) continue;
    const candidate = path.resolve(root, safe);
    if (path.dirname(candidate) !== root) continue;
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        failed.push(safe);
        continue;
      }
      fs.unlinkSync(candidate);
      deleted++;
    } catch (error) {
      if (error?.code !== 'ENOENT') failed.push(safe);
    }
  }
  return { deleted, failed };
}

/**
 * @param {Array} toolDefs - mutable TOOL_DEFS array from workers.js
 * @param {{ getTenantDb: Function, ensureTenantDir: Function, newId: Function }} deps
 */
export function registerMediaTools(toolDefs, deps) {
  const { getTenantDb, ensureTenantDir, newId } = deps;

  toolDefs.push(
    {
      name: 'generate_image',
      description: 'Generate an AI image from a Hebrew or English prompt (Google Nano Banana). Returns a URL and markdown link. Use for social posts, menu promos, property visuals, blog headers.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Image description in Hebrew or English (brand-safe, professional)' },
          aspectRatio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: 'Aspect ratio (default 1:1 for Instagram, 16:9 for blog)' },
          purpose: { type: 'string', description: 'Short label e.g. instagram_post, menu_promo, listing_photo' },
        },
        required: ['prompt'],
      },
      handler: async (args, ctx) => {
        if (isPromptBlocked(args.prompt)) {
          return { result: 'בקשה נחסמה: תוכן לא מתאים למדיניות הבטיחות. נסח מחדש בצורה מקצועית ומתאימה לעסק.' };
        }

        const allowPlatformMedia = ctx.allowPlatformMedia === true;
        const db = getTenantDb(ctx.tenantId);
        const rate = allowPlatformMedia
          ? checkAndBumpRateLimit(db, ctx.tenantId)
          : { allowed: true, count: 0, limit: DEFAULT_MONTHLY_LIMIT, period: monthKey(), mock: true };
        if (!rate.allowed) {
          return { result: `מגבלת יצירת מדיה לחודש ${rate.period} הושגה (${rate.count}/${rate.limit}). נסה בחודש הבא או פנה למנהל המערכת.` };
        }

        const aspectRatio = args.aspectRatio || '1:1';
        const gen = allowPlatformMedia
          ? await generateImage({ prompt: args.prompt, aspectRatio })
          : {
              mock: true,
              dataUrl: mockSvgDataUrl(args.prompt, 'image'),
              caption: 'מצב הדגמה — יצירת מדיה אמיתית זמינה רק לעובד פעיל ובתשלום',
            };

        let url;
        let markdown;

        if (gen.mock && gen.dataUrl) {
          url = gen.dataUrl;
          markdown = `![${args.purpose || 'תמונה'}](${url})`;
        } else {
          const buffer = Buffer.from(gen.base64, 'base64');
          const saved = saveMediaAsset({
            db,
            tenantId: ctx.tenantId,
            workerId: ctx.workerId,
            buffer,
            ext: extFromMime(gen.mimeType),
            mimeType: gen.mimeType,
            kind: 'image',
            ensureTenantDir,
          });
          url = saved.url;
          markdown = `![${args.purpose || 'תמונה'}](${url})`;
          storeInOutbox(db, ctx, `image:${args.purpose || 'generated'}`, `${url}\n${args.prompt}`);
        }

        const mock = gen.mock === true;
        const mode = mock ? 'mock' : 'google';
        return {
          result: `תמונה נוצרה (${mode}).\n${markdown}\n${gen.caption ? '\n' + gen.caption : ''}`,
          url,
          markdown,
          mock,
          usage: rate,
        };
      },
    },
    {
      name: 'generate_video',
      description: 'Generate a short AI video from a prompt (Google Veo 3.1 Lite). Optional reference image. Returns job ID; polls until ready or timeout.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Video scene description' },
          imageUrl: { type: 'string', description: 'Optional reference image URL (from a prior generate_image result)' },
          durationSeconds: { type: 'number', description: '4-8 seconds (default 4)' },
          resolution: { type: 'string', enum: ['720p', '1080p'], description: 'Default 720p (cheapest)' },
          aspectRatio: { type: 'string', enum: ['16:9', '9:16'], description: 'Default 16:9' },
        },
        required: ['prompt'],
      },
      handler: async (args, ctx) => {
        if (isPromptBlocked(args.prompt)) {
          return { result: 'בקשה נחסמה: תוכן לא מתאים למדיניות הבטיחות.' };
        }

        const allowPlatformMedia = ctx.allowPlatformMedia === true;
        const db = getTenantDb(ctx.tenantId);
        const preflightRate = allowPlatformMedia
          ? checkRateLimit(db, ctx.tenantId)
          : { allowed: true, count: 0, limit: DEFAULT_MONTHLY_LIMIT, period: monthKey(), mock: true };
        if (!preflightRate.allowed) {
          return { result: `מגבלת יצירת מדיה לחודש ${preflightRate.period} הושגה (${preflightRate.count}/${preflightRate.limit}).` };
        }

        let imageBase64;
        let imageMime = 'image/png';
        if (allowPlatformMedia && args.imageUrl) {
          const imageUrl = String(args.imageUrl).trim();
          let parsedImageUrl;
          try { parsedImageUrl = new URL(imageUrl); } catch {}
          if (parsedImageUrl?.protocol !== 'https:') {
            return { result: 'תמונת הייחוס חייבת להיות קישור HTTPS ציבורי לתמונת PNG, JPEG או WebP.', error: 'unsupported_reference_image' };
          }
          const fetched = await fetchPublicHttpContent(imageUrl, {
            timeoutMs: 15_000,
            maxBytes: 10 * 1024 * 1024,
            maxRedirects: 3,
            responseType: 'buffer',
            allowedProtocols: ['https:'],
            headers: { accept: 'image/png,image/jpeg,image/webp' },
          });
          if (!fetched.ok) {
            return { result: 'לא ניתן לטעון את תמונת הייחוס מקישור ציבורי ובטוח.', error: `reference_image_${fetched.error || fetched.status || 'fetch_failed'}` };
          }
          const normalizedMime = String(fetched.contentType || '').split(';', 1)[0].trim().toLowerCase();
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(normalizedMime) || !Buffer.isBuffer(fetched.body)) {
            return { result: 'תמונת הייחוס חייבת להיות PNG, JPEG או WebP.', error: 'unsupported_reference_image_type' };
          }
          imageBase64 = fetched.body.toString('base64');
          imageMime = normalizedMime;
        }

        const rate = allowPlatformMedia
          ? checkAndBumpRateLimit(db, ctx.tenantId)
          : { allowed: true, count: 0, limit: DEFAULT_MONTHLY_LIMIT, period: monthKey(), mock: true };
        if (!rate.allowed) {
          return { result: `מגבלת יצירת מדיה לחודש ${rate.period} הושגה (${rate.count}/${rate.limit}).` };
        }

        const jobId = newId('vidjob');
        const now = new Date().toISOString();
        ensureMediaTables(db, ctx.tenantId);

        const started = allowPlatformMedia
          ? await startVideoGeneration({
              prompt: args.prompt,
              imageBase64,
              imageMime,
              durationSeconds: Math.min(Math.max(Number(args.durationSeconds) || 4, 4), 8),
              resolution: args.resolution || '720p',
              aspectRatio: args.aspectRatio || '16:9',
            })
          : {
              operationName: `mock://video/${crypto.randomBytes(8).toString('hex')}`,
              done: false,
              mock: true,
              model: 'mock',
            };

        db.prepare(`INSERT INTO media_jobs (id, tenant_id, worker_id, kind, status, operation_name, prompt, created_at, updated_at)
          VALUES (?, ?, ?, 'video', 'pending', ?, ?, ?, ?)`).run(
          jobId, ctx.tenantId, ctx.workerId, started.operationName, args.prompt, now, now
        );

        const mockGeneration = started.mock === true || String(started.operationName).startsWith('mock://');
        const maxPolls = mockGeneration || isMediaMockMode() ? 1 : 18;
        let pollResult = started;
        for (let i = 0; i < maxPolls; i++) {
          if (pollResult.done) break;
          await new Promise((r) => setTimeout(r, mockGeneration || isMediaMockMode() ? 50 : 5000));
          pollResult = await pollVideoOperation(started.operationName);
          if (pollResult.done) break;
        }

        if (!pollResult.done) {
          return {
            result: `יצירת וידאו התחילה. מזהה משימה: ${jobId}. בדוק שוב עם check_video_status.`,
            jobId,
            operationName: started.operationName,
            status: 'pending',
          };
        }

        let url = pollResult.videoUri;
        if (pollResult.mock) {
          url = mockSvgDataUrl(args.prompt, 'video');
        } else if (pollResult.videoUri && !pollResult.videoUri.startsWith('mock://')) {
          try {
            const downloaded = await downloadGoogleMediaFile(pollResult.videoUri);
            if (downloaded?.buffer) {
              const saved = saveMediaAsset({
                db,
                tenantId: ctx.tenantId,
                workerId: ctx.workerId,
                buffer: downloaded.buffer,
                ext: extFromMime(downloaded.mimeType),
                mimeType: downloaded.mimeType,
                kind: 'video',
                ensureTenantDir,
              });
              url = saved.url;
            }
          } catch {
            url = pollResult.videoUri;
          }
        }

        db.prepare(`UPDATE media_jobs SET status='done', result_path=?, updated_at=? WHERE id=?`).run(url, new Date().toISOString(), jobId);
        storeInOutbox(db, ctx, 'video:generated', `${url}\n${args.prompt}`);

        const mock = pollResult.mock === true || mockGeneration;
        const mode = mock ? 'mock' : 'google';
        return {
          result: `וידאו נוצר (${mode}).\n[צפה בוידאו](${url})\nמזהה משימה: ${jobId}`,
          jobId,
          url,
          status: 'done',
          mock,
        };
      },
    },
    {
      name: 'check_video_status',
      description: 'Poll a pending video generation job by jobId',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job ID from generate_video' },
        },
        required: ['jobId'],
      },
      handler: async (args, ctx) => {
        const db = getTenantDb(ctx.tenantId);
        ensureMediaTables(db, ctx.tenantId);
        const row = db.prepare(`SELECT * FROM media_jobs WHERE id=? AND worker_id=?`).get(args.jobId, ctx.workerId);
        if (!row) return { result: 'משימת וידאו לא נמצאה.' };
        if (row.status === 'done' && row.result_path) {
          return { result: `הוידאו מוכן: [צפה](${row.result_path})`, url: row.result_path, status: 'done' };
        }

        if (ctx.allowPlatformMedia !== true && !String(row.operation_name).startsWith('mock://')) {
          return {
            result: 'בדיקת וידאו אמיתי זמינה רק לעובד פעיל ובתשלום.',
            status: 'payment_required',
            error: 'platform_media_not_allowed',
          };
        }

        const poll = await pollVideoOperation(row.operation_name);
        if (!poll.done) {
          return { result: 'הוידאו עדיין בעיבוד. נסה שוב בעוד כדקה.', status: 'pending', jobId: args.jobId };
        }

        let url = poll.videoUri;
        if (poll.mock) url = mockSvgDataUrl(row.prompt, 'video');

        db.prepare(`UPDATE media_jobs SET status='done', result_path=?, updated_at=? WHERE id=?`).run(
          url, new Date().toISOString(), args.jobId
        );
        return { result: `הוידאו מוכן: [צפה](${url})`, url, status: 'done' };
      },
    },
  );
}

function mockSvgDataUrl(prompt, kind) {
  const label = String(prompt || '').slice(0, 50).replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect fill="#0f172a" width="640" height="360"/><text x="320" y="170" fill="#38bdf8" font-size="20" text-anchor="middle" font-family="sans-serif">Mock ${kind}</text><text x="320" y="210" fill="#cbd5e1" font-size="14" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
