import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKUP_FORMAT = 'ai-workers-encrypted-backup-v2';
export const BACKUP_CIPHER = 'aes-256-cbc';
export const BACKUP_KDF = 'pbkdf2-hmac-sha256';
export const BACKUP_ITERATIONS = 250_000;
const ARCHIVE_NAME = /^ai-workers-data-\d{8}T\d{6}Z\.tar\.gz\.enc$/;

function secret() {
  const value = String(process.env.BACKUP_MANIFEST_SECRET ?? '');
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('BACKUP_MANIFEST_SECRET must contain at least 32 bytes');
  }
  return value;
}

function regularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return stat;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function signature(bytes) {
  return crypto.createHmac('sha256', secret()).update(bytes).digest('base64url');
}

export function createManifest({ archivePath, manifestPath, signaturePath, createdAt }) {
  const archiveName = path.basename(archivePath);
  if (!ARCHIVE_NAME.test(archiveName)) throw new Error('invalid encrypted backup archive name');
  const stat = regularFile(archivePath, 'archive');
  if (!/^\d{8}T\d{6}Z$/.test(String(createdAt ?? ''))) throw new Error('invalid backup timestamp');
  const manifest = {
    format: BACKUP_FORMAT,
    archive: archiveName,
    createdAt,
    cipher: BACKUP_CIPHER,
    kdf: BACKUP_KDF,
    iterations: BACKUP_ITERATIONS,
    ciphertextBytes: stat.size,
    ciphertextSha256: sha256File(archivePath),
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(manifestPath, bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(signaturePath, `${signature(bytes)}\n`, { flag: 'wx', mode: 0o600 });
  return manifest;
}

export function verifyManifest({ archivePath, manifestPath, signaturePath }) {
  const archiveName = path.basename(archivePath);
  if (!ARCHIVE_NAME.test(archiveName)) throw new Error('invalid encrypted backup archive name');
  const archiveStat = regularFile(archivePath, 'archive');
  const manifestStat = regularFile(manifestPath, 'manifest');
  const signatureStat = regularFile(signaturePath, 'manifest signature');
  if (manifestStat.size > 16 * 1024 || signatureStat.size > 512) throw new Error('backup manifest is too large');
  const bytes = fs.readFileSync(manifestPath);
  const expected = Buffer.from(signature(bytes), 'utf8');
  const actualText = fs.readFileSync(signaturePath, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(actualText)) throw new Error('invalid manifest signature encoding');
  const actual = Buffer.from(actualText, 'utf8');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('backup manifest signature mismatch');
  }
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('backup manifest is not valid JSON'); }
  if (manifest?.format !== BACKUP_FORMAT
      || manifest?.archive !== archiveName
      || manifest?.cipher !== BACKUP_CIPHER
      || manifest?.kdf !== BACKUP_KDF
      || manifest?.iterations !== BACKUP_ITERATIONS
      || !/^\d{8}T\d{6}Z$/.test(String(manifest?.createdAt ?? ''))
      || !/^[a-f0-9]{64}$/.test(String(manifest?.ciphertextSha256 ?? ''))
      || !Number.isSafeInteger(manifest?.ciphertextBytes)
      || manifest.ciphertextBytes < 1) {
    throw new Error('backup manifest metadata is invalid');
  }
  if (manifest.ciphertextBytes !== archiveStat.size || manifest.ciphertextSha256 !== sha256File(archivePath)) {
    throw new Error('encrypted backup does not match its signed manifest');
  }
  return manifest;
}

function main() {
  const [command, archivePath, manifestPath, signaturePath, createdAt] = process.argv.slice(2);
  if (!['create', 'verify'].includes(command) || !archivePath || !manifestPath || !signaturePath) {
    throw new Error('usage: node backup-manifest.mjs create|verify ARCHIVE MANIFEST SIGNATURE [TIMESTAMP]');
  }
  const result = command === 'create'
    ? createManifest({ archivePath, manifestPath, signaturePath, createdAt })
    : verifyManifest({ archivePath, manifestPath, signaturePath });
  process.stdout.write(`${JSON.stringify({ ok: true, format: result.format, archive: result.archive })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(`Backup manifest error: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
