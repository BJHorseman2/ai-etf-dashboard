import express from 'express';
import db, { audit } from './db.js';
import { requireAuth } from './auth.js';
import { DEMO_MODE } from './config.js';
import { createDemoItem } from './demo-data.js';
import { plaidAvailable, createLinkToken, exchangePublicToken, syncItem } from './plaid.js';
import { detectSubscriptions, playbookFor, revocationLetter } from './subscriptions.js';

export const apiRouter = express.Router();
apiRouter.use(requireAuth);

apiRouter.get('/me', (req, res) => {
  res.json({ email: req.user.email, demoMode: DEMO_MODE });
});

// ── Linking accounts ────────────────────────────────────────────────────────

apiRouter.get('/link/mode', (req, res) => {
  res.json({ mode: plaidAvailable() ? 'plaid' : 'demo' });
});

apiRouter.post('/link/token', async (req, res, next) => {
  try {
    if (!plaidAvailable()) return res.status(400).json({ error: 'Plaid not configured; use demo mode.' });
    res.json({ link_token: await createLinkToken(req.user.id) });
  } catch (e) { next(e); }
});

apiRouter.post('/link/exchange', async (req, res, next) => {
  try {
    const { public_token, institution_name } = req.body ?? {};
    if (typeof public_token !== 'string') return res.status(400).json({ error: 'Missing public_token.' });
    const itemId = await exchangePublicToken(req.user.id, public_token, String(institution_name || '').slice(0, 100));
    await syncItem(itemId);
    detectSubscriptions(req.user.id);
    audit(req.user.id, 'institution_linked', String(institution_name || ''), req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

apiRouter.post('/link/demo', (req, res) => {
  if (plaidAvailable()) return res.status(400).json({ error: 'Plaid is configured; link a real institution.' });
  const already = db.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND is_demo = 1').get(req.user.id).n;
  if (already > 0) return res.status(400).json({ error: 'Demo bank already linked.' });
  createDemoItem(req.user.id);
  detectSubscriptions(req.user.id);
  audit(req.user.id, 'demo_institution_linked', null, req.ip);
  res.json({ ok: true });
});

apiRouter.post('/sync', async (req, res, next) => {
  try {
    const items = db.prepare('SELECT id FROM items WHERE user_id = ? AND is_demo = 0').all(req.user.id);
    let added = 0;
    for (const item of items) added += (await syncItem(item.id)).added;
    detectSubscriptions(req.user.id);
    res.json({ ok: true, added });
  } catch (e) { next(e); }
});

apiRouter.delete('/items/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?')
    .get(Number(req.params.id), req.user.id);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
  audit(req.user.id, 'institution_unlinked', item.institution_name, req.ip);
  res.json({ ok: true });
});

// ── Accounts & transactions ─────────────────────────────────────────────────

apiRouter.get('/accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, i.institution_name, i.is_demo
    FROM accounts a JOIN items i ON i.id = a.item_id
    WHERE i.user_id = ?
    ORDER BY i.institution_name, a.type
  `).all(req.user.id);
  res.json(rows);
});

apiRouter.get('/transactions', (req, res) => {
  const { q, account_id, limit } = req.query;
  const params = { user_id: req.user.id };
  let where = 'i.user_id = @user_id';
  if (account_id) { where += ' AND a.id = @account_id'; params.account_id = Number(account_id); }
  if (q) {
    where += ' AND (t.raw_descriptor LIKE @q OR t.merchant_name LIKE @q OR t.processor LIKE @q)';
    params.q = `%${String(q).slice(0, 100)}%`;
  }
  const rows = db.prepare(`
    SELECT t.*, a.name AS account_name, a.mask AS account_mask, a.type AS account_type,
           i.institution_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    JOIN items i ON i.id = a.item_id
    WHERE ${where}
    ORDER BY t.date DESC, t.id DESC
    LIMIT @limit
  `).all({ ...params, limit: Math.min(Number(limit) || 300, 1000) });
  res.json(rows);
});

apiRouter.get('/summary', (req, res) => {
  const monthly = db.prepare(`
    SELECT substr(t.date, 1, 7) AS month,
           SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) AS spent,
           SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) AS received
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    JOIN items i ON i.id = a.item_id
    WHERE i.user_id = ?
    GROUP BY month ORDER BY month DESC LIMIT 7
  `).all(req.user.id);

  const byCategory = db.prepare(`
    SELECT COALESCE(t.category, 'Other') AS category, SUM(t.amount) AS total
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    JOIN items i ON i.id = a.item_id
    WHERE i.user_id = ? AND t.amount > 0 AND t.date >= date('now', '-30 days')
    GROUP BY category ORDER BY total DESC LIMIT 10
  `).all(req.user.id);

  res.json({ monthly: monthly.reverse(), byCategory });
});

// ── Subscriptions & cancellation ────────────────────────────────────────────

apiRouter.get('/subscriptions', (req, res) => {
  detectSubscriptions(req.user.id);
  const subs = db.prepare(`
    SELECT s.*, a.name AS account_name, a.mask AS account_mask
    FROM subscriptions s LEFT JOIN accounts a ON a.id = s.account_id
    WHERE s.user_id = ?
    ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'cancel_requested' THEN 1 ELSE 2 END,
             s.avg_amount * (CASE s.cadence WHEN 'yearly' THEN 1 WHEN 'weekly' THEN 52 ELSE 12 END) DESC
  `).all(req.user.id);

  const enriched = subs.map((s) => ({
    ...s,
    monthly_cost: s.cadence === 'yearly' ? s.avg_amount / 12
      : s.cadence === 'weekly' ? (s.avg_amount * 52) / 12
      : s.avg_amount,
    playbook: playbookFor(s.merchant_key, s.display_name),
  }));
  res.json(enriched);
});

// Start a cancellation: returns the playbook + a bank revocation letter, and
// records the request so status is tracked.
apiRouter.post('/subscriptions/:id/cancel', (req, res) => {
  const sub = db.prepare(`
    SELECT s.*, a.name AS account_name, a.mask AS account_mask
    FROM subscriptions s LEFT JOIN accounts a ON a.id = s.account_id
    WHERE s.id = ? AND s.user_id = ?
  `).get(Number(req.params.id), req.user.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found.' });

  const method = ['merchant_portal', 'phone', 'bank_revocation'].includes(req.body?.method)
    ? req.body.method : 'merchant_portal';

  const letter = revocationLetter({
    userEmail: req.user.email,
    merchant: sub.display_name,
    amount: sub.avg_amount,
    cadence: sub.cadence,
    accountName: sub.account_name || 'my account',
    mask: sub.account_mask,
    today: new Date().toISOString().slice(0, 10),
  });

  db.prepare('INSERT INTO cancellation_requests (subscription_id, method, letter_text) VALUES (?, ?, ?)')
    .run(sub.id, method, letter);
  db.prepare("UPDATE subscriptions SET status = 'cancel_requested' WHERE id = ?").run(sub.id);
  audit(req.user.id, 'cancellation_started', `${sub.display_name} via ${method}`, req.ip);

  res.json({ ok: true, playbook: playbookFor(sub.merchant_key, sub.display_name), letter });
});

// Mark a cancellation confirmed (user verified with the merchant/bank).
apiRouter.post('/subscriptions/:id/confirm-cancelled', (req, res) => {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?')
    .get(Number(req.params.id), req.user.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found.' });
  db.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?").run(sub.id);
  db.prepare("UPDATE cancellation_requests SET status = 'confirmed' WHERE subscription_id = ?").run(sub.id);
  audit(req.user.id, 'cancellation_confirmed', sub.display_name, req.ip);
  res.json({ ok: true });
});

// Not actually a subscription — remove it from the radar.
apiRouter.delete('/subscriptions/:id', (req, res) => {
  const info = db.prepare('DELETE FROM subscriptions WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Subscription not found.' });
  res.json({ ok: true });
});

apiRouter.get('/audit-log', (req, res) => {
  const rows = db.prepare(
    'SELECT event, detail, ip, at FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 50'
  ).all(req.user.id);
  res.json(rows);
});
