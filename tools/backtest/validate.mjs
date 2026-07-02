// Walk-forward strategy VALIDATOR (the honest layer over the raw sweep).
// A single 60d in-sample net number is easy to overfit. This splits the window into
// sequential folds and checks each strategy per-symbol per-fold, so an "edge" only
// earns a ✅ if it holds up ACROSS TIME and ACROSS MARKETS — not just once.
//
// Reuses the REAL deployed engine (runBacktest → deriveSignal/evaluateExit), fetches
// live Orderly history, and auto-includes CONFLUENCE/OI_ONLY once recorded OI matures.
// Run: node tools/backtest/validate.mjs
import { runBacktest, makeFundingPctAt, makeOiChangeAt, oiSeriesInfo, foldsByEntry } from "../../workers/nexus-lab-api/backtest.mjs";

const ORDERLY = "https://api-evm.orderly.org";
const LAB_API = "https://og.nexustradinglabs.com";
// Wider universe than the 3-symbol sweep — funding-fade edge should be probed across
// more liquid perps to see where it actually holds vs. where it's BTC/ETH-only.
const SYMBOLS = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_BNB_USDC", "PERP_XRP_USDC", "PERP_DOGE_USDC", "PERP_AVAX_USDC", "PERP_LINK_USDC"];
const DAYS = 60;
const FOLDS = 4; // ~15d each over 60d

async function fetchCandles(symbol) {
  const now = Math.floor(Date.now() / 1000), from = now - DAYS * 86400;
  const out = []; let cursor = from; const step = 20 * 86400;
  while (cursor < now) {
    const to = Math.min(cursor + step, now);
    const r = await fetch(`${ORDERLY}/tv/history?symbol=${symbol}&resolution=60&from=${cursor}&to=${to}`);
    const d = await r.json();
    if (d && d.s === "ok" && Array.isArray(d.t)) for (let i = 0; i < d.t.length; i++) out.push({ t: d.t[i], o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i] });
    cursor = to;
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.t) ? false : seen.add(c.t))).sort((a, b) => a.t - b.t);
}
async function fetchFunding(symbol) {
  const rows = [];
  for (let page = 1; page <= 4; page++) {
    const r = await fetch(`${ORDERLY}/v1/public/funding_rate_history?symbol=${symbol}&page=${page}&size=100`);
    const d = await r.json();
    const rs = d?.data?.rows || [];
    rows.push(...rs.map((x) => ({ ts: x.funding_rate_timestamp, rate: x.funding_rate })));
    if (rs.length < 100) break;
  }
  rows.sort((a, b) => a.ts - b.ts);
  const at = (tsSec) => { const ms = tsSec * 1000; let rate = 0; for (const row of rows) { if (row.ts <= ms) rate = row.rate; else break; } return rate; };
  return { at, rows };
}
async function fetchOi(symbol) {
  try { const r = await fetch(`${LAB_API}/agent/oi-history/${symbol}`); const d = await r.json(); return Array.isArray(d?.points) ? d.points : []; }
  catch { return []; }
}

// The strategies under validation. BASE = shared risk/exec; each entry overrides the
// signal + exit levers. CONFLUENCE is included but only produces trades once OI matures.
const BASE = { leverage: 5, capitalPerTrade: 50, maxHoldHours: 4, oiChangeThreshold: 0, feeBps: 3, maxTradesPerDay: 99, maxDailyLossUsdc: 1e9 };
const STRATEGIES = [
  { name: "ProvenEdge (shipped: BE1.0)", cfg: { signalMode: "FUNDING_ONLY", fundingThreshold: 0.01, fundingPercentileMin: 95, tpPercent: 1.5, slPercent: 0.75, breakevenTriggerPct: 1.0 } },
  { name: "ProvenEdge (no breakeven)", cfg: { signalMode: "FUNDING_ONLY", fundingThreshold: 0.01, fundingPercentileMin: 95, tpPercent: 1.5, slPercent: 0.75 } },
  { name: "ProvenEdge + ATR stops", cfg: { signalMode: "FUNDING_ONLY", fundingThreshold: 0.01, fundingPercentileMin: 95, tpPercent: 1.5, slPercent: 0.75, breakevenTriggerPct: 1.0, volScaledStops: true, slAtrMult: 1.0 } },
  { name: "FUNDING pct90 (looser)", cfg: { signalMode: "FUNDING_ONLY", fundingThreshold: 0.01, fundingPercentileMin: 90, tpPercent: 1.5, slPercent: 0.75, breakevenTriggerPct: 1.0 } },
  { name: "CONFLUENCE f0.01 (OI-gated)", cfg: { signalMode: "CONFLUENCE", fundingThreshold: 0.01, tpPercent: 1.5, slPercent: 0.75, breakevenTriggerPct: 1.0 }, needsOi: true },
];

