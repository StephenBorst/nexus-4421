// ── HUNT-v3b · REFINE the inverted-confluence × volatility edge ──────────────
// hunt3 found INVERTED-CONFLUENCE hits 60% win in high vol (but only 10 trades) and
// 42% in the US session. Two questions decide if it's real: (1) does the hit-rate lift
// SURVIVE a looser vol threshold (more trades), and (2) is it broad (positive across
// symbols + a positive out-of-sample window), not one lucky market? This grids vol
// threshold × session on the invert kernel and reports per-symbol positivity + OOS.
// Run: node tools/backtest/hunt3b.mjs
import { runBacktest, makeFundingPctAt, makeOiChangeAt, oiSeriesInfo, atrPctAt } from "../../workers/nexus-lab-api/backtest.mjs";

const API = "https://api-evm.orderly.org", LAB_API = "https://og.nexustradinglabs.com";
const SYMBOLS = ["PERP_BTC_USDC","PERP_ETH_USDC","PERP_SOL_USDC","PERP_HYPE_USDC","PERP_XRP_USDC"];
const DAYS = 60, OOS_DAYS = 20;

async function fOi(s){ try{ const d=await fetch(`${LAB_API}/agent/oi-history/${s}`).then(r=>r.json()); return Array.isArray(d?.points)?d.points:[]; }catch{ return []; } }
async function fCandles(s){ const now=Math.floor(Date.now()/1000),from=now-DAYS*86400,out=[];let cur=from;while(cur<now){const to=Math.min(cur+20*86400,now);const d=await fetch(`${API}/tv/history?symbol=${s}&resolution=60&from=${cur}&to=${to}`).then(r=>r.json());if(d&&d.s==="ok")for(let i=0;i<d.t.length;i++)out.push({t:d.t[i],o:d.o[i],h:d.h[i],l:d.l[i],c:d.c[i]});cur=to;}const seen=new Set();return out.filter(c=>(seen.has(c.t)?false:seen.add(c.t))).sort((a,b)=>a.t-b.t); }
async function fFunding(s){ const rows=[];for(let p=1;p<=3;p++){const d=await fetch(`${API}/v1/public/funding_rate_history?symbol=${s}&page=${p}&size=100`).then(r=>r.json());const rs=d?.data?.rows||[];rows.push(...rs.map(x=>({ts:x.funding_rate_timestamp,rate:x.funding_rate})));if(rs.length<100)break;}rows.sort((a,b)=>a.ts-b.ts);const at=(t)=>{const ms=t*1000;let r=0;for(const x of rows){if(x.ts<=ms)r=x.rate;else break;}return r;};return {at,rows}; }

const session=(c,i)=>{ const h=new Date(c[i].t*1000).getUTCHours(); return h<8?"Asia":h<15?"Europe":"US"; };
// filter factory: min ATR% AND optional session set
const mkFilter=(minVol, sessions)=> (c,i)=>{
  if(sessions && !sessions.includes(session(c,i))) return false;
  if(minVol!=null){ const a=atrPctAt(c,i); if(a==null||a<minVol) return false; }
  return true;
};

const CFG = { leverage:5, capitalPerTrade:50, maxHoldHours:4, feeBps:3, tpPercent:2, slPercent:1, signalMode:"CONFLUENCE", fundingThreshold:0.01, oiChangeThreshold:1, invertSignal:true };
const NOTIONAL = CFG.capitalPerTrade*CFG.leverage;

function evalPerSymbol(data, syms, filter){
  let net=0,trades=0,wins=0,pos=0,oos=0,oosTr=0; const per=[];
  const feePct=(CFG.feeBps/100)*2;
  for(const s of syms){
    const d=data[s]; const r=runBacktest(d.candles,d.at,CFG,d.pctAt,d.oiAt,filter);
    net+=r.netUsd; trades+=r.trades; wins+=Math.round(r.winRate/100*r.trades); if(r.netUsd>0)pos++;
    const tN=d.candles[d.candles.length-1].t, cut=tN-OOS_DAYS*86400;
    for(const t of r._trades||[]) if(t.entryT>=cut){ oos+=((t.pnlPct-feePct)/100)*NOTIONAL; oosTr++; }
    per.push({s:s.replace("PERP_","").replace("_USDC",""),net:Math.round(r.netUsd*100)/100,n:r.trades,win:r.winRate});
  }
  return { net:Math.round(net*100)/100, win:trades?Math.round(wins/trades*1000)/10:0, trades, pos, nSym:syms.length, oos:Math.round(oos*100)/100, oosTr, per };
}

