import crypto from 'node:crypto';
import { ENCRYPTION_KEY } from './config.js';

// AES-256-GCM authenticated encryption for secrets at rest (bank access tokens).
// Output format: base64(iv | authTag | ciphertext)

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decrypt(encoded) {
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Session tokens are stored only as SHA-256 hashes so a database leak
// cannot be replayed as a live session.
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}
