// ── RV-v3 · BASKET-SIZE SCALING ──────────────────────────────────────────────
// RV-v2 proved the price residual that swamps the funding carry is cross-sectional
// ALT DISPERSION, not market beta (a BTC hedge was a no-op). The one lever left is
// DIVERSIFICATION: a bigger long/short basket should average idiosyncratic dispersion
// toward zero, letting the (small, persistent) funding carry dominate the net. This
// tests exactly that — the SAME market-neutral carry strategy across a 24-symbol
// crypto universe at growing leg counts (K), measuring the CARRY SHARE of the net
// (funding / (|funding| + |price residual|)) as the basket grows. If carry share
// climbs toward 1 and net + OOS stay positive with size, the edge is real at scale.
// Standalone research. Run: node tools/backtest/relvalue3.mjs
const API = "https://api-evm.orderly.org";
// 24 liquid crypto perps (index/FX/commodity perps — NAS100/EURUSD/XAU/CL — excluded:
// different funding regimes would muddy the carry read).
const UNIVERSE = [
  "PERP_BTC_USDC","PERP_ETH_USDC","PERP_SOL_USDC","PERP_LINK_USDC","PERP_FET_USDC","PERP_HBAR_USDC",
  "PERP_LTC_USDC","PERP_JUP_USDC","PERP_ZEC_USDC","PERP_AAVE_USDC","PERP_INJ_USDC","PERP_HYPE_USDC",
  "PERP_AVAX_USDC","PERP_NEAR_USDC","PERP_ARB_USDC","PERP_XRP_USDC","PERP_DOGE_USDC","PERP_BNB_USDC",
  "PERP_DOT_USDC","PERP_ONDO_USDC","PERP_ENA_USDC","PERP_ZRO_USDC","PERP_LIT_USDC","PERP_MERL_USDC",
];
const DAYS = 60, CAPITAL = 1000, FEE_BPS = 3, REBAL_H = 24;
const tk = (s) => s.replace("PERP_", "").replace("_USDC", "");

async function fCandles(s) {
  const now = Math.floor(Date.now()/1000), from = now - DAYS*86400, out=[]; let cur=from;
  while (cur<now){ const to=Math.min(cur+20*86400,now); const d=await fetch(`${API}/tv/history?symbol=${s}&resolution=60&from=${cur}&to=${to}`).then(r=>r.json()).catch(()=>null); if(d&&d.s==="ok"&&Array.isArray(d.t)) for(let i=0;i<d.t.length;i++) out.push({t:d.t[i],c:d.c[i]}); cur=to; }
  const seen=new Set(); return out.filter(c=>(seen.has(c.t)?false:seen.add(c.t))).sort((a,b)=>a.t-b.t);
}
async function fFunding(s) {
  const rows=[]; for(let p=1;p<=4;p++){ const d=await fetch(`${API}/v1/public/funding_rate_history?symbol=${s}&page=${p}&size=100`).then(r=>r.json()).catch(()=>null); const rs=d?.data?.rows||[]; rows.push(...rs.map(x=>({ts:x.funding_rate_timestamp,rate:Number(x.funding_rate)}))); if(rs.length<100) break; }
  rows.sort((a,b)=>a.ts-b.ts); return rows;
}
const fundingAt=(rows,tMs)=>{let r=0;for(const x of rows){if(x.ts<=tMs)r=x.rate;else break;}return r;};
const closeAt=(c,t)=>{let v=null;for(const k of c){if(k.t<=t)v=k.c;else break;}return v;};