// Walk-forward bucketing lives in the engine (foldsByEntry) so this dev harness and
// the in-app /agent/validate endpoint compute the verdict identically — no drift.

async function main() {
  const data = {};
  for (const s of SYMBOLS) {
    const [candles, funding, oiRows] = await Promise.all([fetchCandles(s), fetchFunding(s), fetchOi(s)]);
    const info = oiSeriesInfo(oiRows);
    data[s] = { candles, fundingAt: funding.at, fundingPctAt: makeFundingPctAt(funding.rows), oiChangeAt: oiRows.length >= 2 ? makeOiChangeAt(oiRows) : null, oiInfo: info };
    process.stderr.write(`  ${s}: ${candles.length} candles, OI ${info.samples}s/${info.days}d\n`);
  }
  const oiMature = SYMBOLS.every((s) => data[s].oiInfo.days >= 14 && data[s].oiInfo.samples >= 200);
  console.log(`\nWALK-FORWARD VALIDATION · ${DAYS}d · ${FOLDS} folds · ${SYMBOLS.length} symbols · fees on`);
  console.log(oiMature ? "OI mature → CONFLUENCE validated." : "OI still maturing → CONFLUENCE skipped (auto-includes later).\n");

  for (const { name, cfg, needsOi } of STRATEGIES) {
    if (needsOi && !oiMature) { console.log(`\n── ${name} ──  ⏳ skipped (OI immature)`); continue; }
    const config = { ...BASE, ...cfg };
    console.log(`\n── ${name} ──`);
    let posSymbols = 0, totNet = 0, totTrades = 0, foldPosCount = 0, foldTotal = 0;
    const symRows = [];
    for (const s of SYMBOLS) {
      const oiAt = needsOi ? data[s].oiChangeAt : null;
      const res = runBacktest(data[s].candles, data[s].fundingAt, config, data[s].fundingPctAt, oiAt);
      const { net, cnt } = foldsByEntry(res, data[s].candles, config, FOLDS);
      const symNet = net.reduce((a, b) => a + b, 0);
      const symTrades = cnt.reduce((a, b) => a + b, 0);
      const foldsPos = net.filter((n) => n > 0).length;
      for (const n of net) { foldTotal++; if (n > 0) foldPosCount++; }
      if (symNet > 0) posSymbols++;
      totNet += symNet; totTrades += symTrades;
      symRows.push({ s, symNet, symTrades, foldsPos, net });
    }
    // Per-symbol matrix (fold net$), then a robustness verdict.
    console.log("  symbol      net$   trades  folds+   " + Array.from({ length: FOLDS }, (_, k) => `f${k + 1}`.padStart(8)).join(""));
    for (const { s, symNet, symTrades, foldsPos, net } of symRows) {
      const tk = s.replace("PERP_", "").replace("_USDC", "").padEnd(6);
      console.log(`  ${tk}  ${String(symNet.toFixed(1)).padStart(7)}  ${String(symTrades).padStart(6)}  ${String(foldsPos + "/" + FOLDS).padStart(6)}   ` + net.map((n) => String(n.toFixed(1)).padStart(8)).join(""));
    }
    const foldConsistency = Math.round((foldPosCount / foldTotal) * 100);
    const verdict = posSymbols >= Math.ceil(SYMBOLS.length / 2) && foldConsistency >= 55 ? "✅ ROBUST"
      : posSymbols >= 2 && foldConsistency >= 45 ? "🟨 FRAGILE (BTC/ETH-ish only)" : "❌ NOT ROBUST";
    console.log(`  → total net $${totNet.toFixed(1)} · ${totTrades} trades · net-positive on ${posSymbols}/${SYMBOLS.length} symbols · ${foldConsistency}% of folds positive → ${verdict}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
