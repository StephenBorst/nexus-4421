// ── RV-v4 · SECTOR-NEUTRAL BIG-BASKET CARRY ──────────────────────────────────
// The last untested lever from the engine arc. RV-v2 proved the price residual that
// swamps funding carry is cross-sectional ALT DISPERSION, not market beta (a single
// BTC hedge was a no-op). RV-v3 tried to diversify it away by growing K on a GLOBAL
// funding rank — and FAILED: carry share DROPPED with K, because a global rank piles
// the longs into whatever sectors happen to run rich-negative funding and the shorts
// into others, so the book carries a net SECTOR bet. Dispersion is mostly sector
// co-movement (L1s move together, memes move together, AI together).
//
// RV-v4's fix = SECTOR NEUTRALIZATION: rank funding and place long/short legs WITHIN
// each sector, balanced, so every sector is dollar-neutral. Sector-common moves cancel;
// only idiosyncratic funding carry + name-level residual survive. If dispersion really
// is sector-driven, carry share should JUMP vs the global book at matched leg counts.
//
// Runs GLOBAL (v3-style) vs SECTOR_NEUTRAL on the SAME data, same fees/rebal/OOS split,
// same fund-vs-price attribution, across a ~50-symbol / 6-sector crypto universe.
// Standalone research. Run: node tools/backtest/relvalue4.mjs
// SECTOR construction is imported from the deployable engine so research == live behavior.
import { buildTargetBook, sectorMap as engineSectorMap, bareTicker as bt } from "../../workers/nexus-carry-engine/carryBasket.mjs";
const API = "https://api-evm.orderly.org";

// ~50 liquid crypto perps, sector-tagged. Index/FX/commodity/equity perps excluded
// (NAS100/EURUSD/XAU/XAG/CL/SPX500/GOOGL/NVDA/TSLA/USDJPY) — different funding regimes
// muddy the carry read. Ambiguous/micro-cap infra tickers dropped. Sector = the axis
// the residual co-moves on.
const SECTORS = {
  L1: ["BTC","ETH","SOL","BNB","AVAX","NEAR","DOT","ADA","APT","SUI","SEI","TRX","TIA"],
  DEFI: ["AAVE","UNI","LINK","INJ","JUP","ENA","ONDO","PENDLE","CRV","CAKE","MORPHO","ETHFI"],
  MEME: ["DOGE","1000BONK","1000PEPE","1000SHIB","WIF","FARTCOIN","PENGU","PUMP","TRUMP","SPX"],
  AI: ["FET","TAO","WLD","VIRTUAL"],
  PAY: ["LTC","XRP","BCH","HBAR","ZEC","XMR"],
  L2: ["ARB","OP","POL","MNT","MERL"],
};
const SYM = (t) => `PERP_${t}_USDC`;
const tk = (s) => s.replace("PERP_", "").replace("_USDC", "");
const sectorOf = {};
for (const [sec, arr] of Object.entries(SECTORS)) for (const t of arr) sectorOf[SYM(t)] = sec;
const UNIVERSE = Object.values(SECTORS).flat().map(SYM);

const DAYS = 60, CAPITAL = 1000, FEE_BPS = 3, REBAL_H = 24;

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
const r2=(x)=>Math.round(x*100)/100;

