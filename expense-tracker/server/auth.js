import bcrypt from 'bcryptjs';
import express from 'express';
import rateLimit from 'express-rate-limit';
import db, { audit } from './db.js';
import { hashToken, newSessionToken } from './crypto.js';
import { SESSION_TTL_MS, SECURE_COOKIES } from './config.js';

const COOKIE = 'et_session';
const BCRYPT_ROUNDS = 12;

export const authRouter = express.Router();

// Brute-force protection on all auth endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});
authRouter.use(authLimiter);

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: SECURE_COOKIES,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function createSession(userId) {
  const token = newSessionToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 10 && pw.length <= 200;
}
function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}

// First-run: is an account set up yet?
authRouter.get('/status', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({ setupComplete: count > 0 });
});

// One-time account creation (single-user app: refuses once a user exists).
authRouter.post('/setup', async (req, res) => {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (existing > 0) return res.status(403).json({ error: 'Account already exists. Please log in.' });

  const { email, password } = req.body ?? {};
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!validPassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email.toLowerCase(), hash);
  audit(info.lastInsertRowid, 'account_created', email.toLowerCase(), req.ip);

  setSessionCookie(res, createSession(info.lastInsertRowid));
  res.json({ ok: true });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  const user = validEmail(email)
    ? db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase())
    : null;

  // Compare against a dummy hash when the user doesn't exist so response
  // timing doesn't reveal which emails are registered.
  const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvaliduBOG3lQ8jsFRTzXfC1Kf7O0X8u9C2';
  const ok = typeof password === 'string' && (await bcrypt.compare(password, hash)) && !!user;

  if (!ok) {
    audit(user?.id, 'login_failed', email, req.ip);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  audit(user.id, 'login_success', null, req.ip);
  setSessionCookie(res, createSession(user.id));
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// Middleware: require a valid, unexpired session.
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in.' });

  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!session || session.expires_at < Date.now()) {
    if (session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }

  // Sliding expiry.
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run(Date.now() + SESSION_TTL_MS, session.token_hash);

  req.user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(session.user_id);
  next();
}

// CSRF defense-in-depth: state-changing requests must carry a custom header,
// which cross-origin forms cannot set (combined with SameSite=Strict cookies).
export function requireCsrfHeader(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      req.headers['x-requested-with'] !== 'expense-tracker') {
    return res.status(403).json({ error: 'Missing CSRF header.' });
  }
  next();
}
