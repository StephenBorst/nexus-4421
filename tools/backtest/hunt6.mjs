// ── HUNT-v6 · ENTRY TIMING — "right but late" ────────────────────────────────
// The regime-gated invert-confluence edge is directionally right, but it fires when
// funding+OI are ALREADY extreme — i.e. after the crowd is max-positioned and the
// reversion may have started. So we enter LATE and catch less of the move. This tests
// whether TIMING the entry better lifts the edge: enter immediately (baseline) vs next
// bar's open vs waiting for a PULLBACK (a better fade price) vs a short delay. Reuses
// the REAL deriveSignal (with the live regime gates) + evaluateExit + computePnl, only
// the ENTRY price/bar changes. Run: node tools/backtest/hunt6.mjs
import { deriveSignal } from "../../workers/nexus-agent-brain/logic.mjs";
import { evaluateExit, computePnl, breakevenArmed } from "../../workers/nexus-agent-exec/logic.mjs";
import { makeFundingPctAt, makeOiChangeAt, oiSeriesInfo, atrPctAt } from "../../workers/nexus-lab-api/backtest.mjs";

const API = "https://api-evm.orderly.org", LAB = "https://og.nexustradinglabs.com";
const SY = ["PERP_BTC_USDC","PERP_ETH_USDC","PERP_SOL_USDC","PERP_HYPE_USDC","PERP_XRP_USDC"];
const DAYS = 60, NOTIONAL = 250, FEE_PCT = 0.06; // 3bps × 2 sides
const CFG = { leverage:5, capitalPerTrade:50, maxHoldHours:4, signalMode:"CONFLUENCE", invertSignal:true, fundingThreshold:0.01, oiChangeThreshold:1, minVolAtrPct:0.7, tradeSessions:["US","EUROPE"], tpPercent:2, slPercent:1 };

async function fO(s){try{const d=await fetch(`${LAB}/agent/oi-history/${s}`).then(r=>r.json());return Array.isArray(d?.points)?d.points:[];}catch{return[];}}
async function fC(s){const n=Math.floor(Date.now()/1000),f=n-DAYS*86400,o=[];let c=f;while(c<n){const t=Math.min(c+20*86400,n);const d=await fetch(`${API}/tv/history?symbol=${s}&resolution=60&from=${c}&to=${t}`).then(r=>r.json());if(d&&d.s==="ok")for(let i=0;i<d.t.length;i++)o.push({t:d.t[i],o:d.o[i],h:d.h[i],l:d.l[i],c:d.c[i]});c=t;}const se=new Set();return o.filter(x=>(se.has(x.t)?false:se.add(x.t))).sort((a,b)=>a.t-b.t);}
async function fF(s){const rows=[];for(let p=1;p<=3;p++){const d=await fetch(`${API}/v1/public/funding_rate_history?symbol=${s}&page=${p}&size=100`).then(r=>r.json());const rs=d?.data?.rows||[];rows.push(...rs.map(x=>({ts:x.funding_rate_timestamp,rate:x.funding_rate})));if(rs.length<100)break;}rows.sort((a,b)=>a.ts-b.ts);return{at:(t)=>{const m=t*1000;let r=0;for(const x of rows){if(x.ts<=m)r=x.rate;else break;}return r;},rows};}

// Simulate exits from an open position (entryIdx, entryPrice, dir) → {pnlPct, holdH}.
function simExit(candles, entryIdx, entryPrice, dir){
  const pos = { direction:dir, entry:entryPrice, tpPercent:CFG.tpPercent, slPercent:CFG.slPercent, tp_hits:[], peak_pnl_pct:0, remaining:1 };
  const t0 = candles[entryIdx].t;
  for(let i=entryIdx+1;i<candles.length;i++){
    const c=candles[i], holdMs=(c.t-t0)*1000;
    const adv = dir==="LONG"?c.l:c.h, fav = dir==="LONG"?c.h:c.l;
    for(const px of [adv,fav,c.c]){
      const { pnlPct } = computePnl(dir, entryPrice, px, 1);
      pos.be_armed = breakevenArmed(pos, pnlPct, CFG.breakevenTriggerPct);
      const a = evaluateExit(pos, pnlPct, holdMs, CFG);
      if(a && a.type==="FULL_CLOSE") return { pnlPct, holdH:(c.t-t0)/3600 };
      if(a && a.type==="TRAIL_UPDATE"){ pos.peak_pnl_pct=a.peak; }
    }
  }
  const last=candles[candles.length-1]; const { pnlPct } = computePnl(dir, entryPrice, last.c, 1);
  return { pnlPct, holdH:(last.t-t0)/3600 };
}

// Find every entry signal (bar index + dir) the winning config produces.
function signalBars(d){
  const { candles, at, pctAt, oiAt } = d; const out=[];
  let lastExit=-Infinity;
  for(let i=1;i<candles.length;i++){
    if(i-lastExit<=1) continue;
    const c=candles[i], prev=candles[i-1];
    const raw={ priceChange:(c.c-prev.c)/prev.c, oiChange: oiAt?(oiAt(c.t)??0):0, fundingRate:at(c.t)||0, hasPrev:true,
      hourUtc:new Date(c.t*1000).getUTCHours(), atrPct: atrPctAt(candles,i) };
    if(pctAt && (CFG.fundingPercentileMin||0)>0) raw.fundingPct=pctAt(c.t, raw.fundingRate);
    const sig=deriveSignal(raw, CFG);
    if(sig.direction && sig.direction!=="NONE" && (sig.confidence??0)>=50){ out.push({ i, dir:sig.direction }); lastExit=i+3; }
  }
  return out;
}