function run(data, syms, K){
  const base=data[syms[0]]; const t0=base.candles[0].t, tN=base.candles[base.candles.length-1].t;
  const step=REBAL_H*3600, oosCut=tN-20*86400, legN=CAPITAL/(2*K);
  let held=new Map(), net=0, fund=0, price=0, fees=0, isNet=0, oosNet=0; const rets=[];
  for(let t=t0;t+step<=tN;t+=step){
    const tMs=t*1000;
    const ranked=syms.map(s=>{const c0=closeAt(data[s].candles,t),c1=closeAt(data[s].candles,t+step),f=fundingAt(data[s].funding,tMs);return {s,f,c0,c1,ok:c0!=null&&c1!=null&&c0>0};}).filter(x=>x.ok);
    if(ranked.length<2*K) continue;
    ranked.sort((a,b)=>a.f-b.f);
    const legs=[...ranked.slice(0,K).map(x=>({...x,side:1})),...ranked.slice(-K).map(x=>({...x,side:-1}))];
    const target=new Map(legs.map(l=>[l.s,l.side]));
    for(const s of new Set([...held.keys(),...target.keys()])) if((held.get(s)||0)!==(target.get(s)||0)) fees+=(FEE_BPS/10000)*legN;
    held=target;
    let pp=0; const fp=REBAL_H/8;
    for(const l of legs){ const pr=(l.c1-l.c0)/l.c0; const p=l.side*pr*legN; const fpnl=-l.side*l.f*fp*legN; price+=p; fund+=fpnl; pp+=p+fpnl; }
    net+=pp; rets.push(pp); if(t>=oosCut) oosNet+=pp; else isNet+=pp;
  }
  net-=fees;
  const n=rets.length, mean=n?rets.reduce((a,b)=>a+b,0)/n:0, sd=n?Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/n):0;
  const sharpe=sd>0?(mean/sd)*Math.sqrt((365*24)/REBAL_H):0;
  const carryShare=(Math.abs(fund)+Math.abs(price))>0?Math.abs(fund)/(Math.abs(fund)+Math.abs(price)):0;
  return { K, net:r2(net), fund:r2(fund), price:r2(price), fees:r2(fees), isNet:r2(isNet), oosNet:r2(oosNet-fees*(20/DAYS)), sharpe:r2(sharpe), carryShare:Math.round(carryShare*100), periods:n };
}
const r2=(x)=>Math.round(x*100)/100;

async function main(){
  const data={}; const ok=[];
  for(const s of UNIVERSE){ const [c,f]=await Promise.all([fCandles(s),fFunding(s)]); if(c.length>500&&f.length>20){data[s]={candles:c,funding:f};ok.push(s);} else console.error(`skip ${tk(s)} (thin: ${c.length}c/${f.length}f)`); }
  console.error(`\nUniverse: ${ok.length} usable symbols · $${CAPITAL} book · ${REBAL_H}h rebal · fees ${FEE_BPS}bps · ${DAYS}d\n`);
  console.log(`=== RV-v3 BASKET-SIZE SCALING (${ok.length}-symbol crypto universe, ${DAYS}d, $${CAPITAL}) ===`);
  console.log("does a bigger basket diversify away dispersion so CARRY dominates? watch carry% + oos as K grows.\n");
  console.log("K".padStart(3),"legs".padStart(5),"net$".padStart(9),"fund$".padStart(8),"price$".padStart(9),"fees$".padStart(7),"oos$".padStart(8),"carry%".padStart(7),"sharpe".padStart(7));
  const res=[];
  for(const K of [3,5,8,10,12]){ if(2*K>ok.length) continue; const r=run(data,ok,K); res.push(r); console.log(String(r.K).padStart(3),String(2*r.K).padStart(5),String(r.net).padStart(9),String(r.fund).padStart(8),String(r.price).padStart(9),String(r.fees).padStart(7),String(r.oosNet).padStart(8),`${r.carryShare}%`.padStart(7),String(r.sharpe).padStart(7)); }
  console.log("\n--- VERDICT ---");
  const trend=res.map(r=>r.carryShare);
  const rising=trend.length>=2 && trend[trend.length-1]>trend[0]+10;
  const bestOos=[...res].sort((a,b)=>b.oosNet-a.oosNet)[0];
  const carryDom=res.filter(r=>r.carryShare>=55 && r.net>0 && r.oosNet>0);
  console.log(`carry share by K: ${res.map(r=>`K${r.K}:${r.carryShare}%`).join(" · ")}`);
  console.log(`carry-dominant (≥55% carry, net+ & oos+): ${carryDom.length}`);
  console.log(carryDom.length
    ? `→ ⭐ carry dominates at scale (best OOS: K${bestOos.K} net $${bestOos.net} / oos $${bestOos.oosNet} / ${bestOos.carryShare}% carry). Diversification unlocks it — RV is real at basket scale.`
    : rising
    ? `→ carry share RISES with basket size but hasn't crossed dominance on ${DAYS}d — directionally right; needs a bigger universe / longer window.`
    : `→ bigger basket did NOT make carry dominate — dispersion doesn't diversify away enough at retail scale on this window. RV carry stays a thin, non-dominant sleeve. Close the thread.`);
}
main().catch(e=>{console.error(e);process.exit(1);});
