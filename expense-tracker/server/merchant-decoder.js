// Decodes cryptic card-statement descriptors into a human answer for
// "where did this charge come from?". Statement descriptors are often a
// payment-processor prefix + an abbreviated merchant name + a city/phone.

// Processor / platform prefixes seen on real statements.
const PROCESSOR_PREFIXES = [
  { re: /^SQ\s*\*/i, processor: 'Square', note: 'Charged through Square — usually a small business, food truck, café, or independent seller. The name after "SQ *" is the actual merchant.' },
  { re: /^TST\s*\*/i, processor: 'Toast', note: 'Charged through Toast, a restaurant point-of-sale system. This is a restaurant or bar.' },
  { re: /^(PAYPAL\s*\*|PP\s*\*)/i, processor: 'PayPal', note: 'Paid via PayPal. The name after the prefix is the seller. Check your PayPal activity for the exact order.' },
  { re: /^VENMO/i, processor: 'Venmo', note: 'A Venmo payment or funding transfer. Check the Venmo app for the recipient.' },
  { re: /^CASH APP/i, processor: 'Cash App', note: 'A Cash App payment. Check the Cash App activity feed for the recipient.' },
  { re: /^ZELLE/i, processor: 'Zelle', note: 'A Zelle transfer sent from your bank account.' },
  { re: /^(AMZN\s*MKTP|AMAZON\s*MKTPL?)/i, processor: 'Amazon Marketplace', note: 'An Amazon Marketplace order (third-party seller). Match it to an order in Amazon → Your Orders by date and amount.' },
  { re: /^AMAZON\s*(PRIME|PMTS|\.COM)/i, processor: 'Amazon', note: 'Amazon direct — either a retail order or a Prime membership charge.' },
  { re: /^APPLE\.COM\/BILL/i, processor: 'Apple', note: 'Apple services billing: App Store purchase, iCloud storage, Apple Music, or an in-app subscription. See Settings → Apple ID → Subscriptions on your iPhone.' },
  { re: /^GOOGLE\s*\*?/i, processor: 'Google', note: 'Google billing: Play Store, YouTube Premium, Google One, or an in-app purchase. See payments.google.com for the exact item.' },
  { re: /^FSP\s*\*/i, processor: 'FreshBooks/ISV processor', note: 'Charged through a payments platform on behalf of the merchant named after "FSP*".' },
  { re: /^IN\s*\*/i, processor: 'Intuit/QuickBooks Payments', note: 'An invoice paid through QuickBooks. The merchant name follows "IN *".' },
  { re: /^CKO\s*\*/i, processor: 'Checkout.com', note: 'An online purchase processed by Checkout.com for the merchant named after the prefix.' },
  { re: /^WPY\s*\*/i, processor: 'WePay', note: 'Processed by WePay (often GoFundMe or event/invoice payments).' },
  { re: /^EB\s*\*/i, processor: 'Eventbrite', note: 'Event tickets bought on Eventbrite. The event name follows "EB *".' },
  { re: /^PY\s*\*/i, processor: 'Payrix', note: 'Processed by Payrix on behalf of the merchant named after the prefix.' },
  { re: /^SP\s+|^SP\s*\*/i, processor: 'Shopify', note: 'An online order from a Shopify store. The store name follows the "SP" prefix.' },
  { re: /^CLOVER/i, processor: 'Clover', note: 'Charged through a Clover point-of-sale terminal — a local shop or restaurant.' },
  { re: /^STRIPE|^CHARGE\.COM/i, processor: 'Stripe', note: 'An online payment processed by Stripe for a website or app.' },
  { re: /^ACT\s*\*/i, processor: 'ACTIVE Network', note: 'Registration fees (races, camps, classes) via ACTIVE Network.' },
  { re: /^DD\s+DOORDASH|^DOORDASH/i, processor: 'DoorDash', note: 'A DoorDash delivery order (the restaurant name may follow).' },
  { re: /^UBER\s*(EATS)?/i, processor: 'Uber', note: 'Uber ride or Uber Eats order — check the Uber app trip/order history.' },
  { re: /^LYFT/i, processor: 'Lyft', note: 'A Lyft ride.' },
  { re: /^GRUBHUB/i, processor: 'Grubhub', note: 'A Grubhub food delivery order.' },
  { re: /^AFFIRM|^AFTERPAY|^KLARNA|^SEZZLE/i, processor: 'Buy-now-pay-later', note: 'An installment payment on a buy-now-pay-later plan. Check the BNPL app for the original purchase.' },
  { re: /^ACH\s|^ACH\*/i, processor: 'ACH transfer', note: 'A direct bank (ACH) debit authorized with your account number — commonly utilities, insurance, or loan payments.' },
  { re: /^POS\s/i, processor: 'Point of sale', note: 'An in-person debit card purchase.' },
  { re: /^CHECKCARD\s|^DEBIT\s*CARD/i, processor: 'Debit card', note: 'A debit card purchase; the merchant name and city follow.' },
];