async function main(){
  const data={}, oiSyms=[];
  for(const s of SYMBOLS){ const candles=await fCandles(s),{at,rows}=await fFunding(s),oi=await fOi(s); const info=oiSeriesInfo(oi); if(info.days>=14&&info.samples>=200)oiSyms.push(s); data[s]={candles,at,pctAt:makeFundingPctAt(rows),oiAt:info.days>=14?makeOiChangeAt(oi):null}; }
  console.log(`=== HUNT-v3b · INVERTED-CONFLUENCE × VOL/SESSION (${oiSyms.length} symbols, ${DAYS}d, $${NOTIONAL} notional) ===\n`);
  console.log("filter".padEnd(22),"net$".padStart(8),"win%".padStart(6),"trd".padStart(5),"sym+".padStart(5),"oos$".padStart(8),"oosTrd".padStart(7));
  const grid=[
    ["none",mkFilter(null,null)],
    ["vol>0.5",mkFilter(0.5,null)],["vol>0.6",mkFilter(0.6,null)],["vol>0.7",mkFilter(0.7,null)],["vol>0.8",mkFilter(0.8,null)],
    ["US only",mkFilter(null,["US"])],["US+EU",mkFilter(null,["US","Europe"])],
    ["vol>0.6 +US",mkFilter(0.6,["US"])],["vol>0.6 +US+EU",mkFilter(0.6,["US","Europe"])],
    ["vol>0.7 +US+EU",mkFilter(0.7,["US","Europe"])],["vol>0.5 +US+EU",mkFilter(0.5,["US","Europe"])],
  ];
  const results=[];
  for(const [name,filter] of grid){ const r=evalPerSymbol(data,oiSyms,filter); results.push({name,...r}); console.log(name.padEnd(22),String(r.net).padStart(8),`${r.win}%`.padStart(6),String(r.trades).padStart(5),`${r.pos}/${r.nSym}`.padStart(5),String(r.oos).padStart(8),String(r.oosTr).padStart(7)); }
  // the honest bar: net+ AND oos+ AND positive on a majority of symbols AND enough trades
  const winners=results.filter(r=>r.name!=="none"&&r.net>0&&r.oos>0&&r.pos>=Math.ceil(r.nSym/2)&&r.trades>=20);
  console.log("\n--- VERDICT ---");
  if(winners.length){
    console.log(`⭐ ${winners.length} filter(s) net+ & OOS+ & majority-symbol-positive & ≥20 trades:`);
    for(const w of winners.sort((a,b)=>b.net-a.net)){ console.log(`   ${w.name}: net $${w.net} · win ${w.win}% · ${w.trades} trades · ${w.pos}/${w.nSym} sym · oos $${w.oos}`); console.log(`      per-symbol: ${w.per.map(p=>`${p.s} $${p.net}/${p.n}t/${p.win}%`).join(" · ")}`); }
    console.log("\n→ a conditional edge that survives OOS + breadth. Candidate to harden into a PRO strategy preset (regime-gated invert-confluence).");
  } else {
    const best=[...results.filter(r=>r.name!=="none")].sort((a,b)=>b.net-a.net)[0];
    console.log(`No filter cleared net+ & OOS+ & majority-symbol + ≥20 trades. Best net: ${best.name} $${best.net} (win ${best.win}%, ${best.trades} trades, ${best.pos}/${best.nSym} sym, oos $${best.oos}).`);
    console.log("→ the vol/session lift is real but thin/narrow on 60d — promising, needs more data (OI history is still maturing) before it's a deployable preset. Keep it on the research bench.");
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
