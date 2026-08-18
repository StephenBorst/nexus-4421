// ── RV-v5 · ROBUSTNESS STUDY (before capital) ────────────────────────────────
// RV-v4 found the edge: sector-neutral P1 funding carry, ~12%/yr net at maker fees,
// 85% carry share, on 60d. But 60d / 59 rebalances is THIN and the in-sample slice was
// slightly negative. Before arming real money, prove it isn't a fluke:
//   1. LONGER WINDOW  — re-run on ~90d, does the edge survive?
//   2. WALK-FORWARD   — split into consecutive folds; is it positive in MOST, or one lucky run?
//   3. DROP-ONE-SECTOR — remove each sector in turn; does one sector secretly carry it all?
// Uses the DEPLOYED engine (buildTargetBook) so the study grades exactly what runs live.
// Standalone research. Run: node tools/backtest/relvalue5.mjs
import { buildTargetBook, sectorMap as engineSectorMap, bareTicker as bt, SECTORS } from "../../workers/nexus-carry-engine/carryBasket.mjs";
const API = "https://api-evm.orderly.org";

const DAYS = 90, CAPITAL = 1000, REBAL_H = 24;
const UNIVERSE = Object.values(SECTORS).flat().map((t) => `PERP_${t}_USDC`);
const r2 = (x) => Math.round(x * 100) / 100;

async function fCandles(s) {
  const now = Math.floor(Date.now()/1000), from = now - DAYS*86400, out=[]; let cur=from;
  while (cur<now){ const to=Math.min(cur+20*86400,now); const d=await fetch(`${API}/tv/history?symbol=${s}&resolution=60&from=${cur}&to=${to}`).then(r=>r.json()).catch(()=>null); if(d&&d.s==="ok"&&Array.isArray(d.t)) for(let i=0;i<d.t.length;i++) out.push({t:d.t[i],c:d.c[i]}); cur=to; }
  const seen=new Set(); return out.filter(c=>(seen.has(c.t)?false:seen.add(c.t))).sort((a,b)=>a.t-b.t);
}
async function fFunding(s) {
  const rows=[]; for(let p=1;p<=6;p++){ const d=await fetch(`${API}/v1/public/funding_rate_history?symbol=${s}&page=${p}&size=100`).then(r=>r.json()).catch(()=>null); const rs=d?.data?.rows||[]; rows.push(...rs.map(x=>({ts:x.funding_rate_timestamp,rate:Number(x.funding_rate)}))); if(rs.length<100) break; }
  rows.sort((a,b)=>a.ts-b.ts); return rows;
}
const fundingAt=(rows,tMs)=>{let r=0;for(const x of rows){if(x.ts<=tMs)r=x.rate;else break;}return r;};
const closeAt=(c,t)=>{let v=null;for(const k of c){if(k.t<=t)v=k.c;else break;}return v;};

// One sector-neutral P1 pass over [t0,tN]. feeBps: 3=taker, -0.1=maker. excludeSector: skip a sector.
// Returns per-rebalance records so we can fold the same run without recomputing.
function run(data, syms, { feeBps = -0.1, t0, tN, excludeSector = null }) {
  const step = REBAL_H*3600;
  let held=new Map(), fees=0; const recs=[];
  const feeRate = feeBps/10000, fp = REBAL_H/8;
  for (let t=t0; t+step<=tN; t+=step) {
    const tMs=t*1000;
    const funding={}, mark={};
    for (const s of syms) {
      const c0=closeAt(data[s].candles,t), c1=closeAt(data[s].candles,t+step), f=fundingAt(data[s].funding,tMs);
      if (c0!=null && c1!=null && c0>0) { funding[bt(s)]=f; mark[bt(s)]={c0,c1}; }
    }
    const book = buildTargetBook(funding, engineSectorMap(), { perSide:1, capital:CAPITAL });
    const legs = book.legs.filter(l => l.sector !== excludeSector);
    if (legs.length < 2) continue;
    const legN = CAPITAL/legs.length;
    const target = new Map(legs.map(l=>[l.symbol,l.side]));
    for (const s of new Set([...held.keys(),...target.keys()])) if((held.get(s)||0)!==(target.get(s)||0)) fees+=feeRate*legN;
    held=target;
    let fund=0, price=0;
    for (const l of legs) { const m=mark[l.symbol]; const pr=(m.c1-m.c0)/m.c0; price+=l.side*pr*legN; fund+=-l.side*l.funding*fp*legN; }
    recs.push({ t, fund, price });
  }
  return { recs, fees };
}