// Well-known merchants whose descriptors are abbreviated or unclear.
const KNOWN_MERCHANTS = [
  { re: /AMZN\s*MKTP.*KINDLE|KINDLE\s*UNLTD|KINDLE\s*SVCS/i, name: 'Kindle Unlimited', category: 'Subscriptions' },
  { re: /AMZN\s*MKTP|AMAZON\s*MKTPL?/i, name: 'Amazon Marketplace', category: 'Shopping' },
  { re: /AMAZON\s*PRIME/i, name: 'Amazon Prime', category: 'Subscriptions' },
  { re: /APPLE\.COM\/BILL/i, name: 'Apple (App Store / iCloud / subscriptions)', category: 'Subscriptions' },
  { re: /GOOGLE\s*\*?\s*YOUTUBE|YOUTUBE\s*PREMIUM/i, name: 'YouTube Premium', category: 'Streaming' },
  { re: /GOOGLE\s*\*?\s*(ONE|STORAGE)/i, name: 'Google One', category: 'Software' },
  { re: /NETFLIX/i, name: 'Netflix', category: 'Streaming' },
  { re: /SPOTIFY/i, name: 'Spotify', category: 'Streaming' },
  { re: /HULU/i, name: 'Hulu', category: 'Streaming' },
  { re: /DISNEY\s*PLUS|DISNEYPLUS/i, name: 'Disney+', category: 'Streaming' },
  { re: /HBO|MAX\.COM/i, name: 'Max (HBO)', category: 'Streaming' },
  { re: /AUDIBLE/i, name: 'Audible', category: 'Subscriptions' },
  { re: /PELOTON/i, name: 'Peloton', category: 'Fitness' },
  { re: /PLANET\s*FIT/i, name: 'Planet Fitness', category: 'Fitness' },
  { re: /EQUINOX/i, name: 'Equinox', category: 'Fitness' },
  { re: /ADOBE/i, name: 'Adobe', category: 'Software' },
  { re: /MSFT|MICROSOFT/i, name: 'Microsoft', category: 'Software' },
  { re: /DROPBOX/i, name: 'Dropbox', category: 'Software' },
  { re: /ICLOUD/i, name: 'Apple iCloud', category: 'Software' },
  { re: /OPENAI|CHATGPT/i, name: 'OpenAI (ChatGPT)', category: 'Software' },
  { re: /ANTHROPIC|CLAUDE\.AI/i, name: 'Anthropic (Claude)', category: 'Software' },
  { re: /NYTIMES|NYT/i, name: 'The New York Times', category: 'News' },
  { re: /WSJ|DOWJONES/i, name: 'The Wall Street Journal', category: 'News' },
  { re: /WHOLEFDS|WHOLE\s*FOODS/i, name: 'Whole Foods Market', category: 'Groceries' },
  { re: /TRADER\s*JOE/i, name: "Trader Joe's", category: 'Groceries' },
  { re: /WM\s*SUPERCENTER|WAL-?MART/i, name: 'Walmart', category: 'Groceries' },
  { re: /TARGET\s/i, name: 'Target', category: 'Shopping' },
  { re: /COSTCO/i, name: 'Costco', category: 'Groceries' },
  { re: /SHELL\s*OIL|EXXON|CHEVRON|BP#/i, name: 'Gas station', category: 'Gas' },
  { re: /STARBUCKS/i, name: 'Starbucks', category: 'Coffee' },
  { re: /DUNKIN/i, name: "Dunkin'", category: 'Coffee' },
  { re: /MCDONALD/i, name: "McDonald's", category: 'Fast food' },
  { re: /CHIPOTLE/i, name: 'Chipotle', category: 'Fast food' },
  { re: /GEICO|PROGRESSIVE|STATE\s*FARM|ALLSTATE/i, name: 'Auto insurance', category: 'Insurance' },
  { re: /COMCAST|XFINITY/i, name: 'Comcast Xfinity', category: 'Utilities' },
  { re: /VERIZON/i, name: 'Verizon', category: 'Utilities' },
  { re: /T-?MOBILE/i, name: 'T-Mobile', category: 'Utilities' },
  { re: /ATT\*|AT&T/i, name: 'AT&T', category: 'Utilities' },
  { re: /RING\s*(YEARLY|MONTHLY|BASIC)/i, name: 'Ring (home security)', category: 'Subscriptions' },
  { re: /PATREON/i, name: 'Patreon', category: 'Subscriptions' },
  { re: /SUBSTACK/i, name: 'Substack', category: 'News' },
  { re: /EXPERIAN|CREDIT\s*KARMA/i, name: 'Credit monitoring', category: 'Financial' },
];

// City before a trailing 2-letter state: 1-2 Title-case words ("Jersey City NJ"),
// or a single ALL-CAPS word ("BROOKLYN NY") — deliberately conservative so merchant
// names aren't swallowed into the location.
const CITY_STATE_RE = /(?<![.\w])((?:[A-Z][a-z.]+\s)?[A-Z][a-z.]+|[A-Z]{3,}(?:\s[A-Z]{3,})?)\s+([A-Z]{2})\s*(?:US)?$/;

// Words that end merchant names but are never cities — reject them as location
// candidates in ALL-CAPS descriptors.
const NOT_CITIES = new Set([
  'LLC', 'INC', 'CORP', 'LTD', 'USA', 'FEES', 'FEE', 'PLAN', 'CLUB', 'STORE',
  'SHOP', 'ONLINE', 'PAYMENT', 'PAYMENTS', 'SERVICES', 'VENDOR', 'BILL',
  'MONTHLY', 'YEARLY', 'ANNUAL', 'TRIP', 'HELP', 'MEMBER', 'MEMBERSHIP',
  'ORDER', 'PURCHASE', 'SUBSCRIPTION', 'RENEWAL', 'MKTP', 'TICKETS', 'MIRAGE',
  'PHOTOGRAPHY', 'DESIGN', 'STUDIO', 'GROUP', 'THE', 'AND',
]);
const CAPS_CITIES = new Set([
  'NEW YORK', 'LOS ANGELES', 'SAN FRANCISCO', 'SAN DIEGO', 'SAN JOSE',
  'SAN ANTONIO', 'LAS VEGAS', 'FORT WORTH', 'EL PASO', 'SANTA MONICA',
  'SALT LAKE', 'ST LOUIS', 'ST PAUL', 'NEW ORLEANS', 'JERSEY CITY',
  'LONG BEACH', 'MENLO PARK', 'PALO ALTO',
]);

function plausibleCity(candidate) {
  const c = candidate.trim();
  if (/^[A-Z][a-z]/.test(c)) return true;                 // Title-case: trust it
  const words = c.split(/\s+/);
  if (words.length === 2) return CAPS_CITIES.has(c);      // ALL-CAPS pair: known cities only
  return !NOT_CITIES.has(c);                              // single ALL-CAPS word: stopword filter
}
const PHONE_RE = /(\+?1?[-. ]?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}|8\d{2}-\d{3}-?\d{4})/;

