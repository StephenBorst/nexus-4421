// Validate the INVERT lever: run each strategy config twice — as-is vs
// config.invertSignal:true (fade its own call) — over real Orderly history and
// print the net$/win%/PF for both plus the delta. The whole point of INVERT is to
// PROVE whether fading a systematically-wrong signal is +EV, not to assume it.
// Run: node tools/backtest/invert.mjs
import { runBacktest, makeFundingPctAt, makeOiChangeAt, oiSeriesInfo } from "../../workers/nexus-lab-api/backtest.mjs";

const API = "https://api-evm.orderly.org";
const LAB_API = "https://og.nexustradinglabs.com";
const SYMBOLS = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC"];
const DAYS = 60;

async function fetchOiHist(symbol) {
  try {
    const r = await fetch(`${LAB_API}/agent/oi-history/${symbol}`);
    const d = await r.json();
    return Array.isArray(d?.points) ? d.points : [];
  } catch { return []; }
}

async function fetchCandles(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - DAYS * 86400;
  const out = [];
  let cursor = from;
  const step = 20 * 86400;
  while (cursor < now) {
    const to = Math.min(cursor + step, now);
    const r = await fetch(`${API}/tv/history?symbol=${symbol}&resolution=60&from=${cursor}&to=${to}`);
    const d = await r.json();
    if (d && d.s === "ok" && Array.isArray(d.t)) {
      for (let i = 0; i < d.t.length; i++) out.push({ t: d.t[i], o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i] });
    }
    cursor = to;
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.t) ? false : seen.add(c.t))).sort((a, b) => a.t - b.t);
}

async function fetchFunding(symbol) {
  const rows = [];
  for (let page = 1; page <= 3; page++) {
    const r = await fetch(`${API}/v1/public/funding_rate_history?symbol=${symbol}&page=${page}&size=100`);
    const d = await r.json();
    const rs = d?.data?.rows || [];
    rows.push(...rs.map((x) => ({ ts: x.funding_rate_timestamp, rate: x.funding_rate })));
    if (rs.length < 100) break;
  }
  rows.sort((a, b) => a.ts - b.ts);
  const at = (tsSec) => {
    const ms = tsSec * 1000;
    let rate = 0;
    for (const row of rows) { if (row.ts <= ms) rate = row.rate; else break; }
    return rate;
  };
  return { at, rows };
}

// The families most likely to carry a directional anti-edge worth fading.
const EXITS = {
  "tp1.5/sl0.75": { tpPercent: 1.5, slPercent: 0.75 },
  "tp2/sl1": { tpPercent: 2, slPercent: 1 },
};
const BASE = { leverage: 5, capitalPerTrade: 50, maxHoldHours: 4, oiChangeThreshold: 0, feeBps: 3 };

function buildConfigs(oiReady) {
  const cfgs = [];
  for (const [exName, ex] of Object.entries(EXITS)) {
    for (const pct of [0.3, 0.5, 0.8]) {
      for (const mode of ["MOMENTUM", "MEAN_REVERSION"]) {
        cfgs.push({ name: `${mode} p${pct} ${exName}`, config: { ...BASE, ...ex, signalMode: mode, priceChangeThreshold: pct } });
      }
    }
    for (const f of [0.005, 0.01, 0.02]) {
      cfgs.push({ name: `FUNDING_ONLY f${f} ${exName}`, config: { ...BASE, ...ex, signalMode: "FUNDING_ONLY", fundingThreshold: f } });
    }
    for (const f of [0.005, 0.01]) {
      for (const pctMin of [90, 95]) {
        cfgs.push({ name: `FUNDING f${f} pct${pctMin} ${exName}`, config: { ...BASE, ...ex, signalMode: "FUNDING_ONLY", fundingThreshold: f, fundingPercentileMin: pctMin } });
      }
    }
    if (oiReady) {
      cfgs.push({ name: `CONFLUENCE f0.01 ${exName}`, config: { ...BASE, ...ex, signalMode: "CONFLUENCE", fundingThreshold: 0.01 } });
    }
  }
  return cfgs;
}

