import db from './db.js';
import { decodeDescriptor } from './merchant-decoder.js';

// Demo mode: creates a realistic linked institution with a checking account,
// a credit card, and ~6 months of transactions — including the kinds of
// cryptic descriptors and recurring subscription charges the app is built to
// explain. Used when no Plaid API keys are configured.

const SUBSCRIPTION_CHARGES = [
  { desc: 'NETFLIX.COM 866-579-7172 CA', amount: 15.49, day: 3, account: 'credit' },
  { desc: 'Spotify USA 877-7781161 NY', amount: 11.99, day: 7, account: 'credit' },
  { desc: 'APPLE.COM/BILL 866-712-7753 CA', amount: 2.99, day: 12, account: 'credit' },
  { desc: 'GOOGLE *YouTubePremium g.co/helppay# CA', amount: 13.99, day: 15, account: 'credit' },
  { desc: 'HLU*HULU 1743497-U 877-8244858 CA', amount: 17.99, day: 18, account: 'credit' },
  { desc: 'PLANET FIT CLUB FEES 844-880-7180 NH', amount: 24.99, day: 17, account: 'checking' },
  { desc: 'ADOBE *CC PHOTOGRAPHY 408-536-6000 CA', amount: 19.99, day: 22, account: 'credit' },
  { desc: 'RING YEARLY PLAN 800-656-1918 CA', amount: 4.99, day: 25, account: 'credit' },
  { desc: 'AMZN Mktp US*RT4Y88SD3 Amzn.com/bill WA', amount: 14.99, day: 27, account: 'credit', note: 'kindle-unlimited' },
];

const ONE_OFF_POOL = [
  { desc: 'SQ *BLUE BOTTLE COFFEE Oakland CA', min: 6, max: 14, account: 'credit' },
  { desc: 'TST* THE HAPPY CLAM - 41 Boston MA', min: 38, max: 120, account: 'credit' },
  { desc: 'PAYPAL *STEAMGAMES 402-935-7733 CA', min: 10, max: 60, account: 'credit' },
  { desc: 'WHOLEFDS BRK 10155 Brooklyn NY', min: 35, max: 140, account: 'credit' },
  { desc: 'TRADER JOE S #543 QPS Brooklyn NY', min: 25, max: 90, account: 'credit' },
  { desc: 'SHELL OIL 57544126800 Jersey City NJ', min: 30, max: 65, account: 'credit' },
  { desc: 'UBER *TRIP HELP.UBER.COM CA', min: 12, max: 45, account: 'credit' },
  { desc: 'DD DOORDASH CHIPOTLE 855-431-0459 CA', min: 18, max: 42, account: 'credit' },
  { desc: 'TARGET 00021212 Brooklyn NY', min: 15, max: 110, account: 'credit' },
  { desc: 'CKE*MYSTERY VENDOR 800-555-0142 TX', min: 9, max: 29, account: 'credit' },
  { desc: 'IN *ACME PLUMBING LLC 917-555-0173 NY', min: 150, max: 420, account: 'checking' },
  { desc: 'ACH WEB-XFER VENMO PAYMENT', min: 20, max: 200, account: 'checking' },
  { desc: 'POS DEBIT DUANE READE #14232 NEW YORK NY', min: 8, max: 40, account: 'checking' },
  { desc: 'EB *TICKETS BROOKLYN MIRAGE NY', min: 45, max: 95, account: 'credit' },
  { desc: 'SP BOWERY SUPPLY CO NEW YORK NY', min: 22, max: 80, account: 'credit' },
];

const INCOME = { desc: 'DIRECT DEP PAYROLL ACME CORP', amount: -3450.0, days: [1, 15] };

// Deterministic PRNG so demo data is stable across restarts.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDemoItem(userId) {
  const rand = mulberry32(42);

  const item = db.prepare(`
    INSERT INTO items (user_id, institution_name, is_demo) VALUES (?, 'First Demo Bank', 1)
  `).run(userId);

  const mkAccount = db.prepare(`
    INSERT INTO accounts (item_id, name, type, subtype, mask, current_balance)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const checkingId = mkAccount.run(item.lastInsertRowid, 'Everyday Checking', 'depository', 'checking', '4821', 5240.33).lastInsertRowid;
  const creditId = mkAccount.run(item.lastInsertRowid, 'Cash Rewards Visa', 'credit', 'credit card', '9017', 1874.6).lastInsertRowid;
  const accountFor = (kind) => (kind === 'checking' ? checkingId : creditId);

  const insertTxn = db.prepare(`
    INSERT INTO transactions (account_id, date, raw_descriptor, merchant_name, amount,
                              category, payment_channel, location, processor, origin_note)
    VALUES (@account_id, @date, @raw, @merchant, @amount, @category, @channel, @location, @processor, @note)
  `);

  const add = (accountId, date, raw, amount) => {
    const d = decodeDescriptor(raw);
    insertTxn.run({
      account_id: accountId,
      date,
      raw,
      merchant: d.merchant,
      amount,
      category: d.category ?? (amount < 0 ? 'Income' : 'Other'),
      channel: d.processor && !/Point of sale|Debit card/.test(d.processor) ? 'online' : 'in store',
      location: d.location,
      processor: d.processor,
      note: d.note,
    });
  };

  const today = new Date();
  const start = new Date(today);
  start.setMonth(start.getMonth() - 6);

  for (let m = 0; m < 7; m++) {
    const monthStart = new Date(start.getFullYear(), start.getMonth() + m, 1);

    for (const sub of SUBSCRIPTION_CHARGES) {
      const d = new Date(monthStart.getFullYear(), monthStart.getMonth(), sub.day);
      if (d < start || d > today) continue;
      add(accountFor(sub.account), d.toISOString().slice(0, 10), sub.desc, sub.amount);
    }

    for (const payday of INCOME.days) {
      const d = new Date(monthStart.getFullYear(), monthStart.getMonth(), payday);
      if (d < start || d > today) continue;
      add(checkingId, d.toISOString().slice(0, 10), INCOME.desc, INCOME.amount);
    }

    const nOneOffs = 12 + Math.floor(rand() * 8);
    for (let i = 0; i < nOneOffs; i++) {
      const pick = ONE_OFF_POOL[Math.floor(rand() * ONE_OFF_POOL.length)];
      const day = 1 + Math.floor(rand() * 28);
      const d = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
      if (d < start || d > today) continue;
      const amount = Math.round((pick.min + rand() * (pick.max - pick.min)) * 100) / 100;
      add(accountFor(pick.account), d.toISOString().slice(0, 10), pick.desc, amount);
    }
  }

  return item.lastInsertRowid;
}