// mode: "GLOBAL" (rank all, long K most-neg / short K most-pos)
//       "SECTOR"  (within each sector, long P most-neg / short P most-pos → sector $-neutral)
function run(data, syms, mode, K, P, feeBps=FEE_BPS, rebalH=REBAL_H){
  const base=data[syms[0]]; const t0=base.candles[0].t, tN=base.candles[base.candles.length-1].t;
  const step=rebalH*3600, oosCut=tN-20*86400;
  let held=new Map(), net=0, fund=0, price=0, fees=0, isNet=0, oosNet=0; const rets=[];
  const secList=[...new Set(syms.map(s=>sectorOf[s]))];
  for(let t=t0;t+step<=tN;t+=step){
    const tMs=t*1000;
    const avail=syms.map(s=>{const c0=closeAt(data[s].candles,t),c1=closeAt(data[s].candles,t+step),f=fundingAt(data[s].funding,tMs);return {s,sec:sectorOf[s],f,c0,c1,ok:c0!=null&&c1!=null&&c0>0};}).filter(x=>x.ok);
    let legs=[];
    if(mode==="GLOBAL"){
      if(avail.length<2*K) continue;
      const r=[...avail].sort((a,b)=>a.f-b.f);
      legs=[...r.slice(0,K).map(x=>({...x,side:1})),...r.slice(-K).map(x=>({...x,side:-1}))];
    } else { // SECTOR — via the SHARED deployable engine (parity guarantee)
      const funding={}; for(const x of avail) funding[bt(x.s)]=x.f;
      const book=buildTargetBook(funding, engineSectorMap(), { perSide:P, capital:CAPITAL });
      const bySym=new Map(avail.map(x=>[bt(x.s),x]));
      legs=book.legs.map(l=>({ ...bySym.get(l.symbol), side:l.side })).filter(l=>l.s);
    }
    if(legs.length<2) continue;
    const legN=CAPITAL/legs.length; // equal notional per leg, book scaled to CAPITAL
    const target=new Map(legs.map(l=>[l.s,l.side]));
    for(const s of new Set([...held.keys(),...target.keys()])) if((held.get(s)||0)!==(target.get(s)||0)) fees+=(feeBps/10000)*legN;
    held=target;
    let pp=0; const fp=rebalH/8;
    for(const l of legs){ const pr=(l.c1-l.c0)/l.c0; const pn=l.side*pr*legN; const fpnl=-l.side*l.f*fp*legN; price+=pn; fund+=fpnl; pp+=pn+fpnl; }
    net+=pp; rets.push(pp); if(t>=oosCut) oosNet+=pp; else isNet+=pp;
  }
  net-=fees;
  const n=rets.length, mean=n?rets.reduce((a,b)=>a+b,0)/n:0, sd=n?Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/n):0;
  const sharpe=sd>0?(mean/sd)*Math.sqrt((365*24)/REBAL_H):0;
  const carryShare=(Math.abs(fund)+Math.abs(price))>0?Math.abs(fund)/(Math.abs(fund)+Math.abs(price)):0;
  return { mode, K, P, net:r2(net), fund:r2(fund), price:r2(price), fees:r2(fees), isNet:r2(isNet), oosNet:r2(oosNet-fees*(20/DAYS)), sharpe:r2(sharpe), carryShare:Math.round(carryShare*100), periods:n };
}

