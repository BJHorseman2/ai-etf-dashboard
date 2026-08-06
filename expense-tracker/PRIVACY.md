# Privacy Policy — Expense Tracker

**Effective date:** August 6, 2026 · **Version 1.0**
**Operator and sole user:** Mark Baumrind (marksbaumrind@gmail.com)

Expense Tracker is a self-hosted personal finance application operated by its owner for
the owner's exclusive use. It has exactly one user — the operator — and collects no data
about any other person.

## 1. Data collected

Through the Plaid API, and only after the owner authenticates directly with their
financial institution inside Plaid Link, the application receives:

- Account metadata for the owner's own accounts (institution name, account name and
  type, last-four account mask, balances)
- Transaction history for those accounts (date, amount, merchant/descriptor,
  category, location where provided)

The application never receives, requests, or stores online-banking usernames or
passwords. Bank authentication occurs exclusively within Plaid's hosted Link widget.

## 2. How data is used

Data is used solely to display the owner's own finances to the owner: transaction
review, merchant identification, spending summaries, and detection of recurring
subscription charges. There is no advertising, profiling, or automated decision-making
affecting any person.

## 3. Storage and security

All data is stored locally on hardware owned and physically controlled by the operator,
on a full-disk-encrypted volume (macOS FileVault). Plaid access tokens are additionally
encrypted with AES-256-GCM. The application is not exposed to the public internet;
remote access requires an encrypted private network (WireGuard/Tailscale) limited to
the owner's authenticated devices. Application login requires a password stored only as
a bcrypt hash. Security controls are documented in the accompanying Information
Security Policy.

## 4. Sharing and third parties

Data is never sold, rented, or shared with any third party. The sole external service
involved is **Plaid Inc.**, which acts as the data source connecting to financial
institutions; Plaid's own privacy policy is available at
https://plaid.com/legal/#end-user-privacy-policy. No analytics, tracking, or
advertising services are used.

## 5. Consent

The only data subject is the operator, who consents to collection and processing by
linking their own accounts. Linking is always initiated manually by the owner and can
be reversed at any time.

## 6. Retention and deletion

Data is retained locally until the owner deletes it. Unlinking an institution in the
application permanently deletes its stored data and revokes the associated Plaid
connection. The owner may also delete the entire local database at any time. This
policy and the retention practice are reviewed at least annually.

## 7. Contact

Questions about this policy: marksbaumrind@gmail.com