// Run one config across all symbols; return aggregate net/win/pf/trades.
function runAll(data, config) {
  let net = 0, trades = 0, wins = 0, pf = [];
  for (const s of SYMBOLS) {
    const r = runBacktest(data[s].candles, data[s].fundingAt, config, data[s].fundingPctAt, data[s].oiChangeAt);
    net += r.netUsd; trades += r.trades; wins += Math.round((r.winRate / 100) * r.trades);
    if (r.profitFactor) pf.push(r.profitFactor);
  }
  return {
    net: Math.round(net * 100) / 100,
    win: trades ? Math.round((wins / trades) * 1000) / 10 : 0,
    pf: pf.length ? Math.round((pf.reduce((a, b) => a + b, 0) / pf.length) * 100) / 100 : 0,
    trades,
  };
}

async function main() {
  const data = {};
  for (const s of SYMBOLS) {
    const candles = await fetchCandles(s);
    const { at, rows } = await fetchFunding(s);
    const oiRows = await fetchOiHist(s);
    const info = oiSeriesInfo(oiRows);
    data[s] = {
      candles, fundingAt: at, fundingPctAt: makeFundingPctAt(rows),
      oiChangeAt: oiRows.length >= 2 ? makeOiChangeAt(oiRows) : null, oiInfo: info,
    };
    console.error(`${s}: ${candles.length} candles, ${rows.length} funding rows, OI ${info.samples} samples / ${info.days}d`);
  }
  const oiReady = SYMBOLS.every((s) => data[s].oiInfo.days >= 14 && data[s].oiInfo.samples >= 200);
  console.error(oiReady ? "OI mature → CONFLUENCE included" : "OI still maturing → funding/price modes only");

  const rows = [];
  for (const { name, config } of buildConfigs(oiReady)) {
    const off = runAll(data, { ...config, invertSignal: false });
    const on = runAll(data, { ...config, invertSignal: true });
    rows.push({ name, off, on, delta: Math.round((on.net - off.net) * 100) / 100 });
  }

  // Rank by the INVERTED net — we want to know if fading produces a positive book.
  rows.sort((a, b) => b.on.net - a.on.net);

  const notional = BASE.capitalPerTrade * BASE.leverage;
  console.log(`\n=== INVERT VALIDATION (BTC+ETH+SOL, ${DAYS}d hourly, $${notional} notional/trade, fees on) ===`);
  console.log("Ranked by INVERTED net$. off = signal as-is · on = faded (invertSignal:true)\n");
  const h = ["off net$", "off win%", "on net$", "on win%", "Δnet$", "trades", "strategy"];
  console.log(h[0].padStart(9), h[1].padStart(8), h[2].padStart(9), h[3].padStart(8), h[4].padStart(9), h[5].padStart(7), " " + h[6]);
  for (const r of rows) {
    console.log(
      String(r.off.net).padStart(9), String(r.off.win).padStart(8),
      String(r.on.net).padStart(9), String(r.on.win).padStart(8),
      String(r.delta).padStart(9), String(r.off.trades).padStart(7), " " + r.name,
    );
  }

  // Verdict summary: does inverting help on aggregate, and how often?
  const helped = rows.filter((r) => r.delta > 0).length;
  const onPos = rows.filter((r) => r.on.net > 0).length;
  const offPos = rows.filter((r) => r.off.net > 0).length;
  const bestOn = rows[0];
  const bestOff = [...rows].sort((a, b) => b.off.net - a.off.net)[0];
  console.log("\n--- VERDICT ---");
  console.log(`configs: ${rows.length} · invert improved net in ${helped} (${Math.round((helped / rows.length) * 100)}%)`);
  console.log(`net-positive configs: as-is ${offPos} · inverted ${onPos}`);
  console.log(`best as-is: ${bestOff.name} = $${bestOff.off.net}`);
  console.log(`best inverted: ${bestOn.name} = $${bestOn.on.net} (was $${bestOn.off.net} as-is)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
