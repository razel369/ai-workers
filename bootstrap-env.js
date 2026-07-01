// Must load before any module that reads DB_PATH / TENANTS_DIR at import time.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function isServerlessRuntime() {
  return Boolean(
    process.env.VERCEL === '1' ||
    process.env.VERCEL === 'true' ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT ||
    process.env.AWS_EXECUTION_ENV ||
    __dirname.startsWith('/var/task')
  );
}

const SERVERLESS_DATA_ROOT = '/tmp/ai-workers-data';

export function ensureServerlessDataEnv() {
  if (!isServerlessRuntime()) return;
  process.env.DB_PATH = path.join(SERVERLESS_DATA_ROOT, 'earnings.db');
  process.env.TENANTS_DIR = path.join(SERVERLESS_DATA_ROOT, 'tenants');
  if (!process.env.TRUST_PROXY_HEADERS) {
    process.env.TRUST_PROXY_HEADERS = '1';
  }
}

ensureServerlessDataEnv();
