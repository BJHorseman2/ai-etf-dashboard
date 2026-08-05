import Database from 'better-sqlite3';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const db = new Database(path.join(DATA_DIR, 'expense-tracker.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- A linked institution (one Plaid Item, or a demo institution)
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plaid_item_id TEXT,
  access_token_enc TEXT,          -- AES-256-GCM encrypted Plaid access token
  institution_name TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  sync_cursor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  plaid_account_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,             -- depository | credit
  subtype TEXT,                   -- checking | savings | credit card ...
  mask TEXT,                      -- last 4 digits
  current_balance REAL,
  UNIQUE(item_id, plaid_account_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plaid_txn_id TEXT UNIQUE,
  date TEXT NOT NULL,
  raw_descriptor TEXT NOT NULL,   -- exactly what the statement shows
  merchant_name TEXT,             -- decoded/enriched merchant
  amount REAL NOT NULL,           -- positive = money out
  currency TEXT NOT NULL DEFAULT 'USD',
  category TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  payment_channel TEXT,           -- online | in store | other
  location TEXT,
  processor TEXT,                 -- decoded payment processor (Square, PayPal…)
  origin_note TEXT                -- human explanation of where the charge came from
);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_key TEXT NOT NULL,     -- normalized merchant identity
  display_name TEXT NOT NULL,
  cadence TEXT NOT NULL,          -- monthly | yearly | weekly
  avg_amount REAL NOT NULL,
  last_charge_date TEXT,
  next_expected_date TEXT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | cancel_requested | cancelled
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, merchant_key)
);

CREATE TABLE IF NOT EXISTS cancellation_requests (
  id INTEGER PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  method TEXT NOT NULL,           -- merchant_portal | phone | bank_revocation
  letter_text TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', -- submitted | confirmed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Security audit trail
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  event TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function audit(userId, event, detail, ip) {
  db.prepare('INSERT INTO audit_log (user_id, event, detail, ip) VALUES (?, ?, ?, ?)')
    .run(userId ?? null, event, detail ?? null, ip ?? null);
}

export default db;
