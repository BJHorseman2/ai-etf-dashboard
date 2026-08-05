import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, DEMO_MODE } from './config.js';
import { authRouter, requireCsrfHeader } from './auth.js';
import { apiRouter } from './routes.js';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Strict security headers. The CSP allows Plaid Link's script/iframe and
// nothing else external; all app JS/CSS is served same-origin.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.plaid.com'],
      frameSrc: ['https://cdn.plaid.com'],
      connectSrc: ["'self'", 'https://cdn.plaid.com', 'https://production.plaid.com', 'https://sandbox.plaid.com'],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      // Removed (helmet default): it breaks CSS/JS loading when the app is
      // served over plain HTTP on a LAN/Tailscale IP — Safari upgrades asset
      // requests to https, which the server doesn't speak on that port.
      upgradeInsecureRequests: null,
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
}));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
}));

app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(requireCsrfHeader);

app.use('/api/auth', authRouter);
app.use('/api', apiRouter);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res) { res.setHeader('Cache-Control', 'no-store'); },
}));

// JSON error handler — never leak stack traces to the client.
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Purge expired sessions hourly.
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}, 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Expense Tracker running at http://localhost:${PORT}`);
  console.log(DEMO_MODE
    ? '[mode] DEMO — no Plaid keys found; a sample bank can be linked. Add PLAID_CLIENT_ID/PLAID_SECRET to .env for real accounts.'
    : '[mode] PLAID — real bank/card linking enabled.');
});
