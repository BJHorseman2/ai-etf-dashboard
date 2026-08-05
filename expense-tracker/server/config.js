import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

export const PORT = Number(process.env.PORT) || 3000;
export const SECURE_COOKIES = process.env.SECURE_COOKIES === 'true';

export const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
export const PLAID_SECRET = process.env.PLAID_SECRET || '';
export const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
export const DEMO_MODE = !(PLAID_CLIENT_ID && PLAID_SECRET);

// 32-byte key for AES-256-GCM encryption of access tokens at rest.
// Prefer ENCRYPTION_KEY from the environment; otherwise generate one once and
// persist it locally (0600) so dev restarts can still decrypt stored tokens.
function loadEncryptionKey() {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
      throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
    return Buffer.from(envKey, 'hex');
  }
  const keyFile = path.join(DATA_DIR, '.local-key');
  if (fs.existsSync(keyFile)) {
    return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString('hex') + '\n', { mode: 0o600 });
  console.warn(
    '[security] No ENCRYPTION_KEY set — generated a local key at data/.local-key. ' +
    'Set ENCRYPTION_KEY in .env for production.'
  );
  return key;
}

export const ENCRYPTION_KEY = loadEncryptionKey();

export const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
