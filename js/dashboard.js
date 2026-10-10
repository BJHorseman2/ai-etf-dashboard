import { SYMBOLS, view, percent } from './market-data.js';
const descriptions = [
  ['VanEck Semiconductor ETF','#7c3aed','Semiconductors underpin AI computing; a concentrated, cyclical theme.'],
  ['Global X U.S. Infrastructure Development ETF','#0ea5e9','Infrastructure and industrial exposure connected to data-center construction.'],
  ['First Trust NASDAQ Clean Edge Smart Grid Infrastructure Index Fund','#10b981','Grid infrastructure and electrification support growing power demand.'],
  ['iShares Biotechnology ETF','#f59e0b','Biotechnology is an indirect AI research theme, with clinical and regulatory risks.'],
  ['SPDR S&P Regional Banking ETF','#f43f5e','Regional banks offer an indirect financing theme with credit and rate sensitivity.']
];
const meta = Object.fromEntries(SYMBOLS.map((s,i)=>[s,{name:descriptions[i][0],color:descriptions[i][1],rationale:descriptions[i][2]}]));
const money = n => Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
const pct = n => Number.isFinite(n) ? `${n>=0?'+':''}${n.toFixed(2)}%` : '—';
const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let snapshot = null, networkError = false, busy = false, charts = [];
function render() {
  const model = view(snapshot), {funds,ranked,expected,year} = model;
  const problem = networkError || funds.some(f=>f.stale || f.error);
  document.getElementById('dataBadge').textContent = problem ? 'Data unavailable / stale' : 'End-of-day dashboard';
  document.getElementById('dataStatus').textContent = `Expected close: ${expected}. Last refresh attempt: ${snapshot?.attemptedAt ? new Date(snapshot.attemptedAt).toLocaleString() : 'never'}.${networkError ? ' Unable to load latest snapshot; showing previously loaded history.' : ''}${!ranked.length ? ' Rankings withheld until all five funds have a valid close for the same session.' : ''}`;
  document.getElementById('cards').innerHTML = funds.map(f=>{
    const m=meta[f.symbol], warning=f.error || (f.stale?'Stale history; not a current quote':'');
    return `<div class="card" style="--accent:${m.color}"><div class="card-ticker">${f.symbol}</div><div class="card-name">${m.name}</div><div class="card-price-row"><div class="card-price">${money(f.last?.close)}</div><div class="card-ytd ${f.ytd<0?'negative':''}">${pct(f.ytd)}</div></div><div class="card-name">${f.last ? `Close: ${f.last.date} · ${year} YTD through that close`:'Price and YTD unavailable'}</div><div class="warning">${escape(warning)}</div><div class="card-rationale">${m.rationale}</div></div>`;
  }).join('');
  const months = Array.from({length:Number(expected.slice(5,7))},(_,i)=>`${year}-${String(i+1).padStart(2,'0')}`);
  document.getElementById('rankHead').innerHTML = `<tr>${['Rank','Ticker','Full Name','Adjusted baseline','Latest close','As of','YTD adjusted',...months].map(h=>`<th scope="col">${h}</th>`).join('')}</tr>`;
  const ranks = new Map(ranked.map((f,i)=>[f.symbol,i+1]));
  const ordered = ranked.length ? ranked : funds;
  document.querySelector('#rankTable tbody').innerHTML = ordered.map(f=>{
    const m=meta[f.symbol];
    const monthly = months.map(month=>f.rows.filter(r=>r.date.startsWith(month)).at(-1));
    return `<tr><td><span class="rank-badge">${ranks.get(f.symbol)||'—'}</span></td><td class="ticker-cell" style="color:${m.color}">${f.symbol}</td><td>${m.name}</td><td>${money(f.baseline?.adjustedClose)}${f.baseline ? `<br>${f.baseline.date}`:''}</td><td>${money(f.last?.close)}</td><td>${f.last?.date||'Unavailable'}${f.stale || f.error ? ' · stale / unavailable':''}</td><td class="${f.ytd<0?'negative':'positive'}">${pct(f.ytd)}</td>${monthly.map(r=>`<td>${money(r?.close)}${r?`<br>${r.date}`:''}</td>`).join('')}</tr>`;
  }).join('');
  charts.forEach(c=>c.destroy()); charts=[];
  if (!window.Chart) {
    document.getElementById('chartStatus').textContent='Charts unavailable. Prices and returns remain available in the table.';
    return;
  }
  document.getElementById('chartStatus').textContent = 'Historical lines stop at each fund’s last available close. Missing values are not filled. Monthly table prices show the last available close in each month.';
  const dates = [...new Set(funds.flatMap(f=>f.rows.map(r=>r.date)))].sort();
  const scales = {x:{ticks:{color:'#94a3b8',maxTicksLimit:6},grid:{color:'#1f2d45'}},y:{ticks:{color:'#94a3b8',callback:n=>`${n}%`},grid:{color:'#1f2d45'}}};
  charts.push(new Chart(document.getElementById('lineChart'),{type:'line',data:{labels:dates,datasets:funds.filter(f=>f.rows.length).map(f=>{
    const rows=new Map(f.rows.map(r=>[r.date,r]));
    return {label:`${f.symbol}${f.stale || f.error?' (stale / refresh failed)':''}`,data:dates.map(d=>rows.has(d)?percent(rows.get(d).adjustedClose,f.baseline.adjustedClose):null),borderColor:meta[f.symbol].color,pointRadius:0,borderWidth:2,spanGaps:false,tension:0};
  })},options:{responsive:true,animation:false,scales,plugins:{legend:{labels:{color:'#94a3b8'}}}}}));
  charts.push(new Chart(document.getElementById('barChart'),{type:'bar',data:{labels:ranked.map(f=>f.symbol),datasets:[{label:'YTD adjusted return',data:ranked.map(f=>f.ytd),backgroundColor:ranked.map(f=>meta[f.symbol].color)}]},options:{indexAxis:'y',responsive:true,animation:false,scales:{x:scales.y,y:{ticks:{color:'#94a3b8'}}},plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>pct(c.parsed.x)}}}}}));
}
async function load() {
  if (busy) return;
  busy=true; const button=document.getElementById('refreshButton'); button.disabled=true;
  try {
    const res=await fetch(`data/market-data.json?t=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if (!res.ok) throw new Error('Snapshot unavailable');
    const next=await res.json();
    if (next.schemaVersion!==1 || !next.funds || (next.attemptedAt!==null && !Number.isFinite(Date.parse(next.attemptedAt)))) throw new Error('Invalid snapshot');
    snapshot=next; networkError=false;
  } catch {networkError=true;} finally {busy=false;button.disabled=false;render();}
}
document.getElementById('refreshButton').addEventListener('click',load);
document.addEventListener('visibilitychange',()=>{if(!document.hidden) load();});
setInterval(()=>{if(!document.hidden) load();},5*60*1000);
render(); load();