function summarize(recs, fees, label) {
  const fund=recs.reduce((a,b)=>a+b.fund,0), price=recs.reduce((a,b)=>a+b.price,0);
  const net=fund+price-fees;
  const rets=recs.map(r=>r.fund+r.price); const n=rets.length;
  const mean=n?rets.reduce((a,b)=>a+b,0)/n:0, sd=n?Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/n):0;
  const sharpe=sd>0?(mean/sd)*Math.sqrt((365*24)/REBAL_H):0;
  const carry=(Math.abs(fund)+Math.abs(price))>0?Math.round(Math.abs(fund)/(Math.abs(fund)+Math.abs(price))*100):0;
  return { label, net:r2(net), fund:r2(fund), price:r2(price), fees:r2(fees), carry, sharpe:r2(sharpe), n };
}
const line = (r) => `${String(r.label).padEnd(20)} net $${String(r.net).padStart(8)}  fund $${String(r.fund).padStart(7)}  price $${String(r.price).padStart(8)}  carry ${String(r.carry).padStart(3)}%  sharpe ${String(r.sharpe).padStart(6)}  (${r.n})`;

async function main() {
  const data={}, ok=[];
  for (const s of UNIVERSE) { const [c,f]=await Promise.all([fCandles(s),fFunding(s)]); if(c.length>800&&f.length>30){data[s]={candles:c,funding:f};ok.push(s);} }
  const base=data[ok[0]]; const T0=base.candles[0].t, TN=base.candles[base.candles.length-1].t;
  const spanD=((TN-T0)/86400).toFixed(0);
  console.error(`\nUniverse ${ok.length} syms · ${spanD}d actual · $${CAPITAL} · ${REBAL_H}h rebal\n`);
  console.log(`=== RV-v5 ROBUSTNESS (sector-neutral P1, ${spanD}d, maker −0.1bps) ===\n`);

  // 1) full window, maker vs taker
  console.log("── 1. FULL WINDOW ──");
  const fullMaker = run(data, ok, { feeBps:-0.1, t0:T0, tN:TN });
  const fullTaker = run(data, ok, { feeBps:3, t0:T0, tN:TN });
  console.log(line(summarize(fullMaker.recs, fullMaker.fees, `${spanD}d maker`)));
  console.log(line(summarize(fullTaker.recs, fullTaker.fees, `${spanD}d taker`)));

  // 2) walk-forward folds (consecutive quarters of the window) — maker
  console.log("\n── 2. WALK-FORWARD (maker, consecutive folds) ──");
  const FOLDS=4; const step=(TN-T0)/FOLDS; const folds=[];
  for (let i=0;i<FOLDS;i++){ const a=T0+i*step, b=T0+(i+1)*step; const rr=run(data, ok, {feeBps:-0.1,t0:a,tN:b}); const s=summarize(rr.recs,rr.fees,`fold ${i+1}`); folds.push(s); console.log(line(s)); }
  const pos=folds.filter(f=>f.net>0).length, posCarry=folds.filter(f=>f.carry>=55).length;
  console.log(`→ ${pos}/${FOLDS} folds net-positive · ${posCarry}/${FOLDS} carry-dominant (≥55%)`);

  // 3) drop-one-sector — is one sector carrying it all? (maker, full window)
  console.log("\n── 3. DROP-ONE-SECTOR (maker, full window) ──");
  const secs=[...new Set(ok.map(s=>engineSectorMap()[bt(s)]))];
  const dropRows=[];
  for (const sec of secs){ const rr=run(data, ok, {feeBps:-0.1,t0:T0,tN:TN,excludeSector:sec}); const s=summarize(rr.recs,rr.fees,`ex-${sec}`); dropRows.push({sec,...s}); console.log(line(s)); }
  const fullNet=summarize(fullMaker.recs,fullMaker.fees,"").net;
  const worst=[...dropRows].sort((a,b)=>a.net-b.net)[0];
  console.log(`→ full net $${fullNet}; removing any one sector still net-positive: ${dropRows.every(d=>d.net>0)?"YES":"NO"} (weakest without: ex-${worst.sec} = $${worst.net})`);

  // verdict
  console.log("\n── VERDICT ──");
  const robust = pos>=3 && posCarry>=3 && dropRows.every(d=>d.net>0) && summarize(fullMaker.recs,fullMaker.fees,"").net>0;
  console.log(robust
    ? `⭐ ROBUST: net-positive over ${spanD}d, positive in ${pos}/${FOLDS} folds, carry-dominant, and no single sector carries it. The edge holds up — arming a TINY live validation is justified.`
    : `⚠️ FRAGILE: fails a robustness gate (${pos}/${FOLDS} folds+, ${posCarry}/${FOLDS} carry-dom, drop-sector all+ = ${dropRows.every(d=>d.net>0)}). Keep it in paper; do NOT scale capital on this yet.`);
}
main().catch(e=>{console.error(e);process.exit(1);});
