import db from './db.js';
import { merchantKey, decodeDescriptor } from './merchant-decoder.js';

// ── Recurring-charge detection ──────────────────────────────────────────────
// Groups transactions by normalized merchant, then looks for a stable cadence
// (weekly / monthly / yearly) with similar amounts.

const CADENCES = [
  { name: 'weekly', days: 7, tolerance: 2 },
  { name: 'monthly', days: 30, tolerance: 6 },
  { name: 'yearly', days: 365, tolerance: 20 },
];

export function detectSubscriptions(userId) {
  const txns = db.prepare(`
    SELECT t.* FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    JOIN items i ON i.id = a.item_id
    WHERE i.user_id = ? AND t.amount > 0
    ORDER BY t.date ASC
  `).all(userId);

  const groups = new Map();
  for (const t of txns) {
    const key = merchantKey(t.merchant_name || t.raw_descriptor);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const upsert = db.prepare(`
    INSERT INTO subscriptions (user_id, merchant_key, display_name, cadence, avg_amount,
                               last_charge_date, next_expected_date, account_id)
    VALUES (@user_id, @merchant_key, @display_name, @cadence, @avg_amount,
            @last_charge_date, @next_expected_date, @account_id)
    ON CONFLICT(user_id, merchant_key) DO UPDATE SET
      cadence = excluded.cadence,
      avg_amount = excluded.avg_amount,
      last_charge_date = excluded.last_charge_date,
      next_expected_date = excluded.next_expected_date,
      account_id = excluded.account_id
  `);

  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const dates = list.map((t) => new Date(t.date + 'T00:00:00Z').getTime());
    const gaps = [];
    for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 86400000);
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

    const cadence = CADENCES.find((c) => Math.abs(avgGap - c.days) <= c.tolerance);
    if (!cadence) continue;
    // Require consistent gaps, not just a matching average.
    if (!gaps.every((g) => Math.abs(g - cadence.days) <= cadence.tolerance * 2)) continue;

    const amounts = list.map((t) => t.amount);
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    // Amounts should be stable within 20% (allows small price changes/tax).
    if (!amounts.every((a) => Math.abs(a - avgAmount) / avgAmount <= 0.2)) continue;

    const last = list[list.length - 1];
    const nextMs = dates[dates.length - 1] + cadence.days * 86400000;

    upsert.run({
      user_id: userId,
      merchant_key: key,
      display_name: decodeDescriptor(last.merchant_name || last.raw_descriptor).merchant,
      cadence: cadence.name,
      avg_amount: Math.round(avgAmount * 100) / 100,
      last_charge_date: last.date,
      next_expected_date: new Date(nextMs).toISOString().slice(0, 10),
      account_id: last.account_id,
    });
  }
}

// ── Cancellation playbooks ──────────────────────────────────────────────────
// Direct self-service cancellation paths for common subscription merchants.

