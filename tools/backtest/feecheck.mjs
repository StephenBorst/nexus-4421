// Fee decomposition: is the signal gross-positive and dying on execution cost, or
// worthless? Runs representative configs at feeBps 0 (gross) / 1 / 3 (taker) / and a
// maker-rebate case (−0.1bps ≈ Nexus crypto maker). If GROSS is positive, the edge is
// real and the problem is EXECUTION (post maker, not take) — a completely different
// einstein move than "find a better signal". Run: node tools/backtest/feecheck.mjs
import { runBacktest, makeFundingPctAt, makeOiChangeAt, oiSeriesInfo } from "../../workers/nexus-lab-api/backtest.mjs";

const API = "https://api-evm.orderly.org", LAB_API = "https://og.nexustradinglabs.com";
const SYMBOLS = ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_HYPE_USDC", "PERP_XRP_USDC"];
const DAYS = 60;

async function fCandles(s) {
  const now = Math.floor(Date.now() / 1000), from = now - DAYS * 86400, out = []; let cur = from;
  while (cur < now) { const to = Math.min(cur + 20 * 86400, now); const d = await fetch(`${API}/tv/history?symbol=${s}&resolution=60&from=${cur}&to=${to}`).then((r) => r.json()); if (d?.s === "ok") for (let i = 0; i < d.t.length; i++) out.push({ t: d.t[i], o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i] }); cur = to; }
  const seen = new Set(); return out.filter((c) => (seen.has(c.t) ? false : seen.add(c.t))).sort((a, b) => a.t - b.t);
}
async function fFunding(s) {
  const rows = []; for (let p = 1; p <= 3; p++) { const d = await fetch(`${API}/v1/public/funding_rate_history?symbol=${s}&page=${p}&size=100`).then((r) => r.json()); const rs = d?.data?.rows || []; rows.push(...rs.map((x) => ({ ts: x.funding_rate_timestamp, rate: x.funding_rate }))); if (rs.length < 100) break; }
  rows.sort((a, b) => a.ts - b.ts);
  return { at: (t) => { const ms = t * 1000; let r = 0; for (const x of rows) { if (x.ts <= ms) r = x.rate; else break; } return r; }, rows };
}
async function fOi(s) { try { const d = await fetch(`${LAB_API}/agent/oi-history/${s}`).then((r) => r.json()); return Array.isArray(d?.points) ? d.points : []; } catch { return []; } }

const BASE = { leverage: 5, capitalPerTrade: 50, maxHoldHours: 4 };
const CONFIGS = [
  ["FUNDING f0.01 tp1.5/sl0.75", { ...BASE, signalMode: "FUNDING_ONLY", fundingThreshold: 0.01, tpPercent: 1.5, slPercent: 0.75 }, false],
  ["FUNDING f0.01 pct95 tp2/sl1", { ...BASE, signalMode: "FUNDING_ONLY", fundingThreshold: 0.01, fundingPercentileMin: 95, tpPercent: 2, slPercent: 1 }, false],
  ["CONFLUENCE f0.01 oi1 tp2/sl1", { ...BASE, signalMode: "CONFLUENCE", fundingThreshold: 0.01, oiChangeThreshold: 1, tpPercent: 2, slPercent: 1 }, true],
  ["CONFLUENCE f0.01 oi1 ↺ tp2/sl1", { ...BASE, signalMode: "CONFLUENCE", fundingThreshold: 0.01, oiChangeThreshold: 1, invertSignal: true, tpPercent: 2, slPercent: 1 }, true],
  ["MEAN_REVERSION p0.5 tp2/sl1", { ...BASE, signalMode: "MEAN_REVERSION", priceChangeThreshold: 0.5, tpPercent: 2, slPercent: 1 }, false],
  ["MOMENTUM p0.8 tp1.5/sl0.75", { ...BASE, signalMode: "MOMENTUM", priceChangeThreshold: 0.8, tpPercent: 1.5, slPercent: 0.75 }, false],
];
// feeBps per SIDE. -0.1 ≈ Nexus crypto MAKER rebate (you get paid); 0 = gross; 1/3 = taker tiers.
const FEES = [["maker -0.1", -0.1], ["gross 0", 0], ["taker 1", 1], ["taker 3", 3]];

function netAt(data, syms, config, feeBps) {
  let net = 0, trades = 0;
  for (const s of syms) { const d = data[s]; const r = runBacktest(d.candles, d.at, { ...config, feeBps }, d.pctAt, d.oiAt); net += r.netUsd; trades += r.trades; }
  return { net: Math.round(net * 100) / 100, trades };
}

async function main() {
  const data = {}; const oiSyms = [];
  for (const s of SYMBOLS) {
    const candles = await fCandles(s), { at, rows } = await fFunding(s), oi = await fOi(s);
    const info = oiSeriesInfo(oi), mature = info.days >= 14 && info.samples >= 200; if (mature) oiSyms.push(s);
    data[s] = { candles, at, pctAt: makeFundingPctAt(rows), oiAt: mature ? makeOiChangeAt(oi) : null };
  }
  console.log(`\n=== FEE DECOMPOSITION (${SYMBOLS.length} symbols, ${DAYS}d, $${BASE.capitalPerTrade * BASE.leverage} notional) ===`);
  console.log("net$ at each per-side fee. If GROSS>0 but taker<0 → the edge is real, execution kills it.\n");
  console.log("strategy".padEnd(34), ...FEES.map(([n]) => n.padStart(11)), "trd".padStart(6));
  for (const [name, config, needsOi] of CONFIGS) {
    const syms = needsOi ? oiSyms : SYMBOLS; if (!syms.length) continue;
    const cells = FEES.map(([, bps]) => netAt(data, syms, config, bps));
    console.log(name.padEnd(34), ...cells.map((c) => String(c.net).padStart(11)), String(cells[0].trades).padStart(6));
  }
  console.log("\n(maker -0.1 assumes every entry+exit posts as maker — the ceiling; reality is a mix.)");
}
main().catch((e) => { console.error(e); process.exit(1); });
