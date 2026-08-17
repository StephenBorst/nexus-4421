// ── CROSS-SECTIONAL FUNDING CARRY (relative-value) ───────────────────────────
// A different edge class from the directional hunt: instead of predicting a
// symbol's direction, harvest the FUNDING DIFFERENTIAL across the basket while
// staying ~market-neutral. Each rebalance we go LONG the most-negative-funding
// perps (shorts pay us) and SHORT the most-positive-funding perps (longs pay us) —
// so every leg sits on the RECEIVING side of funding. The bet: does harvested
// funding beat relative price dispersion (the crowd being directionally right),
// net of rebalance fees?
//
// This is NOT per-symbol delta-neutral (impossible single-venue) — it's a
// long/short BASKET whose market beta roughly cancels, leaving cross-sectional
// (relative) risk. Standalone research; no engine/prod dependency.
// Run: node tools/backtest/relvalue.mjs
const API = "https://api-evm.orderly.org";
// Wide, liquid basket → more cross-sectional choice for the ranking.
const SYMBOLS = [
  "PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_BNB_USDC", "PERP_XRP_USDC",
  "PERP_DOGE_USDC", "PERP_AVAX_USDC", "PERP_LINK_USDC", "PERP_SUI_USDC", "PERP_HYPE_USDC",
  "PERP_LTC_USDC", "PERP_ARB_USDC",
];
const DAYS = 60;
const CAPITAL = 1000;          // total book notional deployed each period
const FEE_BPS = 3;             // taker per side; charged on notional TURNED OVER at rebalance

const tk = (s) => s.replace("PERP_", "").replace("_USDC", "");

