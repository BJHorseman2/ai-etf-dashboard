# Expense Tracker

A secure, self-hosted personal finance app that links **all** your financial accounts —
bank accounts, debit cards, and credit cards — into one dashboard, explains **where every
charge originated**, and detects recurring subscriptions with a built-in **cancellation
workflow**.

## Features

### 🔗 Link everything
- Real bank/card linking through **Plaid** (12,000+ US institutions). Your bank
  credentials are entered in Plaid's hosted widget and **never touch this server** —
  the app only receives a scoped, revocable access token.
- **Demo mode** out of the box: with no API keys, one click links a realistic sample
  bank (checking + credit card, 6 months of transactions) so you can try every feature.

### 🕵️ Know where every charge came from
Statement descriptors like `SQ *BLUE BOTTLE`, `TST* THE HAPPY CLAM`, or
`CKE*MYSTERY VENDOR 800-555-0142` are decoded automatically. Click any charge to see:
- the **raw descriptor** exactly as your statement shows it
- the **decoded merchant** and category
- the **payment processor** it came through (Square, Toast, PayPal, Stripe, Shopify,
  Apple, Google, Amazon Marketplace, buy-now-pay-later, ACH, …)
- the **location** and the **customer-service phone number** parsed out of the descriptor
- which **card or account** it hit, and a plain-English explanation of how to identify
  or dispute it

### 🔁 Subscription radar + cancellation
- Recurring charges (weekly / monthly / yearly) are detected automatically from cadence
  and amount stability — including their true monthly and yearly cost.
- **Cancel any subscription** from the app:
  1. **Direct path** — cancellation page links and phone numbers for dozens of common
     services (Netflix, Spotify, Hulu, Disney+, Apple, Google, Adobe, gyms, news, …).
  2. **Bank revocation** — for stubborn merchants, the app generates a ready-to-send
     *revocation of authorization* letter for your bank. Under the Electronic Fund
     Transfer Act / Regulation E (and card-network rules), your bank must stop paying a
     recurring charge when you order it to — even if the merchant refuses.
  3. **Status tracking** — subscriptions move through *active → cancelling → cancelled*,
     with the next expected charge date so you can verify it actually stopped.

> Honest note: no consumer app can silently cancel arbitrary subscriptions on your
> behalf — merchants don't expose cancellation APIs. This app gives you the fastest
> legitimate path for each merchant plus the legal bank-stop fallback that always works.

### 🔒 Security design
| Layer | Implementation |
|---|---|
| Bank credentials | Never seen by this app — entered only in Plaid Link |
| Access tokens at rest | AES-256-GCM, key from `ENCRYPTION_KEY` (or a `0600` local dev key) |
| Passwords | bcrypt, cost 12; timing-safe login (dummy-hash compare for unknown emails) |
| Sessions | 256-bit random tokens stored **only as SHA-256 hashes**, httpOnly + SameSite=Strict cookies, 12 h sliding expiry |
| Brute force | Rate limiting on auth (20 / 15 min) and globally (300 / min) |
| CSRF | SameSite=Strict + required custom `X-Requested-With` header on all writes |
| XSS / clickjacking | Strict CSP (self + Plaid only), `frame-ancestors 'none'`, all output HTML-escaped |
| Data locality | Local SQLite database — your data never leaves your machine except to Plaid for syncing |
| Accountability | Audit log of logins, links, syncs, and cancellations (visible in the Security tab) |
| Secrets hygiene | `.env`, database, and keys are git-ignored; `.env.example` documents setup |

## Quick start

```bash
cd expense-tracker
npm install
npm start          # → http://localhost:3000
```

First visit: create your account (email + 10-character-minimum password), then click
**Link an account**. With no Plaid keys configured you'll get the demo bank instantly.

## Linking real banks and cards

1. Create a free account at [dashboard.plaid.com](https://dashboard.plaid.com) and get
   your `client_id` and `secret` (sandbox keys are free; production requires Plaid
   approval).
2. `cp .env.example .env` and fill in:
   ```
   PLAID_CLIENT_ID=your_client_id
   PLAID_SECRET=your_secret
   PLAID_ENV=sandbox        # or development / production
   ENCRYPTION_KEY=<64 hex chars>   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Restart. **Link an account** now opens Plaid Link — sign in to your real bank there.
   In `sandbox`, use Plaid's test credentials (`user_good` / `pass_good`).

## Production checklist

- Serve over HTTPS and set `SECURE_COOKIES=true`
- Set a real `ENCRYPTION_KEY` (never commit it)
- Keep the SQLite file (`data/`) on an encrypted disk with restricted permissions
- Back up `data/` — it contains your transaction history

## Architecture

```
expense-tracker/
├── server/
│   ├── index.js            Express app, helmet CSP, rate limits, error handling
│   ├── config.js           Env config + encryption-key management
│   ├── crypto.js           AES-256-GCM helpers, session-token hashing
│   ├── db.js               SQLite schema (users, items, accounts, transactions,
│   │                       subscriptions, cancellations, audit log)
│   ├── auth.js             Setup/login/logout, sessions, CSRF middleware
│   ├── plaid.js            Plaid Link + incremental transaction sync
│   ├── demo-data.js        Deterministic realistic sample data (no keys needed)
│   ├── merchant-decoder.js Statement-descriptor → merchant/processor/location decoder
│   └── subscriptions.js    Recurring-charge detection + cancellation playbooks
└── public/                 Single-page frontend (no external JS except Plaid Link)
```
