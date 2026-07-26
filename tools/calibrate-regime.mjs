// Regime-classifier calibration harness.
//   node tools/calibrate-regime.mjs
//
// The thresholds in REGIME (workers/nexus-lab-api/logic.mjs) decide how often a
// market reads as trending vs chopping. Set them by feel and you get a dimension
// that answers the same way every time — which produces no comparison, so the
// regime verdict can never speak. (That is exactly what happened on the first cut:
// ER 0.35 labelled 27 of 28 BTC windows CHOP.)
//
// This measures the actual distribution over real hourly candles so the constants
// are defensible. Re-run it if you change REGIME, or periodically — market
// character drifts, and a classifier tuned to 2026 chop may not fit a 2027 trend.
//
// Targets: ~25-40% of windows trending, and every vol bucket populated enough to
// clear the 5-call minimum that regimeEdge requires before it will say anything.
import { classifyRegime } from "../workers/nexus-lab-api/logic.mjs";

const SYMBOLS = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_DOGE_USDC", "PERP_HYPE_USDC"];
const DAYS = 60;
const STRIDE = 6; // sample a window every 6h

const now = Math.floor(Date.now() / 1000);
const from = now - DAYS * 86400;

const data = {};
for (const s of SYMBOLS) {
  try {
    const r = await fetch(`https://api-evm.orderly.org/tv/history?symbol=${s}&resolution=60&from=${from}&to=${now}`);
    const d = await r.json();
    if (d?.s === "ok" && d.t?.length) data[s] = { t: d.t, h: d.h, l: d.l, c: d.c };
    else console.warn(`skip ${s}: ${d?.s}`);
  } catch (e) { console.warn(`skip ${s}: ${e.message}`); }
}
if (!Object.keys(data).length) { console.error("no history fetched"); process.exit(1); }

const sweep = (opts, pick) => {
  const counts = {}; const perSym = [];
  for (const [s, cd] of Object.entries(data)) {
    let n = 0, hit = 0;
    for (let i = opts.LOOKBACK ?? 48; i < cd.t.length; i += STRIDE) {
      const reg = classifyRegime(cd, cd.t[i], opts);
      if (!reg) continue;
      n++; if (pick(reg)) hit++;
      counts[reg.vol] = (counts[reg.vol] || 0) + 1;
    }
    perSym.push(`${s.replace("PERP_", "").replace("_USDC", "")}:${n ? Math.round((hit / n) * 100) : 0}%`);
  }
  const tot = Object.values(counts).reduce((a, b) => a + b, 0);
  return { perSym, counts, tot };
};

console.log(`${DAYS}d hourly, ${Object.keys(data).length} symbols\n`);
console.log("TREND share by efficiency-ratio threshold (target 25-40%)");
for (const LOOKBACK of [24, 48]) {
  for (const ER_TREND of [0.15, 0.2, 0.25, 0.3, 0.35]) {
    const { perSym } = sweep({ LOOKBACK, ER_TREND }, (r) => r.trend !== "CHOP");
    console.log(`  lookback=${LOOKBACK} er>=${ER_TREND}  ${perSym.join("  ")}`);
  }
}

console.log("\nVOL bucket split by threshold pair (want all three populated)");
for (const [VOL_CALM, VOL_HOT] of [[0.75, 1.5], [0.8, 1.35], [0.85, 1.25]]) {
  const { counts, tot } = sweep({ VOL_CALM, VOL_HOT }, () => false);
  const pct = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, `${Math.round((v / tot) * 100)}%`]));
  console.log(`  calm<=${VOL_CALM} hot>=${VOL_HOT}:`, pct);
}
