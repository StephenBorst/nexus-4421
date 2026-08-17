// ── THE EDGE HUNT ────────────────────────────────────────────────────────────
// The honest search for a +EV agent config. Where run.mjs / invert.mjs rank by raw
// net (overfit-prone), this ranks by WALK-FORWARD ROBUSTNESS: a config only counts
// if it's net-positive across a MAJORITY of symbols AND a majority of time-folds,
// AND survives an out-of-sample holdout (the most recent window it never "saw").
// That's what separates a real edge from a single-window fluke.
//
// Uses the REAL deployed logic (deriveSignal + evaluateExit via runBacktest) and the
// engine's own foldsByEntry / robustnessVerdict helpers — no forked math, no engine
// change. CONFLUENCE + OI_ONLY are now testable (OI history matured ~mid-2026), so
// the flagship signal we could never validate is finally in the grid.
//
// Run: node tools/backtest/hunt.mjs
import { runBacktest, makeFundingPctAt, makeOiChangeAt, oiSeriesInfo, foldsByEntry, robustnessVerdict, aggregate } from "../../workers/nexus-lab-api/backtest.mjs";

const API = "https://api-evm.orderly.org";
const LAB_API = "https://og.nexustradinglabs.com";
// Cross-market breadth: majors with deep books. OI history exists only for the
// symbols the brain records (core + watchlists) — OI-dependent modes auto-restrict
// to the ones that are mature; funding/price modes run on all.
const SYMBOLS = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_HYPE_USDC", "PERP_XRP_USDC", "PERP_DOGE_USDC"];
const DAYS = 60;
const FOLDS = 6;
const OOS_DAYS = 20;          // the held-out most-recent window
const MIN_TRADES = 20;        // ignore configs too sparse to trust

async function fetchOiHist(symbol) {
  try {
    const d = await fetch(`${LAB_API}/agent/oi-history/${symbol}`).then((r) => r.json());
    return Array.isArray(d?.points) ? d.points : [];
  } catch { return []; }
}
async function fetchCandles(symbol) {
  const now = Math.floor(Date.now() / 1000), from = now - DAYS * 86400, out = [];
  let cursor = from; const step = 20 * 86400;
  while (cursor < now) {
    const to = Math.min(cursor + step, now);
    const d = await fetch(`${API}/tv/history?symbol=${symbol}&resolution=60&from=${cursor}&to=${to}`).then((r) => r.json());
    if (d && d.s === "ok" && Array.isArray(d.t)) for (let i = 0; i < d.t.length; i++) out.push({ t: d.t[i], o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i] });
    cursor = to;
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.t) ? false : seen.add(c.t))).sort((a, b) => a.t - b.t);
}
async function fetchFunding(symbol) {
  const rows = [];
  for (let page = 1; page <= 3; page++) {
    const d = await fetch(`${API}/v1/public/funding_rate_history?symbol=${symbol}&page=${page}&size=100`).then((r) => r.json());
    const rs = d?.data?.rows || [];
    rows.push(...rs.map((x) => ({ ts: x.funding_rate_timestamp, rate: x.funding_rate })));
    if (rs.length < 100) break;
  }
  rows.sort((a, b) => a.ts - b.ts);
  const at = (tsSec) => { const ms = tsSec * 1000; let rate = 0; for (const r of rows) { if (r.ts <= ms) rate = r.rate; else break; } return rate; };
  return { at, rows };
}

// Out-of-sample net: only the trades that opened in the most-recent OOS_DAYS. A fixed
// config isn't "fit" per se, but if it works in-sample and dies OOS it's a fluke.
function oosNet(res, config, tN) {
  const feePct = ((config.feeBps || 0) / 100) * 2;
  const notional = (config.capitalPerTrade || 50) * (config.leverage || 1);
  const cutoff = tN - OOS_DAYS * 86400;
  let net = 0, n = 0;
  for (const t of res._trades || []) if (t.entryT >= cutoff) { net += ((t.pnlPct - feePct) / 100) * notional; n++; }
  return { net: Math.round(net * 100) / 100, n };
}

