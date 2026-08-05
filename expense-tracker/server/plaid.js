import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import db from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { decodeDescriptor } from './merchant-decoder.js';
import { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV, DEMO_MODE } from './config.js';

// Real bank/card linking via Plaid. The user's bank credentials are entered in
// Plaid's hosted Link widget — they NEVER touch this server. We only receive a
// scoped access token, which is stored AES-256-GCM encrypted.

let client = null;
if (!DEMO_MODE) {
  client = new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[PLAID_ENV],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET': PLAID_SECRET,
      },
    },
  }));
}

export function plaidAvailable() {
  return !DEMO_MODE;
}

export async function createLinkToken(userId) {
  const resp = await client.linkTokenCreate({
    user: { client_user_id: String(userId) },
    client_name: 'Expense Tracker',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
  });
  return resp.data.link_token;
}

export async function exchangePublicToken(userId, publicToken, institutionName) {
  const resp = await client.itemPublicTokenExchange({ public_token: publicToken });
  const info = db.prepare(`
    INSERT INTO items (user_id, plaid_item_id, access_token_enc, institution_name)
    VALUES (?, ?, ?, ?)
  `).run(userId, resp.data.item_id, encrypt(resp.data.access_token), institutionName || 'Linked institution');
  return info.lastInsertRowid;
}

export async function syncItem(itemId) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item || item.is_demo) return { added: 0 };
  const accessToken = decrypt(item.access_token_enc);

  // Refresh accounts + balances.
  const accountsResp = await client.accountsGet({ access_token: accessToken });
  const upsertAccount = db.prepare(`
    INSERT INTO accounts (item_id, plaid_account_id, name, type, subtype, mask, current_balance)
    VALUES (@item_id, @plaid_account_id, @name, @type, @subtype, @mask, @balance)
    ON CONFLICT(item_id, plaid_account_id) DO UPDATE SET
      current_balance = excluded.current_balance, name = excluded.name
  `);
  for (const a of accountsResp.data.accounts) {
    upsertAccount.run({
      item_id: itemId,
      plaid_account_id: a.account_id,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      mask: a.mask,
      balance: a.balances.current,
    });
  }

  const accountIdMap = new Map(
    db.prepare('SELECT id, plaid_account_id FROM accounts WHERE item_id = ?').all(itemId)
      .map((r) => [r.plaid_account_id, r.id])
  );

  // Incremental transaction sync with cursor.
  let cursor = item.sync_cursor || undefined;
  let added = 0;
  let hasMore = true;

  const insertTxn = db.prepare(`
    INSERT INTO transactions (account_id, plaid_txn_id, date, raw_descriptor, merchant_name,
                              amount, currency, category, pending, payment_channel, location,
                              processor, origin_note)
    VALUES (@account_id, @plaid_txn_id, @date, @raw, @merchant, @amount, @currency, @category,
            @pending, @channel, @location, @processor, @note)
    ON CONFLICT(plaid_txn_id) DO UPDATE SET
      pending = excluded.pending, amount = excluded.amount, date = excluded.date
  `);

  while (hasMore) {
    const resp = await client.transactionsSync({ access_token: accessToken, cursor });
    for (const t of [...resp.data.added, ...resp.data.modified]) {
      const accountId = accountIdMap.get(t.account_id);
      if (!accountId) continue;
      const decoded = decodeDescriptor(t.name || t.merchant_name || '');
      const plaidLoc = [t.location?.city, t.location?.region].filter(Boolean).join(', ');
      insertTxn.run({
        account_id: accountId,
        plaid_txn_id: t.transaction_id,
        date: t.date,
        raw: t.name || t.merchant_name || 'Unknown',
        merchant: t.merchant_name || decoded.merchant,
        amount: t.amount,
        currency: t.iso_currency_code || 'USD',
        category: t.personal_finance_category?.primary?.replace(/_/g, ' ').toLowerCase() || decoded.category,
        pending: t.pending ? 1 : 0,
        channel: t.payment_channel,
        location: plaidLoc || decoded.location,
        processor: decoded.processor,
        note: decoded.note,
      });
      added++;
    }
    for (const r of resp.data.removed) {
      db.prepare('DELETE FROM transactions WHERE plaid_txn_id = ?').run(r.transaction_id);
    }
    cursor = resp.data.next_cursor;
    hasMore = resp.data.has_more;
  }

  db.prepare('UPDATE items SET sync_cursor = ? WHERE id = ?').run(cursor, itemId);
  return { added };
}