export function decodeDescriptor(raw) {
  const out = { merchant: null, processor: null, note: null, location: null, category: null };
  let rest = raw.trim();

  for (const p of PROCESSOR_PREFIXES) {
    if (p.re.test(rest)) {
      out.processor = p.processor;
      out.note = p.note;
      rest = rest.replace(p.re, '').trim();
      break;
    }
  }

  const phone = rest.match(PHONE_RE);
  if (phone) {
    out.note = (out.note ? out.note + ' ' : '') +
      `The number ${phone[1]} in the descriptor is the merchant's customer-service line — call it to identify or dispute the charge.`;
    rest = rest.replace(PHONE_RE, '').trim();
  }

  const loc = rest.match(CITY_STATE_RE);
  if (loc) {
    const remainder = rest.replace(CITY_STATE_RE, '').trim();
    // If treating this as a location would consume the entire remainder, the
    // "city" is really the merchant name (e.g. "PAYPAL *STEAMGAMES CA").
    if (!remainder) {
      rest = loc[1].trim();
    } else if (plausibleCity(loc[1])) {
      out.location = `${loc[1].trim()}, ${loc[2]}`;
      rest = remainder;
    } else {
      // Merchant word + state code: keep the word, drop the bare state.
      rest = `${remainder} ${loc[1].trim()}`;
    }
  }

  for (const m of KNOWN_MERCHANTS) {
    if (m.re.test(raw)) {
      out.merchant = m.name;
      out.category = m.category;
      break;
    }
  }

  if (!out.merchant) {
    // Clean up what's left: drop store numbers, order codes, billing URLs.
    const cleaned = rest
      .replace(/#\s*\d+|\bSTORE\s*\d+\b|\b\d{4,}\b/gi, '')
      .replace(/\b\S*\d\S*\b/g, ' ')            // tokens containing digits (order ids)
      .replace(/\b\S+\.(com|co|net|org)\S*/gi, ' ') // billing URLs
      .replace(/[*_]/g, ' ')
      .replace(/\s[A-Z]{2}\s*$/, ' ')           // trailing bare state code
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned.length >= 3) {
      out.merchant = cleaned.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
    } else {
      // Residual is junk (an order code or state fragment) — fall back to the
      // processor identity rather than inventing a bogus merchant name.
      out.merchant = out.processor || raw;
    }
  }

  if (!out.note) {
    out.note = out.location
      ? `In-person or local charge at ${out.merchant} in ${out.location}.`
      : `Charge from ${out.merchant}. If you don't recognize it, check household members' purchases, free-trial conversions, and annual renewals around this date.`;
  }

  return out;
}

// Normalized key so "NETFLIX.COM 866-579-7172" and "Netflix" group together.
export function merchantKey(rawOrName) {
  const d = decodeDescriptor(rawOrName);
  return d.merchant.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}
