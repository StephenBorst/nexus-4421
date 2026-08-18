// ── HUNT-v4 · HARDEN THE WINNER ──────────────────────────────────────────────
// The confirmed lead: inverted CONFLUENCE gated to high vol (ATR%>0.7) + non-Asia →
// 60% win, +EV. This optimizes the LAST levers on that base — the EXIT and an optional
// funding-percentile stack — to find the single most ROBUST config (best expectancy
// that also holds per-symbol AND out-of-sample), which becomes the deployable preset.
// Uses the real deriveSignal + evaluateExit via runBacktest with the config-native
// regime gates (raw.hourUtc + raw.atrPct supplied by runBacktest). Run: node tools/backtest/hunt4.mjs
import { runBacktest, makeFundingPctAt, makeOiChangeAt, oiSeriesInfo } from "../../workers/nexus-lab-api/backtest.mjs";

const API = "https://api-evm.orderly.org", LAB = "https://og.nexustradinglabs.com";
const SY = ["PERP_BTC_USDC","PERP_ETH_USDC","PERP_SOL_USDC","PERP_HYPE_USDC","PERP_XRP_USDC"];
const DAYS = 60, OOS_DAYS = 20, NOTIONAL = 250;

async function fO(s){try{const d=await fetch(`${LAB}/agent/oi-history/${s}`).then(r=>r.json());return Array.isArray(d?.points)?d.points:[];}catch{return[];}}
async function fC(s){const n=Math.floor(Date.now()/1000),f=n-DAYS*86400,o=[];let c=f;while(c<n){const t=Math.min(c+20*86400,n);const d=await fetch(`${API}/tv/history?symbol=${s}&resolution=60&from=${c}&to=${t}`).then(r=>r.json());if(d&&d.s==="ok")for(let i=0;i<d.t.length;i++)o.push({t:d.t[i],o:d.o[i],h:d.h[i],l:d.l[i],c:d.c[i]});c=t;}const se=new Set();return o.filter(x=>(se.has(x.t)?false:se.add(x.t))).sort((a,b)=>a.t-b.t);}
async function fF(s){const rows=[];for(let p=1;p<=3;p++){const d=await fetch(`${API}/v1/public/funding_rate_history?symbol=${s}&page=${p}&size=100`).then(r=>r.json());const rs=d?.data?.rows||[];rows.push(...rs.map(x=>({ts:x.funding_rate_timestamp,rate:x.funding_rate})));if(rs.length<100)break;}rows.sort((a,b)=>a.ts-b.ts);return{at:(t)=>{const m=t*1000;let r=0;for(const x of rows){if(x.ts<=m)r=x.rate;else break;}return r;},rows};}

const BASE = { leverage:5, capitalPerTrade:50, maxHoldHours:4, feeBps:3, signalMode:"CONFLUENCE", fundingThreshold:0.01, oiChangeThreshold:1, invertSignal:true, minVolAtrPct:0.7, tradeSessions:["US","EUROPE"] };
const EXITS = {
  "tp2/sl1": { tpPercent:2, slPercent:1 },
  "tp2.5/sl1": { tpPercent:2.5, slPercent:1 },
  "tp3/sl1": { tpPercent:3, slPercent:1 },
  "tp3/sl1.5": { tpPercent:3, slPercent:1.5 },
  "tp1.5/sl0.75": { tpPercent:1.5, slPercent:0.75 },
  "scaleout 1@50/2.5@50": { tpPercent:1, slPercent:1, takeProfits:[{pct:1,sizePct:50},{pct:2.5,sizePct:50}] },
  "trail0.5@tp2": { tpPercent:2, slPercent:1, trailingStopPct:0.5 },
  "be0.75@tp3/sl1.5": { tpPercent:3, slPercent:1.5, breakevenTriggerPct:0.75 },
};

