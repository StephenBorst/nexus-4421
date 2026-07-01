// Fetch real Orderly history, sweep strategy configs, print a ranked table.
// Run: node tools/backtest/run.mjs
import { runBacktest } from "../../workers/nexus-lab-api/backtest.mjs";

const API = "https://api-evm.orderly.org";
const SYMBOLS = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC"];
const DAYS = 60;

async function fetchCandles(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - DAYS * 86400;
  // /tv/history caps the window; fetch in ~20-day chunks and concat.
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
  // de-dup + sort by t
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
  // return a lookup: most recent rate at/before tsSec
  return (tsSec) => {
    const ms = tsSec * 1000;
    let rate = 0;
    for (const row of rows) { if (row.ts <= ms) rate = row.rate; else break; }
    return rate;
  };
}

// ── Config sweep ────────────────────────────────────────────
const EXITS = {
  "tp1.5/sl0.75": { tpPercent: 1.5, slPercent: 0.75 },
  "tp2/sl1": { tpPercent: 2, slPercent: 1 },
  "scaleout 1@50/2.5@50": { tpPercent: 1, slPercent: 1, takeProfits: [{ pct: 1, sizePct: 50 }, { pct: 2.5, sizePct: 50 }] },
  "trail0.5 @tp1.5": { tpPercent: 1.5, slPercent: 0.75, trailingStopPct: 0.5 },
};
const BASE = { leverage: 5, capitalPerTrade: 50, maxHoldHours: 4, oiChangeThreshold: 0 };

function buildConfigs() {
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
  }
  return cfgs;
}

async function main() {
  const data = {};
  for (const s of SYMBOLS) {
    const candles = await fetchCandles(s);
    const fundingAt = await fetchFunding(s);
    data[s] = { candles, fundingAt };
    console.error(`${s}: ${candles.length} candles`);
  }

  const results = [];
  for (const { name, config } of buildConfigs()) {
    let net = 0, trades = 0, wins = 0, pf = [];
    for (const s of SYMBOLS) {
      const r = runBacktest(data[s].candles, data[s].fundingAt, config);
      net += r.netUsd; trades += r.trades; wins += Math.round(r.winRate / 100 * r.trades);
      if (r.profitFactor) pf.push(r.profitFactor);
    }
    results.push({
      name, trades,
      winRate: trades ? Math.round((wins / trades) * 1000) / 10 : 0,
      netUsd: Math.round(net * 100) / 100,
      pf: pf.length ? Math.round((pf.reduce((a, b) => a + b, 0) / pf.length) * 100) / 100 : 0,
    });
  }
  results.sort((a, b) => b.netUsd - a.netUsd);
  console.log("\n=== RANKED (aggregate over BTC+ETH+SOL, " + DAYS + "d hourly, $" + (BASE.capitalPerTrade * BASE.leverage) + " notional/trade) ===\n");
  console.log("net$".padStart(9), "win%".padStart(6), "PF".padStart(6), "trades".padStart(7), "  strategy");
  for (const r of results) {
    console.log(String(r.netUsd).padStart(9), String(r.winRate).padStart(6), String(r.pf).padStart(6), String(r.trades).padStart(7), "  " + r.name);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
