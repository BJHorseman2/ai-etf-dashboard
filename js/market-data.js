export const SYMBOLS = ['SMH', 'PAVE', 'GRID', 'IBB', 'KRE'];
export const percent = (price, baseline) => (price / baseline - 1) * 100;
const iso = d => d.toISOString().slice(0, 10);
const shift = (d, n) => new Date(d.getTime() + n * 86400000);
function observed(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return iso(shift(d, d.getUTCDay() === 6 ? -1 : d.getUTCDay() === 0 ? 1 : 0));
}
function nth(year, month, weekday, n) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  return iso(shift(d, (weekday - d.getUTCDay() + 7) % 7 + (n - 1) * 7));
}
function goodFriday(y) {
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),v=h+l-7*m+114;
  return iso(shift(new Date(Date.UTC(y, Math.floor(v/31)-1, v%31+1)), -2));
}
export function isSession(date) {
  const d = new Date(`${date}T00:00:00Z`), y = d.getUTCFullYear();
  if ([0,6].includes(d.getUTCDay())) return false;
  const memorial = new Date(Date.UTC(y, 4, 31));
  const holidays = [observed(y,1,1), observed(y+1,1,1), nth(y,1,1,3), nth(y,2,1,3), goodFriday(y), iso(shift(memorial,-((memorial.getUTCDay()+6)%7))), observed(y,6,19), observed(y,7,4), nth(y,9,1,1), nth(y,11,4,4), observed(y,12,25), '2025-01-09'];
  return !holidays.includes(date);
}
export function previousSession(date) {
  let d = shift(new Date(`${date}T00:00:00Z`), -1);
  while (!isSession(iso(d))) d = shift(d, -1);
  return iso(d);
}
// EOD publication grace: today's close is expected from 22:00 UTC onward.
export function expectedSession(now = new Date()) {
  const today = iso(now);
  return now.getUTCHours() >= 22 && isSession(today) ? today : previousSession(today);
}
export function normalize(payload, symbol, now = new Date()) {
  if (payload?.['Meta Data']?.['2. Symbol'] !== symbol) throw new Error('Unexpected symbol');
  const series = payload['Time Series (Daily)'];
  if (!series || typeof series !== 'object') throw new Error('Provider unavailable or API entitlement/rate limit');
  const year = Number(iso(now).slice(0,4));
  const baselineDate = previousSession(`${year}-01-01`);
  const expected = expectedSession(now);
  const rows = Object.entries(series).filter(([date]) => date >= baselineDate && date <= expected).map(([date,row]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isSession(date) || iso(new Date(`${date}T00:00:00Z`)) !== date) throw new Error('Invalid session date');
    const close = Number(row['4. close']), adjustedClose = Number(row['5. adjusted close']);
    if (!(close > 0 && adjustedClose > 0 && Number.isFinite(close) && Number.isFinite(adjustedClose))) throw new Error('Invalid price');
    return { date, close, adjustedClose };
  }).sort((a,b) => a.date.localeCompare(b.date));
  if (rows[0]?.date !== baselineDate || rows.length < 2) throw new Error('Missing prior-year baseline or history');
  // Reject truncated history rather than drawing invented connecting observations.
  for (let i=1;i<rows.length;i++) if (previousSession(rows[i].date) !== rows[i-1].date) throw new Error('Incomplete daily history');
  return { symbol, rows, fetchedAt: now.toISOString() };
}
export function view(snapshot, now = new Date()) {
  const expected = expectedSession(now), year = Number(iso(now).slice(0,4));
  const funds = SYMBOLS.map(symbol => {
    const fund = snapshot?.funds?.[symbol];
    try {
      // Revalidate persisted data too; stored derived returns are never trusted.
      const validated = normalize({'Meta Data':{'2. Symbol':symbol}, 'Time Series (Daily)':Object.fromEntries(fund.rows.map(r => [r.date, {'4. close':r.close,'5. adjusted close':r.adjustedClose}]))}, symbol, now);
      const rows = validated.rows, last = rows.at(-1);
      const stale = last.date !== expected;
      return {symbol, rows, last, baseline:rows[0], stale, error:fund.error || null, ytd:percent(last.adjustedClose,rows[0].adjustedClose)};
    } catch { return {symbol, rows:[], stale:true, error:'Data unavailable'}; }
  });
  const eligible = funds.filter(f => !f.stale && !f.error);
  // Only rank a complete watchlist on the same expected close.
  const ranked = eligible.length === SYMBOLS.length ? [...eligible].sort((a,b)=>b.ytd-a.ytd || a.symbol.localeCompare(b.symbol)) : [];
  return {year, expected, funds, ranked};
}
