// ── HUNT-v5 · PORTFOLIO — find a SECOND robust conditional edge ──────────────
// The regime-gated invert-confluence cleared the bar. The conditioning approach (the
// edge is in WHEN) should generalize: hunt3 hinted MEAN_REVERSION loses far less in
// CALM vol, and funding-percentile is selective. This grids every promising base ×
// vol regime × session (via the config-native gates) at a fixed tp2/sl1, ranked by
// robust expectancy (net+ AND oos+ AND majority-symbol AND ≥15 trades). A second ⭐
// = a second deployable preset. Run: node tools/backtest/hunt5.mjs
import { runBacktest, makeFundingPctAt, makeOiChangeAt, oiSeriesInfo } from "../../workers/nexus-lab-api/backtest.mjs";

const API = "https://api-evm.orderly.org", LAB = "https://og.nexustradinglabs.com";
const SY = ["PERP_BTC_USDC","PERP_ETH_USDC","PERP_SOL_USDC","PERP_HYPE_USDC","PERP_XRP_USDC"];
const DAYS = 60, OOS_DAYS = 20, NOTIONAL = 250;

async function fO(s){try{const d=await fetch(`${LAB}/agent/oi-history/${s}`).then(r=>r.json());return Array.isArray(d?.points)?d.points:[];}catch{return[];}}
async function fC(s){const n=Math.floor(Date.now()/1000),f=n-DAYS*86400,o=[];let c=f;while(c<n){const t=Math.min(c+20*86400,n);const d=await fetch(`${API}/tv/history?symbol=${s}&resolution=60&from=${c}&to=${t}`).then(r=>r.json());if(d&&d.s==="ok")for(let i=0;i<d.t.length;i++)o.push({t:d.t[i],o:d.o[i],h:d.h[i],l:d.l[i],c:d.c[i]});c=t;}const se=new Set();return o.filter(x=>(se.has(x.t)?false:se.add(x.t))).sort((a,b)=>a.t-b.t);}
async function fF(s){const rows=[];for(let p=1;p<=3;p++){const d=await fetch(`${API}/v1/public/funding_rate_history?symbol=${s}&page=${p}&size=100`).then(r=>r.json());const rs=d?.data?.rows||[];rows.push(...rs.map(x=>({ts:x.funding_rate_timestamp,rate:x.funding_rate})));if(rs.length<100)break;}rows.sort((a,b)=>a.ts-b.ts);return{at:(t)=>{const m=t*1000;let r=0;for(const x of rows){if(x.ts<=m)r=x.rate;else break;}return r;},rows};}

const COMMON = { leverage:5, capitalPerTrade:50, maxHoldHours:4, feeBps:3, tpPercent:2, slPercent:1, oiChangeThreshold:0 };
const BASES = {
  "MEAN_REV p0.5": { signalMode:"MEAN_REVERSION", priceChangeThreshold:0.5 },
  "MEAN_REV p0.3": { signalMode:"MEAN_REVERSION", priceChangeThreshold:0.3 },
  "MOMENTUM p0.8": { signalMode:"MOMENTUM", priceChangeThreshold:0.8 },
  "FUNDING f0.01": { signalMode:"FUNDING_ONLY", fundingThreshold:0.01 },
  "FUNDING pct95": { signalMode:"FUNDING_ONLY", fundingThreshold:0.01, fundingPercentileMin:95 },
  "OI_ONLY": { signalMode:"OI_ONLY", oiChangeThreshold:1 },
  "INV-FUNDING pct95": { signalMode:"FUNDING_ONLY", fundingThreshold:0.01, fundingPercentileMin:95, invertSignal:true },
};
const REGIMES = {
  "raw": {},
  "hivol>0.7": { minVolAtrPct:0.7 },
  "calm<0.5": { maxVolAtrPct:0.5 },
  "calm<0.4": { maxVolAtrPct:0.4 },
  "non-Asia": { tradeSessions:["US","EUROPE"] },
  "hivol+nonAsia": { minVolAtrPct:0.7, tradeSessions:["US","EUROPE"] },
  "calm+nonAsia": { maxVolAtrPct:0.5, tradeSessions:["US","EUROPE"] },
};

function evalCfg(data, cfg){
  let net=0,tr=0,wi=0,pos=0,oos=0,sumR=0; const feePct=(cfg.feeBps/100)*2;
  for(const s of SY){ const d=data[s]; const r=runBacktest(d.candles,d.at,cfg,d.pctAt,d.oiAt); net+=r.netUsd; tr+=r.trades; wi+=Math.round(r.winRate/100*r.trades); if(r.netUsd>0)pos++;
    const tN=d.candles[d.candles.length-1].t; for(const t of r._trades||[]){ sumR+=(t.pnlPct-feePct)/Math.abs(cfg.slPercent||1); if(t.entryT>=tN-OOS_DAYS*86400) oos+=((t.pnlPct-feePct)/100)*NOTIONAL; } }
  return { net:Math.round(net*100)/100, win:tr?Math.round(wi/tr*1000)/10:0, tr, pos, avgR:tr?Math.round(sumR/tr*100)/100:0, oos:Math.round(oos*100)/100 };
}

async function main(){
  const data={};
  for(const s of SY){ const c=await fC(s),{at,rows}=await fF(s),oi=await fO(s); const inf=oiSeriesInfo(oi); data[s]={candles:c,at,pctAt:makeFundingPctAt(rows),oiAt:inf.days>=14?makeOiChangeAt(oi):null}; }
  console.log(`=== HUNT-v5 · PORTFOLIO (${SY.length} symbols, ${DAYS}d, tp2/sl1, $${NOTIONAL}) — hunt a 2nd robust edge ===\n`);
  const robust=(r)=>r.net>0&&r.oos>0&&r.pos>=3&&r.tr>=15;
  const all=[];
  for(const [bn,bc] of Object.entries(BASES)){
    for(const [rn,rc] of Object.entries(REGIMES)){
      const cfg={...COMMON,...bc,...rc};
      const r=evalCfg(data,cfg); all.push({base:bn,regime:rn,cfg,...r});
    }
  }
  all.sort((a,b)=>(robust(b)-robust(a))||(b.avgR-a.avgR));
  console.log("base".padEnd(20),"regime".padEnd(15),"net$".padStart(8),"win%".padStart(6),"avgR".padStart(6),"trd".padStart(5),"sym+".padStart(5),"oos$".padStart(8));
  for(const r of all.slice(0,20)){ const star=robust(r)?" ⭐":""; console.log(r.base.padEnd(20),r.regime.padEnd(15),String(r.net).padStart(8),`${r.win}%`.padStart(6),String(r.avgR).padStart(6),String(r.tr).padStart(5),`${r.pos}/5`.padStart(5),String(r.oos).padStart(8)+star); }
  const winners=all.filter(robust);
  console.log("\n--- VERDICT ---");
  console.log(`robust conditional edges found: ${winners.length}`);
  for(const w of winners.slice(0,5)) console.log(`  ⭐ ${w.base} · ${w.regime}: net $${w.net} · ${w.win}% · ${w.avgR}R · ${w.tr}t · ${w.pos}/5 · oos $${w.oos}`);
  if(winners.length>=2) console.log(`\n→ a SECOND edge exists — package the best non-invert one as a portfolio preset.`);
  else console.log(`\n→ still only the invert-confluence edge clears the bar. The conditioning generalizes as a FILTER (cuts losses everywhere) but a 2nd standalone robust edge isn't here on 60d.`);
}
main().catch(e=>{console.error(e);process.exit(1);});
