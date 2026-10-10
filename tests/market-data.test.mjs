import test from 'node:test';
import assert from 'node:assert/strict';
import {SYMBOLS,normalize,view,percent,isSession,previousSession,expectedSession} from '../js/market-data.js';
import {refresh,request} from '../scripts/refresh-market-data.mjs';
const now = new Date('2026-10-08T23:00:00Z');
function payload(symbol, final=110) {
  const series={};
  for(let d=new Date('2025-12-31T00:00:00Z');d<=now;d=new Date(+d+86400000)) {
    const date=d.toISOString().slice(0,10);
    if(isSession(date)) series[date]={'4. close':date==='2026-10-08'?55:100,'5. adjusted close':date==='2026-10-08'?final:100};
  }
  return {'Meta Data':{'2. Symbol':symbol},'Time Series (Daily)':series};
}
const snapshot=()=>({funds:Object.fromEntries(SYMBOLS.map((s,i)=>[s,normalize(payload(s,110+i),s,now)]))});
test('YTD and chart use adjusted baseline; displayed quote remains raw',()=>{
  const m=view(snapshot(),now), f=m.funds[0];
  assert.equal(f.last.close,55); assert.ok(Math.abs(f.ytd-10)<1e-10);
  assert.equal(f.ytd,percent(f.last.adjustedClose,f.baseline.adjustedClose));
  assert.deepEqual(m.ranked.map(f=>f.symbol),['KRE','IBB','GRID','PAVE','SMH']);
  assert.equal(f.baseline.date,'2025-12-31'); assert.ok(f.rows.some(r=>r.date==='2026-07-01'));
});
test('negative returns and tied rankings',()=>{
  const s=snapshot(); for(const f of Object.values(s.funds)) f.rows.at(-1).adjustedClose=90;
  const m=view(s,now); assert.ok(m.funds.every(f=>f.ytd<0)); assert.equal(m.ranked.length,5);
});
test('weekends, holiday, DST grace and year boundary',()=>{
  assert.equal(expectedSession(new Date('2026-07-04T23:00Z')),'2026-07-02');
  assert.equal(expectedSession(new Date('2026-10-12T19:00Z')),'2026-10-09');
  assert.equal(expectedSession(new Date('2026-11-27T21:00Z')),'2026-11-25');
  assert.equal(expectedSession(new Date('2026-11-27T23:00Z')),'2026-11-27');
  assert.equal(previousSession('2026-01-01'),'2025-12-31');
  assert.equal(isSession('2026-04-03'),false);
  assert.equal(view(snapshot(),new Date('2027-01-04T23:00Z')).ranked.length,0);
});
test('reject missing baseline, gaps, invalid prices, wrong symbol and rate-limit payloads',()=>{
  for(const mutate of [p=>delete p['Time Series (Daily)']['2025-12-31'],p=>delete p['Time Series (Daily)']['2026-07-01'],p=>p['Time Series (Daily)']['2026-07-01']['5. adjusted close']=0,p=>p['Meta Data']['2. Symbol']='OTHER']) {
    const p=payload('SMH');mutate(p);assert.throws(()=>normalize(p,'SMH',now));
  }
  assert.throws(()=>normalize({Information:'premium required'},'SMH',now));
});
test('stale, partial and failed funds withhold complete ranking',()=>{
  const s=snapshot(); s.funds.SMH.rows.pop();
  assert.equal(view(s,now).ranked.length,0);assert.equal(view(s,now).funds[0].stale,true);
  assert.equal(view({funds:{}},now).ranked.length,0);
  const s2=snapshot();s2.funds.SMH.error='Refresh failed';assert.equal(view(s2,now).ranked.length,0);
});
test('retry temporary errors without exposing URLs or keys',async()=>{
  let calls=0, pauses=0;
  const p=await request('SMH','secret',async()=>{calls++;return calls<3?{status:429}:{status:200,ok:true,json:async()=>payload('SMH')};},async()=>{pauses++;});
  assert.equal(calls,3);assert.equal(pauses,2);assert.ok(p['Time Series (Daily)']);
});
test('refresh replaces successful history, retains failures, and recovers next run',async()=>{
  const previous=snapshot();
  const fetcher=async url=>({status:200,ok:true,json:async()=>url.searchParams.get('symbol')==='SMH'?{Information:'limit'}:payload(url.searchParams.get('symbol'),120)});
  const s=await refresh(previous,'secret',now,fetcher,async()=>{});
  assert.ok(s.funds.SMH.error);assert.deepEqual(s.funds.SMH.rows,previous.funds.SMH.rows);
  assert.equal(s.funds.PAVE.rows.at(-1).adjustedClose,120);
  const recovered=await refresh(s,'secret',now,async url=>({status:200,ok:true,json:async()=>payload(url.searchParams.get('symbol'))}),async()=>{});
  assert.equal(recovered.funds.SMH.error,undefined); assert.equal(view(recovered,now).ranked.length,5);
});