const EXITS = {
  "tp1.5/sl0.75": { tpPercent: 1.5, slPercent: 0.75 },
  "tp2/sl1": { tpPercent: 2, slPercent: 1 },
  "tp3/sl1.5": { tpPercent: 3, slPercent: 1.5 },
  "scaleout 1@50/2.5@50": { tpPercent: 1, slPercent: 1, takeProfits: [{ pct: 1, sizePct: 50 }, { pct: 2.5, sizePct: 50 }] },
};
const BASE = { leverage: 5, capitalPerTrade: 50, maxHoldHours: 4, feeBps: 3 };

function buildConfigs() {
  const cfgs = [];
  const add = (name, needsOi, extra) => cfgs.push({ name, needsOi, config: { ...BASE, ...extra } });
  for (const [exName, ex] of Object.entries(EXITS)) {
    // FUNDING family — plain + adaptive percentile (the promising thread), ± invert.
    for (const f of [0.005, 0.01, 0.02]) {
      for (const inv of [false, true]) {
        add(`FUNDING f${f}${inv ? " ↺" : ""} ${exName}`, false, { ...ex, signalMode: "FUNDING_ONLY", fundingThreshold: f, oiChangeThreshold: 0, invertSignal: inv });
      }
    }
    for (const f of [0.005, 0.01]) for (const pctMin of [85, 90, 95]) for (const inv of [false, true]) {
      add(`FUNDING f${f} pct${pctMin}${inv ? " ↺" : ""} ${exName}`, false, { ...ex, signalMode: "FUNDING_ONLY", fundingThreshold: f, fundingPercentileMin: pctMin, oiChangeThreshold: 0, invertSignal: inv });
    }
    // ⭐ CONFLUENCE — newly testable (OI matured). ± percentile, ± invert.
    for (const oiT of [0, 0.5, 1]) for (const inv of [false, true]) {
      add(`CONFLUENCE f0.01 oi${oiT}${inv ? " ↺" : ""} ${exName}`, true, { ...ex, signalMode: "CONFLUENCE", fundingThreshold: 0.01, oiChangeThreshold: oiT, invertSignal: inv });
    }
    for (const pctMin of [90, 95]) add(`CONFLUENCE f0.01 pct${pctMin} ${exName}`, true, { ...ex, signalMode: "CONFLUENCE", fundingThreshold: 0.01, oiChangeThreshold: 0, fundingPercentileMin: pctMin });
    // OI_ONLY — newly testable. ± threshold, ± invert.
    for (const oiT of [0, 0.5, 1]) for (const inv of [false, true]) {
      add(`OI_ONLY oi${oiT}${inv ? " ↺" : ""} ${exName}`, true, { ...ex, signalMode: "OI_ONLY", oiChangeThreshold: oiT, invertSignal: inv });
    }
    // MOMENTUM / MEAN_REVERSION — the price-move families.
    for (const p of [0.3, 0.5, 0.8]) for (const mode of ["MOMENTUM", "MEAN_REVERSION"]) {
      add(`${mode} p${p} ${exName}`, false, { ...ex, signalMode: mode, priceChangeThreshold: p, oiChangeThreshold: 0 });
    }
  }
  return cfgs;
}

// Evaluate one config across the symbols it can trade → robustness + OOS.
function evalConfig(data, symbols, config) {
  let posSymbols = 0, foldPos = 0, foldTotal = 0, totNet = 0, totTrades = 0, oos = 0, oosTr = 0;
  for (const s of symbols) {
    const d = data[s];
    const res = runBacktest(d.candles, d.fundingAt, config, d.fundingPctAt, d.oiChangeAt);
    const { net, cnt } = foldsByEntry(res, d.candles, config, FOLDS);
    const symNet = net.reduce((a, b) => a + b, 0);
    if (symNet > 0) posSymbols++;
    for (const n of net) { foldTotal++; if (n > 0) foldPos++; }
    totNet += symNet; totTrades += cnt.reduce((a, b) => a + b, 0);
    const o = oosNet(res, config, d.tN); oos += o.net; oosTr += o.n;
  }
  const foldConsistency = foldTotal ? Math.round((foldPos / foldTotal) * 100) : 0;
  return {
    verdict: robustnessVerdict(posSymbols, symbols.length, foldConsistency),
    posSymbols, nSymbols: symbols.length, foldConsistency,
    net: Math.round(totNet * 100) / 100, trades: totTrades,
    oosNet: Math.round(oos * 100) / 100, oosTrades: oosTr,
  };
}

