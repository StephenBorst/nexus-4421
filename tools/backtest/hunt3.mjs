// ── HUNT-v3 · CONDITIONING FILTERS ───────────────────────────────────────────
// The raw signals are net-negative, but there are pockets (inverted CONFLUENCE + OI
// was gross-positive). The thesis: the edge is in WHEN a signal fires, not the signal.
// This conditions the promising bases on no-lookahead filters — session (UTC hour),
// volatility (ATR band), and trend-agreement — via the engine's new entryFilter hook,
// and reports whether each filter lifts HIT RATE + net vs the unfiltered base. The
// winner is a filter that improves BOTH hit rate and net across symbols (a real
// conditional edge), not one that just cherry-picks a lucky window (trades collapse).
// Run: node tools/backtest/hunt3.mjs
import { runBacktest, makeFundingPctAt, makeOiChangeAt, oiSeriesInfo, atrPctAt } from "../../workers/nexus-lab-api/backtest.mjs";

const API = "https://api-evm.orderly.org", LAB_API = "https://og.nexustradinglabs.com";
const SYMBOLS = ["PERP_BTC_USDC","PERP_ETH_USDC","PERP_SOL_USDC","PERP_HYPE_USDC","PERP_XRP_USDC"];
const DAYS = 60;

async function fOi(s){ try{ const d=await fetch(`${LAB_API}/agent/oi-history/${s}`).then(r=>r.json()); return Array.isArray(d?.points)?d.points:[]; }catch{ return []; } }
async function fCandles(s){ const now=Math.floor(Date.now()/1000),from=now-DAYS*86400,out=[];let cur=from;while(cur<now){const to=Math.min(cur+20*86400,now);const d=await fetch(`${API}/tv/history?symbol=${s}&resolution=60&from=${cur}&to=${to}`).then(r=>r.json());if(d&&d.s==="ok")for(let i=0;i<d.t.length;i++)out.push({t:d.t[i],o:d.o[i],h:d.h[i],l:d.l[i],c:d.c[i]});cur=to;}const seen=new Set();return out.filter(c=>(seen.has(c.t)?false:seen.add(c.t))).sort((a,b)=>a.t-b.t); }
async function fFunding(s){ const rows=[];for(let p=1;p<=3;p++){const d=await fetch(`${API}/v1/public/funding_rate_history?symbol=${s}&page=${p}&size=100`).then(r=>r.json());const rs=d?.data?.rows||[];rows.push(...rs.map(x=>({ts:x.funding_rate_timestamp,rate:x.funding_rate})));if(rs.length<100)break;}rows.sort((a,b)=>a.ts-b.ts);const at=(t)=>{const ms=t*1000;let r=0;for(const x of rows){if(x.ts<=ms)r=x.rate;else break;}return r;};return {at,rows}; }

// ── the filters (no lookahead — only candles strictly before i) ──
const utcHour = (c,i)=> new Date(c[i].t*1000).getUTCHours();
const session = (c,i)=>{ const h=utcHour(c,i); return h<8?"Asia":h<15?"Europe":"US"; };
// trend over the last `lk` bars, as sign of the net move BEFORE i.
const trendSign = (c,i,lk=6)=>{ if(i<lk+1) return 0; const a=c[i-lk].c,b=c[i-1].c; return b>a*1.001?1:b<a*0.999?-1:0; };

const FILTERS = {
  "none": null,
  "sess:US": (c,i)=> session(c,i)==="US",
  "sess:EU": (c,i)=> session(c,i)==="Europe",
  "sess:Asia": (c,i)=> session(c,i)==="Asia",
  "sess:US+EU": (c,i)=> session(c,i)!=="Asia",
  "vol:calm(<0.4)": (c,i)=>{ const a=atrPctAt(c,i); return a!=null && a<0.4; },
  "vol:normal(.4-.9)": (c,i)=>{ const a=atrPctAt(c,i); return a!=null && a>=0.4 && a<0.9; },
  "vol:high(>0.9)": (c,i)=>{ const a=atrPctAt(c,i); return a!=null && a>=0.9; },
  "trend:with-sig": (c,i,sig)=>{ const t=trendSign(c,i); return t!==0 && ((sig.direction==="LONG"&&t>0)||(sig.direction==="SHORT"&&t<0)); },
  "trend:against-sig": (c,i,sig)=>{ const t=trendSign(c,i); return t!==0 && ((sig.direction==="LONG"&&t<0)||(sig.direction==="SHORT"&&t>0)); },
  "trend:quiet(chop)": (c,i)=> trendSign(c,i)===0,
};