// Apply a timing variant to one signal → { entryIdx, entryPrice } or null (skipped).
function timedEntry(candles, sig, variant){
  const { i, dir } = sig;
  if(variant.kind==="immediate") return { entryIdx:i, entryPrice:candles[i].c };
  if(variant.kind==="nextopen"){ const n=candles[i+1]; return n?{ entryIdx:i+1, entryPrice:n.o }:null; }
  if(variant.kind==="delay"){ const j=i+variant.n; return candles[j]?{ entryIdx:j, entryPrice:candles[j].c }:null; }
  if(variant.kind==="pullback"){
    // Better fade price = price pushes FURTHER the crowd's way first. SHORT fade → wait
    // for a HIGHER price (target = entry×(1+P)); LONG fade → a LOWER price.
    const base=candles[i].c, P=variant.p/100;
    const target = dir==="SHORT" ? base*(1+P) : base*(1-P);
    for(let k=i+1;k<=i+variant.n && k<candles.length;k++){
      const bar=candles[k];
      if(dir==="SHORT" ? bar.h>=target : bar.l<=target) return { entryIdx:k, entryPrice:target };
    }
    return null; // no pullback within window → skip (only take the better entries)
  }
  return null;
}

function evalVariant(data, variant){
  let tr=0,wins=0,sumR=0,net=0,entryImp=0;
  for(const s of SY){
    const d=data[s]; const sigs=signalBars(d);
    for(const sig of sigs){
      const e=timedEntry(d.candles, sig, variant); if(!e) continue;
      const { pnlPct } = simExit(d.candles, e.entryIdx, e.entryPrice, sig.dir);
      const netPct=pnlPct-FEE_PCT;
      tr++; if(netPct>0)wins++; sumR+=netPct/CFG.slPercent; net+=(netPct/100)*NOTIONAL;
      // entry improvement vs immediate entry price (positive = better fade fill)
      const imm=d.candles[sig.i].c; entryImp += sig.dir==="SHORT" ? (e.entryPrice-imm)/imm*100 : (imm-e.entryPrice)/imm*100;
    }
  }
  return { tr, win:tr?Math.round(wins/tr*1000)/10:0, avgR:tr?Math.round(sumR/tr*100)/100:0, net:Math.round(net*100)/100, entryImp:tr?Math.round(entryImp/tr*1000)/1000:0 };
}

async function main(){
  const data={};
  for(const s of SY){ const c=await fC(s),{at,rows}=await fF(s),oi=await fO(s); const inf=oiSeriesInfo(oi); data[s]={candles:c,at,pctAt:makeFundingPctAt(rows),oiAt:inf.days>=14?makeOiChangeAt(oi):null}; }
  console.log(`=== HUNT-v6 · ENTRY TIMING on the regime-gated invert edge (${SY.length} sym, ${DAYS}d) ===`);
  console.log("does a better-timed entry lift the edge? entryImp = avg % better fade fill vs immediate\n");
  console.log("variant".padEnd(18),"net$".padStart(8),"win%".padStart(6),"avgR".padStart(6),"trd".padStart(5),"entryImp%".padStart(10));
  const variants=[
    { kind:"immediate", name:"immediate (base)" },
    { kind:"nextopen", name:"next-bar open" },
    { kind:"delay", n:1, name:"delay 1 bar" },
    { kind:"delay", n:2, name:"delay 2 bars" },
    { kind:"pullback", p:0.2, n:3, name:"pullback 0.2%/3" },
    { kind:"pullback", p:0.3, n:4, name:"pullback 0.3%/4" },
    { kind:"pullback", p:0.5, n:6, name:"pullback 0.5%/6" },
    { kind:"pullback", p:0.8, n:8, name:"pullback 0.8%/8" },
  ];
  const rows=[];
  for(const v of variants){ const r=evalVariant(data,v); rows.push({name:v.name,...r}); console.log(v.name.padEnd(18),String(r.net).padStart(8),`${r.win}%`.padStart(6),String(r.avgR).padStart(6),String(r.tr).padStart(5),String(r.entryImp).padStart(10)); }
  const base=rows[0], best=[...rows].sort((a,b)=>b.avgR-a.avgR)[0];
  console.log("\n--- VERDICT ---");
  console.log(`base (immediate): ${base.win}% · ${base.avgR}R · ${base.tr} trades`);
  if(best.name!==base.name && best.avgR>base.avgR+0.05 && best.tr>=12){
    console.log(`⭐ BETTER TIMING: ${best.name} → ${best.win}% · ${best.avgR}R · ${best.tr}t · ${best.entryImp}% better fill. Timing the entry lifts the edge — apply it.`);
  } else {
    console.log(`→ no timing variant beats immediate materially — the edge is in the SIGNAL+regime, not a pullback game. "Right but late" is the signal firing at the extreme; earlier detection (anticipating the setup) is the next lever, not a better fill.`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