async function main() {
  const data = {};
  const oiSymbols = [];
  for (const s of SYMBOLS) {
    const candles = await fetchCandles(s);
    const { at, rows } = await fetchFunding(s);
    const oiRows = await fetchOiHist(s);
    const info = oiSeriesInfo(oiRows);
    const mature = info.days >= 14 && info.samples >= 200;
    if (mature) oiSymbols.push(s);
    data[s] = {
      candles, fundingAt: at, fundingPctAt: makeFundingPctAt(rows),
      oiChangeAt: mature ? makeOiChangeAt(oiRows) : null,
      tN: candles[candles.length - 1]?.t ?? Math.floor(Date.now() / 1000),
    };
    console.error(`${s}: ${candles.length} candles · ${rows.length} funding · OI ${info.samples}smp/${info.days}d ${mature ? "✓" : "✗"}`);
  }
  console.error(`OI-mature symbols (CONFLUENCE/OI_ONLY): ${oiSymbols.map((s) => s.replace("PERP_", "").replace("_USDC", "")).join(", ") || "none"}`);
  console.error(`Ranking by walk-forward robustness · ${FOLDS} folds · ${OOS_DAYS}d OOS holdout · min ${MIN_TRADES} trades\n`);

  const rows = [];
  for (const { name, needsOi, config } of buildConfigs()) {
    const syms = needsOi ? oiSymbols : SYMBOLS;
    if (!syms.length) continue;
    const r = evalConfig(data, syms, config);
    if (r.trades < MIN_TRADES) continue;
    rows.push({ name, ...r });
  }

  const order = { ROBUST: 0, FRAGILE: 1, NOT_ROBUST: 2 };
  rows.sort((a, b) => (order[a.verdict] - order[b.verdict]) || (b.oosNet - a.oosNet) || (b.net - a.net));

  console.log(`=== EDGE HUNT (${SYMBOLS.length} symbols, ${DAYS}d hourly, $${BASE.capitalPerTrade * BASE.leverage} notional, fees on) ===`);
  console.log("Ranked: verdict → OOS net → full net.  net = full-window · oos = last " + OOS_DAYS + "d (unseen)\n");
  console.log("verdict".padEnd(11), "sym+".padStart(5), "fold%".padStart(6), "net$".padStart(9), "oos$".padStart(9), "trd".padStart(5), " strategy");
  for (const r of rows.slice(0, 40)) {
    console.log(
      r.verdict.padEnd(11), `${r.posSymbols}/${r.nSymbols}`.padStart(5), `${r.foldConsistency}%`.padStart(6),
      String(r.net).padStart(9), String(r.oosNet).padStart(9), String(r.trades).padStart(5), " " + r.name,
    );
  }

  const robust = rows.filter((r) => r.verdict === "ROBUST");
  const robustOos = robust.filter((r) => r.oosNet > 0);
  const fragile = rows.filter((r) => r.verdict === "FRAGILE" && r.oosNet > 0);
  console.log("\n--- VERDICT ---");
  console.log(`configs evaluated (≥${MIN_TRADES} trades): ${rows.length}`);
  console.log(`ROBUST: ${robust.length}  ·  ROBUST & +OOS (the real bar): ${robustOos.length}`);
  console.log(`FRAGILE & +OOS (worth conditioning further): ${fragile.length}`);
  if (robustOos.length) {
    console.log("\n⭐ CANDIDATES that cleared robustness AND the OOS holdout:");
    for (const r of robustOos) console.log(`   ${r.name} → full $${r.net} · oos $${r.oosNet} · ${r.posSymbols}/${r.nSymbols} sym · ${r.foldConsistency}% folds`);
  } else {
    console.log("\nNo config cleared ROBUST + positive OOS. Least-bad leads above = the base to CONDITION (regime/vol/session) in hunt-v2.");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