const BASE = { leverage:5, capitalPerTrade:50, maxHoldHours:4, feeBps:3, tpPercent:2, slPercent:1 };
const BASES = {
  "INV-CONFLUENCE oi1": { needsOi:true, config:{ ...BASE, signalMode:"CONFLUENCE", fundingThreshold:0.01, oiChangeThreshold:1, invertSignal:true } },
  "FUNDING pct95": { needsOi:false, config:{ ...BASE, signalMode:"FUNDING_ONLY", fundingThreshold:0.01, fundingPercentileMin:95, oiChangeThreshold:0 } },
  "MEAN_REV p0.5": { needsOi:false, config:{ ...BASE, signalMode:"MEAN_REVERSION", priceChangeThreshold:0.5, oiChangeThreshold:0 } },
};

function evalCfg(data, syms, config, filter){
  let net=0,trades=0,wins=0,pf=[];
  for(const s of syms){ const d=data[s]; const r=runBacktest(d.candles,d.at,config,d.pctAt,d.oiAt,filter); net+=r.netUsd; trades+=r.trades; wins+=Math.round(r.winRate/100*r.trades); if(r.profitFactor)pf.push(r.profitFactor); }
  return { net:Math.round(net*100)/100, win:trades?Math.round(wins/trades*1000)/10:0, trades, pf:pf.length?Math.round(pf.reduce((a,b)=>a+b,0)/pf.length*100)/100:0 };
}

async function main(){
  const data={}, oiSyms=[];
  for(const s of SYMBOLS){ const candles=await fCandles(s),{at,rows}=await fFunding(s),oi=await fOi(s); const info=oiSeriesInfo(oi),mature=info.days>=14&&info.samples>=200; if(mature)oiSyms.push(s); data[s]={candles,at,pctAt:makeFundingPctAt(rows),oiAt:mature?makeOiChangeAt(oi):null}; }
  console.error(`OI-mature: ${oiSyms.map(s=>s.replace("PERP_","").replace("_USDC","")).join(",")}\n`);
  console.log(`=== HUNT-v3 CONDITIONING (${SYMBOLS.length} symbols, ${DAYS}d, tp2/sl1, fees on) ===`);
  console.log("does a filter lift HIT RATE + net vs the unfiltered base? (Δ = vs 'none')\n");
  for(const [bname,{needsOi,config}] of Object.entries(BASES)){
    const syms = needsOi?oiSyms:SYMBOLS; if(!syms.length){ console.log(`-- ${bname}: no OI-mature symbols, skipped --\n`); continue; }
    const baseRes = evalCfg(data,syms,config,null);
    console.log(`── ${bname}  (base: net $${baseRes.net} · win ${baseRes.win}% · ${baseRes.trades} trades) ──`);
    console.log("filter".padEnd(20),"net$".padStart(9),"Δnet".padStart(8),"win%".padStart(6),"Δwin".padStart(7),"trades".padStart(7),"keep%".padStart(6));
    const rows=[];
    for(const [fname,filter] of Object.entries(FILTERS)){
      const r=evalCfg(data,syms,config,filter);
      rows.push({fname,...r,dNet:Math.round((r.net-baseRes.net)*100)/100,dWin:Math.round((r.win-baseRes.win)*10)/10,keep:baseRes.trades?Math.round(r.trades/baseRes.trades*100):0});
    }
    for(const r of rows){
      const star = (r.fname!=="none" && r.dWin>=3 && r.net>r.net-r.dNet && r.trades>=15 && r.keep>=20) ? " ⭐" : "";
      console.log(r.fname.padEnd(20),String(r.net).padStart(9),String(r.dNet>=0?`+${r.dNet}`:r.dNet).padStart(8),`${r.win}%`.padStart(6),String(r.dWin>=0?`+${r.dWin}`:r.dWin).padStart(7),String(r.trades).padStart(7),`${r.keep}%`.padStart(6)+star);
    }
    console.log("");
  }
  console.log("⭐ = filter lifts win rate ≥3pts, keeps ≥20% of trades (≥15), and isn't just fewer-trades luck.");
  console.log("The real find = a filter that lifts BOTH win% AND net with a decent trade count across symbols.");
}
main().catch(e=>{console.error(e);process.exit(1);});
