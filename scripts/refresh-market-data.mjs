import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SYMBOLS, normalize } from '../js/market-data.js';
export async function request(symbol, key, fetcher = fetch, pause = ms => new Promise(r => setTimeout(r,ms))) {
  const url = new URL('https://www.alphavantage.co/query');
  url.search = new URLSearchParams({function:'TIME_SERIES_DAILY_ADJUSTED', symbol, outputsize:'full', apikey:key});
  for (let attempt=0;attempt<3;attempt++) {
    try {
      const res = await fetcher(url, {signal:AbortSignal.timeout(20000)});
      if (res.status === 429 || res.status >= 500) throw new Error('Temporary provider failure');
      if (!res.ok) return null;
      const json = await res.json();
      if (json.Note || json.Information) throw new Error('Provider rate limit or entitlement');
      return json;
    } catch { if (attempt<2) await pause(15000 * (attempt+1)); }
  }
  return null;
}
export async function refresh(previous, key, now = new Date(), fetcher = fetch, pause) {
  const snapshot = {schemaVersion:1, provider:'Alpha Vantage', attemptedAt:now.toISOString(), funds:{}};
  for (const symbol of SYMBOLS) {
    try {
      const payload = await request(symbol,key,fetcher,pause);
      snapshot.funds[symbol] = normalize(payload,symbol,now);
    } catch {
      snapshot.funds[symbol] = {...previous?.funds?.[symbol], symbol, error:'Refresh failed; retained history may be stale'};
    }
  }
  return snapshot;
}
async function main() {
  if (!process.env.ALPHA_VANTAGE_API_KEY || process.env.MARKET_DATA_PUBLICATION_APPROVED !== 'true') throw new Error('Configure API secret and approved public display/storage rights before refreshing');
  let previous = {};
  try { previous = JSON.parse(await readFile('data/market-data.json','utf8')); } catch {}
  const snapshot = await refresh(previous,process.env.ALPHA_VANTAGE_API_KEY);
  await mkdir('data',{recursive:true});
  await writeFile('data/market-data.json.tmp',JSON.stringify(snapshot,null,2)+'\n');
  await rename('data/market-data.json.tmp','data/market-data.json');
  if (Object.values(snapshot.funds).some(f=>f.error)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Market refresh failed. Check API configuration and provider status.'); process.exitCode=1; });