async function main(){
  const data={}; const ok=[]; const bySec={};
  for(const s of UNIVERSE){ const [c,f]=await Promise.all([fCandles(s),fFunding(s)]); if(c.length>500&&f.length>20){data[s]={candles:c,funding:f};ok.push(s);bySec[sectorOf[s]]=(bySec[sectorOf[s]]||0)+1;} else console.error(`skip ${tk(s)} (thin: ${c.length}c/${f.length}f)`); }
  console.error(`\nUniverse: ${ok.length}/${UNIVERSE.length} usable · sectors ${Object.entries(bySec).map(([k,v])=>`${k}:${v}`).join(" ")} · $${CAPITAL} book · ${REBAL_H}h rebal · fees ${FEE_BPS}bps · ${DAYS}d\n`);

  console.log(`=== RV-v4 SECTOR-NEUTRAL vs GLOBAL CARRY (${ok.length}-sym / ${Object.keys(bySec).length}-sector, ${DAYS}d, $${CAPITAL}) ===`);
  console.log("does neutralizing SECTOR exposure let funding carry dominate the price residual?\n");
  const hdr=["mode".padEnd(8),"legs".padStart(5),"net$".padStart(9),"fund$".padStart(8),"price$".padStart(9),"fees$".padStart(7),"oos$".padStart(8),"carry%".padStart(7),"sharpe".padStart(7)];
  console.log(hdr.join(" "));

  const res=[];
  // GLOBAL baseline at K matched to sector leg totals for fair comparison
  for(const K of [6,9,12,15]){ if(2*K>ok.length) continue; const r=run(data,ok,"GLOBAL",K,0); r.legsLabel=`G K${K}(${2*K})`; res.push(r);
    console.log(r.legsLabel.padEnd(8),String(2*K).padStart(5),fmt(r)); }
  console.log("");
  // SECTOR-NEUTRAL at P longs+shorts per sector
  for(const P of [1,2,3]){ const r=run(data,ok,"SECTOR",0,P); r.legsLabel=`S P${P}`; res.push(r);
    console.log(r.legsLabel.padEnd(8),String(r.periods?"~":"").padStart(5),fmt(r)); }

  // ── Cost sensitivity on the winner (SECTOR P1) — is it a fee problem or a signal problem?
  console.log("\n--- COST SENSITIVITY · SECTOR P1 (the neutralized winner) ---");
  console.log("if a real carry is just being eaten by taker fees at 24h, maker / slower rebal should rescue it.\n");
  console.log(["fee/rebal".padEnd(14),"net$".padStart(9),"fund$".padStart(8),"price$".padStart(9),"fees$".padStart(7),"oos$".padStart(8),"carry%".padStart(7),"sharpe".padStart(7)].join(" "));
  const sens=[];
  for(const [label,fee,rebal] of [["taker3 · 24h",3,24],["gross0 · 24h",0,24],["maker-0.1 · 24h",-0.1,24],["taker3 · 48h",3,48],["maker-0.1 · 48h",-0.1,48]]){
    const r=run(data,ok,"SECTOR",0,1,fee,rebal); sens.push({label,...r});
    console.log(label.padEnd(14),fmt(r));
  }

  console.log("\n--- VERDICT ---");
  const glob=res.filter(r=>r.mode==="GLOBAL"), sect=res.filter(r=>r.mode==="SECTOR");
  const gCarry=Math.round(glob.reduce((a,b)=>a+b.carryShare,0)/glob.length);
  const sCarry=Math.round(sect.reduce((a,b)=>a+b.carryShare,0)/sect.length);
  console.log(`avg carry share  GLOBAL ${gCarry}%  →  SECTOR-NEUTRAL ${sCarry}%  (Δ ${sCarry-gCarry>=0?"+":""}${sCarry-gCarry}pt)`);
  const winners=sect.filter(r=>r.carryShare>=55 && r.net>0 && r.oosNet>0);
  const bestS=[...sect].sort((a,b)=>b.oosNet-a.oosNet)[0];
  console.log(`sector-neutral carry-dominant (≥55% carry, net+ & oos+): ${winners.length}`);
  console.log(winners.length
    ? `→ ⭐ SECTOR NEUTRALIZATION UNLOCKS THE CARRY. Best: ${bestS.legsLabel} net $${bestS.net} / oos $${bestS.oosNet} / ${bestS.carryShare}% carry, sharpe ${bestS.sharpe}. The residual WAS sector co-movement. Deployability check next: costs at scale, leg count, live funding freshness.`
    : sCarry>gCarry+10
    ? `→ sector neutralization RAISES carry share (${gCarry}%→${sCarry}%) — the sector-co-movement thesis is directionally RIGHT — but it hasn't crossed dominance / OOS+ on ${DAYS}d. Levers: longer window, finer sectors, or accept a low-Sharpe sleeve.`
    : `→ sector neutralization did NOT make carry dominate. The residual is name-idiosyncratic, not sector-common — no clean neutralization exists at retail scale. This EXHAUSTS the RV lever; the engine verdict stands (moat = intelligence + trustless grading, not house alpha).`);
  console.log(`\nbest sector-neutral row: ${bestS.legsLabel}  net $${bestS.net}  fund $${bestS.fund}  price $${bestS.price}  oos $${bestS.oosNet}  carry ${bestS.carryShare}%  sharpe ${bestS.sharpe}  (${bestS.periods} rebals)`);
}
function fmt(r){ return [String(r.net).padStart(9),String(r.fund).padStart(8),String(r.price).padStart(9),String(r.fees).padStart(7),String(r.oosNet).padStart(8),`${r.carryShare}%`.padStart(7),String(r.sharpe).padStart(7)].join(" "); }
main().catch(e=>{console.error(e);process.exit(1);});