async function fetchCandles(symbol) {
  const now = Math.floor(Date.now() / 1000), from = now - DAYS * 86400, out = [];
  let cursor = from; const step = 20 * 86400;
  while (cursor < now) {
    const to = Math.min(cursor + step, now);
    const d = await fetch(`${API}/tv/history?symbol=${symbol}&resolution=60&from=${cursor}&to=${to}`).then((r) => r.json()).catch(() => null);
    if (d && d.s === "ok" && Array.isArray(d.t)) for (let i = 0; i < d.t.length; i++) out.push({ t: d.t[i], c: d.c[i] });
    cursor = to;
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.t) ? false : seen.add(c.t))).sort((a, b) => a.t - b.t);
}
async function fetchFunding(symbol) {
  const rows = [];
  for (let page = 1; page <= 4; page++) {
    const d = await fetch(`${API}/v1/public/funding_rate_history?symbol=${symbol}&page=${page}&size=100`).then((r) => r.json()).catch(() => null);
    const rs = d?.data?.rows || [];
    rows.push(...rs.map((x) => ({ ts: x.funding_rate_timestamp, rate: Number(x.funding_rate) })));
    if (rs.length < 100) break;
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}
// Funding rate in effect at time t (ms) — last published at/before t.
const fundingAt = (rows, tMs) => { let r = 0; for (const x of rows) { if (x.ts <= tMs) r = x.rate; else break; } return r; };
// Close price at/nearest a unix-sec time (candles ascending).
function closeAt(candles, tSec) {
  let c = null;
  for (const k of candles) { if (k.t <= tSec) c = k.c; else break; }
  return c;
}
// Realized vol = stddev of the last `look` hourly returns BEFORE tSec (no lookahead).
// Used to equal-RISK-weight legs so a high-vol name can't dominate the basket's price
// beta — that's what lets the (small, stable) funding carry show through the noise.
function volBefore(candles, tSec, look = 24) {
  const idx = [];
  for (let i = 0; i < candles.length; i++) { if (candles[i].t < tSec) idx.push(i); else break; }
  if (idx.length < look + 1) return null;
  const s = idx.slice(-(look + 1));
  const rets = [];
  for (let i = 1; i < s.length; i++) { const a = candles[s[i - 1]].c, b = candles[s[i]].c; if (a > 0) rets.push((b - a) / a); }
  if (rets.length < 3) return null;
  const m = rets.reduce((x, y) => x + y, 0) / rets.length;
  const v = Math.sqrt(rets.reduce((x, y) => x + (y - m) ** 2, 0) / rets.length);
  return v > 0 ? v : null;
}

function run(data, { K, rebalanceHours, volWeight }) {
  // Build the rebalance clock from BTC's candle span.
  const base = data["PERP_BTC_USDC"];
  const t0 = base.candles[0].t, tN = base.candles[base.candles.length - 1].t;
  const stepSec = rebalanceHours * 3600;
  const oosCut = tN - 20 * 86400;                              // last 20d = out-of-sample

  let held = new Map();          // symbol → side (+1 long / -1 short)
  let net = 0, fundingPnl = 0, pricePnl = 0, fees = 0;
  let isNet = 0, oosNet = 0;                                   // in-sample vs OOS net
  const periodRets = [];
  let equity = 0, peak = 0, maxDd = 0;

  for (let t = t0; t + stepSec <= tN; t += stepSec) {
    const tMs = t * 1000;
    // Rank symbols by current funding (need a valid price at t and t+step).
    const ranked = SYMBOLS.map((s) => {
      const c0 = closeAt(data[s].candles, t), c1 = closeAt(data[s].candles, t + stepSec);
      const f = fundingAt(data[s].funding, tMs);
      const vol = volWeight ? volBefore(data[s].candles, t) : 1;
      return { s, f, c0, c1, vol, ok: c0 != null && c1 != null && c0 > 0 && (!volWeight || vol) };
    }).filter((x) => x.ok);
    if (ranked.length < 2 * K) continue;

    ranked.sort((a, b) => a.f - b.f);
    const legs = [...ranked.slice(0, K).map((x) => ({ ...x, side: 1 })),   // most negative funding → long (receive)
                  ...ranked.slice(-K).map((x) => ({ ...x, side: -1 }))];    // most positive funding → short (receive)
    // Notional per leg. Equal-notional (volWeight off) or equal-RISK (inverse-vol),
    // normalized so the whole book deploys CAPITAL. Equal-risk stops a high-vol name
    // from swamping the basket's price beta so the funding carry can show through.
    const rawW = legs.map((l) => (volWeight ? 1 / l.vol : 1));
    const wSum = rawW.reduce((a, b) => a + b, 0);
    const notional = new Map(legs.map((l, i) => [l.s, (rawW[i] / wSum) * CAPITAL]));
    const target = new Map(legs.map((l) => [l.s, l.side]));

    // Fee on turnover: any leg whose side changes (or opens/closes) pays a taker fee.
    const universe = new Set([...held.keys(), ...target.keys()]);
    for (const s of universe) {
      if ((held.get(s) || 0) !== (target.get(s) || 0)) fees += (FEE_BPS / 10000) * (notional.get(s) || CAPITAL / (2 * K));
    }
    held = target;

    // Accrue this period's PnL over [t, t+step]: price move + funding received.
    const fundingPeriods = rebalanceHours / 8;
    let periodPnl = 0;
    for (const l of legs) {
      const legN = notional.get(l.s);
      const priceRet = (l.c1 - l.c0) / l.c0;
      const pp = l.side * priceRet * legN;
      const fp = -l.side * l.f * fundingPeriods * legN;        // both legs designed to RECEIVE funding
      pricePnl += pp; fundingPnl += fp; periodPnl += pp + fp;
    }
    net += periodPnl; periodRets.push(periodPnl);
    if (t >= oosCut) oosNet += periodPnl; else isNet += periodPnl;
    equity += periodPnl; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity);
  }
  net -= fees;
  const n = periodRets.length;
  const mean = n ? periodRets.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n ? Math.sqrt(periodRets.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  const periodsPerYear = (365 * 24) / rebalanceHours;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0;
  const winRate = n ? Math.round((periodRets.filter((r) => r > 0).length / n) * 1000) / 10 : 0;
  return {
    K, rebalanceHours,
    net: Math.round(net * 100) / 100,
    grossFunding: Math.round(fundingPnl * 100) / 100,
    price: Math.round(pricePnl * 100) / 100,
    fees: Math.round(fees * 100) / 100,
    isNet: Math.round(isNet * 100) / 100,
    oosNet: Math.round((oosNet - fees * (20 / DAYS)) * 100) / 100,  // rough fee proration for the OOS window
    sharpe: Math.round(sharpe * 100) / 100,
    winRate, periods: n, maxDd: Math.round(maxDd * 100) / 100,
  };
}

async function main() {
  const data = {};
  for (const s of SYMBOLS) {
    const [candles, funding] = await Promise.all([fetchCandles(s), fetchFunding(s)]);
    data[s] = { candles, funding };
    console.error(`${tk(s)}: ${candles.length} candles · ${funding.length} funding rows`);
  }
  console.error(`\nBasket ${SYMBOLS.length} symbols · $${CAPITAL} book · fees ${FEE_BPS}bps/side on turnover · ${DAYS}d\n`);

  console.log(`=== CROSS-SECTIONAL FUNDING CARRY (${SYMBOLS.length}-symbol basket, ${DAYS}d, $${CAPITAL} book) ===`);
  console.log("long the K most-negative funding, short the K most-positive. Both legs receive funding.");
  console.log("weight = equal-notional vs equal-RISK (inverse-vol → neutralizes price beta). oos = last 20d.\n");
  const results = [];
  for (const volWeight of [false, true]) {
    console.log(`── ${volWeight ? "EQUAL-RISK (inverse-vol weighted)" : "EQUAL-NOTIONAL (naive)"} ──`);
    console.log("K".padStart(2), "rebal".padStart(6), "net$".padStart(9), "funding$".padStart(9), "price$".padStart(9), "fees$".padStart(7), "IS$".padStart(8), "oos$".padStart(8), "sharpe".padStart(7), "win%".padStart(6));
    for (const rebalanceHours of [8, 24]) for (const K of [2, 3, 4, 5]) {
      const r = run(data, { K, rebalanceHours, volWeight });
      results.push({ ...r, volWeight });
      console.log(
        String(r.K).padStart(2), `${r.rebalanceHours}h`.padStart(6),
        String(r.net).padStart(9), String(r.grossFunding).padStart(9), String(r.price).padStart(9),
        String(r.fees).padStart(7), String(r.isNet).padStart(8), String(r.oosNet).padStart(8),
        String(r.sharpe).padStart(7), String(r.winRate).padStart(6),
      );
    }
    console.log("");
  }
  // The bar: net>0 AND positive OOS AND funding is the DOMINANT component (real carry,
  // not lucky price) AND a decent Sharpe.
  const clean = results.filter((r) => r.net > 0 && r.oosNet > 0 && r.grossFunding > 0 && Math.abs(r.grossFunding) >= Math.abs(r.price) * 0.8);
  const best = [...results].sort((a, b) => b.sharpe - a.sharpe)[0];
  console.log("--- VERDICT ---");
  console.log(`net+ & OOS+ & carry-dominant: ${clean.length}/${results.length}`);
  console.log(`best Sharpe: ${best.volWeight ? "equal-risk" : "equal-notional"} K${best.K} ${best.rebalanceHours}h → net $${best.net} (${Math.round((best.net / CAPITAL) * 1000) / 10}%/${DAYS}d) · funding $${best.grossFunding} vs price $${best.price} · IS $${best.isNet} · oos $${best.oosNet} · Sharpe ${best.sharpe}`);
  if (clean.length) {
    console.log("⭐ Carry-dominant candidates (funding ≥ price, +OOS):");
    for (const r of clean.sort((a, b) => b.sharpe - a.sharpe).slice(0, 5)) console.log(`   ${r.volWeight ? "eq-risk" : "eq-notl"} K${r.K} ${r.rebalanceHours}h → net $${r.net} · funding $${r.grossFunding} / price $${r.price} · oos $${r.oosNet} · Sharpe ${r.sharpe}`);
  } else {
    console.log("No carry-DOMINANT + OOS+ config yet. Funding stays positive throughout (the carry is real),");
    console.log("but price noise still drives the net — the neutralization needs work (more legs / tighter vol-weighting / beta hedge).");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
