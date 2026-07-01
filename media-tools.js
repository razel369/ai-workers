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

function ensureMediaTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_gen_usage (
      tenant_id TEXT NOT NULL,
      period TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, period)
    );
    CREATE TABLE IF NOT EXISTS media_jobs (
      id TEXT PRIMARY KEY,
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
  `);
}

function checkAndBumpRateLimit(db, tenantId) {
  ensureMediaTables(db);
  const period = monthKey();
  const row = db.prepare(`SELECT count FROM media_gen_usage WHERE tenant_id=? AND period=?`).get(tenantId, period);
  const count = row?.count ?? 0;
  if (count >= DEFAULT_MONTHLY_LIMIT) {
    return { allowed: false, count, limit: DEFAULT_MONTHLY_LIMIT, period };
  }
  db.prepare(`INSERT INTO media_gen_usage (tenant_id, period, count) VALUES (?, ?, 1)
    ON CONFLICT(tenant_id, period) DO UPDATE SET count = count + 1`).run(tenantId, period);
  return { allowed: true, count: count + 1, limit: DEFAULT_MONTHLY_LIMIT, period };
}

function mediaDir(tenantId, ensureTenantDir) {
  const base = ensureTenantDir(tenantId);
  const dir = path.join(base, 'media');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'http://localhost:8765').replace(/\/$/, '');
}

function saveMediaAsset({ tenantId, workerId, buffer, ext, mimeType, ensureTenantDir }) {
  const dir = mediaDir(tenantId, ensureTenantDir);
  const id = `med_${crypto.randomBytes(8).toString('hex')}`;
  const filename = `${id}.${ext}`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);
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

export function resolveMediaFile(tenantId, filename, ensureTenantDir) {
  const safe = path.basename(filename);
  if (!/^med_[a-f0-9]+\.(png|jpg|jpeg|webp|svg|mp4)$/i.test(safe)) return null;
  const filePath = path.join(mediaDir(tenantId, ensureTenantDir), safe);
  if (!fs.existsSync(filePath)) return null;
  return filePath;
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

        const db = getTenantDb(ctx.tenantId);
        const rate = checkAndBumpRateLimit(db, ctx.tenantId);
        if (!rate.allowed) {
          return { result: `מגבלת יצירת מדיה לחודש ${rate.period} הושגה (${rate.count}/${rate.limit}). נסה בחודש הבא או פנה למנהל המערכת.` };
        }

        const aspectRatio = args.aspectRatio || '1:1';
        const gen = await generateImage({ prompt: args.prompt, aspectRatio });

        let url;
        let markdown;

        if (gen.mock && gen.dataUrl) {
          url = gen.dataUrl;
          markdown = `![${args.purpose || 'תמונה'}](${url})`;
        } else {
          const buffer = Buffer.from(gen.base64, 'base64');
          const saved = saveMediaAsset({
            tenantId: ctx.tenantId,
            workerId: ctx.workerId,
            buffer,
            ext: extFromMime(gen.mimeType),
            mimeType: gen.mimeType,
            ensureTenantDir,
          });
          url = saved.url;
          markdown = `![${args.purpose || 'תמונה'}](${url})`;
          storeInOutbox(db, ctx, `image:${args.purpose || 'generated'}`, `${url}\n${args.prompt}`);
        }

        const mode = isMediaMockMode() ? 'mock' : 'google';
        return {
          result: `תמונה נוצרה (${mode}).\n${markdown}\n${gen.caption ? '\n' + gen.caption : ''}`,
          url,
          markdown,
          mock: isMediaMockMode(),
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

        const db = getTenantDb(ctx.tenantId);
        const rate = checkAndBumpRateLimit(db, ctx.tenantId);
        if (!rate.allowed) {
          return { result: `מגבלת יצירת מדיה לחודש ${rate.period} הושגה (${rate.count}/${rate.limit}).` };
        }

        let imageBase64;
        let imageMime = 'image/png';
        if (args.imageUrl && !String(args.imageUrl).startsWith('data:')) {
          try {
            const imgRes = await fetch(args.imageUrl, { signal: AbortSignal.timeout(15_000) });
            if (imgRes.ok) {
              const buf = Buffer.from(await imgRes.arrayBuffer());
              imageBase64 = buf.toString('base64');
              imageMime = imgRes.headers.get('content-type') || 'image/png';
            }
          } catch {}
        }

        const jobId = newId('vidjob');
        const now = new Date().toISOString();
        ensureMediaTables(db);

        const started = await startVideoGeneration({
          prompt: args.prompt,
          imageBase64,
          imageMime,
          durationSeconds: Math.min(Math.max(Number(args.durationSeconds) || 4, 4), 8),
          resolution: args.resolution || '720p',
          aspectRatio: args.aspectRatio || '16:9',
        });

        db.prepare(`INSERT INTO media_jobs (id, worker_id, kind, status, operation_name, prompt, created_at, updated_at)
          VALUES (?, ?, 'video', 'pending', ?, ?, ?, ?)`).run(
          jobId, ctx.workerId, started.operationName, args.prompt, now, now
        );

        const maxPolls = isMediaMockMode() ? 1 : 18;
        let pollResult = started;
        for (let i = 0; i < maxPolls; i++) {
          if (pollResult.done) break;
          await new Promise((r) => setTimeout(r, isMediaMockMode() ? 50 : 5000));
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
                tenantId: ctx.tenantId,
                workerId: ctx.workerId,
                buffer: downloaded.buffer,
                ext: extFromMime(downloaded.mimeType),
                mimeType: downloaded.mimeType,
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

        const mode = isMediaMockMode() ? 'mock' : 'google';
        return {
          result: `וידאו נוצר (${mode}).\n[צפה בוידאו](${url})\nמזהה משימה: ${jobId}`,
          jobId,
          url,
          status: 'done',
          mock: isMediaMockMode(),
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
        ensureMediaTables(db);
        const row = db.prepare(`SELECT * FROM media_jobs WHERE id=? AND worker_id=?`).get(args.jobId, ctx.workerId);
        if (!row) return { result: 'משימת וידאו לא נמצאה.' };
        if (row.status === 'done' && row.result_path) {
          return { result: `הוידאו מוכן: [צפה](${row.result_path})`, url: row.result_path, status: 'done' };
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