const PLAYBOOKS = {
  NETFLIX: { url: 'https://www.netflix.com/cancelplan', phone: '1-866-579-7172', how: 'Account → Cancel Membership. Takes effect at the end of the billing period.' },
  SPOTIFY: { url: 'https://www.spotify.com/account/subscription/', phone: null, how: 'Account → Available plans → Cancel Premium.' },
  HULU: { url: 'https://secure.hulu.com/account', phone: '1-888-265-6650', how: 'Account → Cancel. If billed through Disney+, Roku, or Apple, cancel there instead.' },
  DISNEY: { url: 'https://www.disneyplus.com/account/subscription', phone: '1-888-905-7888', how: 'Account → Subscription → Cancel.' },
  MAX_HBO: { url: 'https://www.max.com/account', phone: null, how: 'Account → Subscription → Cancel. If billed via a TV/app provider, cancel with them.' },
  AUDIBLE: { url: 'https://www.audible.com/account/membership', phone: '1-888-283-5051', how: 'Account details → Cancel membership (you keep purchased titles).' },
  AMAZON_PRIME: { url: 'https://www.amazon.com/mc/pipelines/cancellation', phone: '1-888-280-4331', how: 'Prime membership → End membership.' },
  APPLE: { url: 'https://support.apple.com/en-us/HT202039', phone: '1-800-275-2273', how: 'iPhone: Settings → your name → Subscriptions → select → Cancel.' },
  GOOGLE: { url: 'https://play.google.com/store/account/subscriptions', phone: null, how: 'Play Store → Payments & subscriptions → Cancel.' },
  YOUTUBE_PREMIUM: { url: 'https://www.youtube.com/paid_memberships', phone: null, how: 'YouTube → Settings → Memberships → Manage → Cancel. If billed through Apple, cancel in iPhone Settings → Subscriptions.' },
  KINDLE_UNLIMITED: { url: 'https://www.amazon.com/kindle-dbs/ku/ku-central', phone: '1-888-280-4331', how: 'Amazon → Manage Your Kindle Unlimited Membership → Cancel.' },
  PLANET_FITNESS: { url: 'https://www.planetfitness.com/manage-membership', phone: null, how: 'Most locations require an in-club visit or certified letter to your home club. State law increasingly allows online cancellation — check your club.' },
  EQUINOX: { url: 'https://www.equinox.com/concierge', phone: '1-866-332-6549', how: 'Requires written notice to the club (email or letter), typically 30 days.' },
  PELOTON: { url: 'https://members.onepeloton.com/preferences/subscriptions', phone: '1-866-679-9129', how: 'Membership preferences → Cancel.' },
  ADOBE: { url: 'https://account.adobe.com/plans', phone: '1-800-833-6687', how: 'Plans → Manage plan → Cancel plan. Watch for early-termination fees on annual plans.' },
  MICROSOFT: { url: 'https://account.microsoft.com/services/', phone: '1-800-642-7676', how: 'Services & subscriptions → Manage → Cancel.' },
  DROPBOX: { url: 'https://www.dropbox.com/account/plan', phone: null, how: 'Settings → Plan → Cancel plan.' },
  OPENAI_CHATGPT: { url: 'https://chatgpt.com/#settings/Subscription', phone: null, how: 'Settings → Subscription → Manage → Cancel plan.' },
  ANTHROPIC_CLAUDE: { url: 'https://claude.ai/settings/billing', phone: null, how: 'Settings → Billing → Cancel subscription.' },
  THE_NEW_YORK_TIMES: { url: 'https://www.nytimes.com/account/subscription', phone: '1-800-698-4637', how: 'Account → Subscription overview → Cancel. Chat/phone may be required in some regions.' },
  THE_WALL_STREET_JOURNAL: { url: 'https://customercenter.wsj.com/subscription', phone: '1-800-568-7625', how: 'Customer Center → Cancel subscription (phone required for some plans).' },
  SUBSTACK: { url: 'https://substack.com/settings', phone: null, how: 'Settings → Subscriptions → select publication → Cancel.' },
  PATREON: { url: 'https://www.patreon.com/settings/memberships', phone: null, how: 'Settings → Memberships → Edit → Cancel.' },
  RING_HOME_SECURITY: { url: 'https://account.ring.com/account/plan', phone: '1-800-656-1918', how: 'Account → Plan → Cancel.' },
  SIRIUSXM: { url: 'https://www.siriusxm.com/cancel', phone: '1-866-635-2349', how: 'Online chat or phone; expect a retention offer.' },
};

export function playbookFor(key, displayName) {
  const hit = Object.entries(PLAYBOOKS).find(([k]) => key.includes(k) || k.includes(key));
  return hit ? { known: true, ...hit[1] } : {
    known: false,
    url: null,
    phone: null,
    how: `No direct cancellation link on file for ${displayName}. Log in to their website/app and look for Account → Subscription/Billing → Cancel. If there is no self-service option, use the bank revocation letter below.`,
  };
}

// A stop-payment / revoked-authorization letter. Under US law (Reg E for debit,
// and card-network rules for credit), you can order your bank to stop paying a
// recurring charge even if the merchant is unresponsive.
export function revocationLetter({ userEmail, merchant, amount, cadence, accountName, mask, today }) {
  return `Date: ${today}

To: Disputes / Payment Authorization Department

Re: Revocation of authorization for recurring charges — ${merchant}

To whom it may concern,

I am writing to revoke authorization for recurring ${cadence} charges of approximately $${amount.toFixed(2)} from "${merchant}" to my account "${accountName}" ending in ${mask ?? '••••'}.

Effective immediately, I withdraw any prior authorization for this merchant to debit or charge this account. Under the Electronic Fund Transfer Act and Regulation E (12 CFR 1005.10) for electronic debits, and applicable card-network rules for card charges, I request that you:

1. Block or stop payment on all future charges from this merchant;
2. Treat any charge from this merchant after the date of this notice as unauthorized; and
3. Confirm this revocation in writing.

I have also attempted to cancel directly with the merchant. Please contact me at ${userEmail} if you need any further information.

Sincerely,
Account holder`;
}