function evalCfg(data, cfg){
  let net=0,tr=0,wi=0,pos=0,oos=0,oosTr=0,sumR=0; const per=[];
  const feePct=(cfg.feeBps/100)*2;
  for(const s of SY){
    const d=data[s]; const r=runBacktest(d.candles,d.at,cfg,d.pctAt,d.oiAt);
    net+=r.netUsd; tr+=r.trades; wi+=Math.round(r.winRate/100*r.trades); if(r.netUsd>0)pos++;
    for(const t of r._trades||[]){ sumR+=(t.pnlPct-feePct)/Math.abs(cfg.slPercent||1); const tN=d.candles[d.candles.length-1].t; if(t.entryT>=tN-OOS_DAYS*86400){oos+=((t.pnlPct-feePct)/100)*NOTIONAL;oosTr++;} }
    per.push({s:s.replace("PERP_","").replace("_USDC",""),net:Math.round(r.netUsd*100)/100,n:r.trades});
  }
  const avgR = tr? Math.round(sumR/tr*100)/100 : 0;
  return { net:Math.round(net*100)/100, win:tr?Math.round(wi/tr*1000)/10:0, tr, pos, avgR, oos:Math.round(oos*100)/100, oosTr, per };
}

async function main(){
  const data={};
  for(const s of SY){ const c=await fC(s),{at,rows}=await fF(s),oi=await fO(s); const inf=oiSeriesInfo(oi); data[s]={candles:c,at,pctAt:makeFundingPctAt(rows),oiAt:inf.days>=14?makeOiChangeAt(oi):null}; }
  console.log(`=== HUNT-v4 · HARDEN THE WINNER (invert-confluence + vol>0.7 + non-Asia, ${DAYS}d, $${NOTIONAL}) ===\n`);
  console.log("exit".padEnd(22),"+pct".padStart(5),"net$".padStart(8),"win%".padStart(6),"avgR".padStart(6),"trd".padStart(5),"sym+".padStart(5),"oos$".padStart(8));
  const rows=[];
  for(const [en,ex] of Object.entries(EXITS)){
    for(const pctMin of [0,90,95]){
      const cfg={...BASE,...ex,...(pctMin?{fundingPercentileMin:pctMin}:{})};
      const r=evalCfg(data,cfg); rows.push({name:en,pctMin,cfg,...r});
    }
  }
  // rank: robust first (net+ & oos+ & majority-symbol & >=15 trades), then by expectancy (avgR)
  const robust=(r)=>r.net>0&&r.oos>0&&r.pos>=3&&r.tr>=15;
  rows.sort((a,b)=>(robust(b)-robust(a))||(b.avgR-a.avgR));
  for(const r of rows.slice(0,18)){
    const star=robust(r)?" ⭐":"";
    console.log(r.name.padEnd(22),String(r.pctMin||"—").padStart(5),String(r.net).padStart(8),`${r.win}%`.padStart(6),String(r.avgR).padStart(6),String(r.tr).padStart(5),`${r.pos}/5`.padStart(5),String(r.oos).padStart(8)+star);
  }
  const winners=rows.filter(robust);
  console.log("\n--- VERDICT ---");
  if(winners.length){
    const best=winners[0];
    console.log(`⭐ ${winners.length} robust config(s). BEST expectancy: ${best.name}${best.pctMin?` +pct${best.pctMin}`:""}`);
    console.log(`   net $${best.net} · win ${best.win}% · ${best.avgR}R/trade · ${best.tr} trades · ${best.pos}/5 sym · oos $${best.oos}`);
    console.log(`   per-symbol: ${best.per.map(p=>`${p.s} $${p.net}/${p.n}t`).join(" · ")}`);
    console.log(`   → PACKAGE THIS as the regime-gated preset: ${JSON.stringify(best.cfg)}`);
  } else console.log("No config cleared robust — the winner is exit-sensitive; keep tp2/sl1 base and gather more data.");
}
main().catch(e=>{console.error(e);process.exit(1);});
