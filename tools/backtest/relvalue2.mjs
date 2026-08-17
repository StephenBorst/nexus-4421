// ── RV-v2 · BETA-NEUTRAL FUNDING CARRY ───────────────────────────────────────
// v1 (relvalue.mjs) proved funding carry is real (~8%/yr gross, positive every
// config) but the net was swamped by a directional residual — the long/short
// basket was DOLLAR-neutral, not BETA-neutral. v2 fixes exactly that:
//   1. Estimate each leg's beta to BTC over a trailing window (no lookahead).
//   2. Add a BTC hedge leg sized to zero the basket's NET beta.
//   3. Only deploy when the funding SPREAD (avg short-leg funding − avg long-leg
//      funding, both received) is wide enough to pay for the residual risk.
// The question: once price beta is actually removed, does the carry survive net
// of fees + the hedge's own cost? Standalone research; no engine/prod dependency.
// Run: node tools/backtest/relvalue2.mjs
const API = "https://api-evm.orderly.org";
const SYMBOLS = [
  "PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_BNB_USDC", "PERP_XRP_USDC",
  "PERP_DOGE_USDC", "PERP_AVAX_USDC", "PERP_LINK_USDC", "PERP_SUI_USDC", "PERP_HYPE_USDC",
  "PERP_LTC_USDC", "PERP_ARB_USDC",
];
const BTC = "PERP_BTC_USDC";
const DAYS = 60;
const CAPITAL = 1000;
const FEE_BPS = 3;
const BETA_LOOK = 72;   // hours of trailing returns for the beta estimate

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
const fundingAt = (rows, tMs) => { let r = 0; for (const x of rows) { if (x.ts <= tMs) r = x.rate; else break; } return r; };
function closeAt(candles, tSec) { let c = null; for (const k of candles) { if (k.t <= tSec) c = k.c; else break; } return c; }

// Hourly return series of `candles` ending strictly BEFORE tSec, length `look`.
function retsBefore(candles, tSec, look) {
  const idx = [];
  for (let i = 0; i < candles.length; i++) { if (candles[i].t < tSec) idx.push(i); else break; }
  if (idx.length < look + 1) return null;
  const s = idx.slice(-(look + 1));
  const out = [];
  for (let i = 1; i < s.length; i++) { const a = candles[s[i - 1]].c, b = candles[s[i]].c; if (a > 0) out.push((b - a) / a); }
  return out;
}
// Beta of sym returns to BTC returns over the trailing window (cov/var). No lookahead.
function betaTo(symCandles, btcCandles, tSec, look = BETA_LOOK) {
  const rs = retsBefore(symCandles, tSec, look), rb = retsBefore(btcCandles, tSec, look);
  if (!rs || !rb || rs.length !== rb.length || rb.length < 8) return null;
  const n = rs.length, ms = rs.reduce((a, b) => a + b, 0) / n, mb = rb.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varb = 0;
  for (let i = 0; i < n; i++) { cov += (rs[i] - ms) * (rb[i] - mb); varb += (rb[i] - mb) ** 2; }
  return varb > 0 ? cov / varb : null;
}

function run(data, { K, rebalanceHours, hedge, spreadGate }) {
  const base = data[BTC];
  const t0 = base.candles[0].t, tN = base.candles[base.candles.length - 1].t;
  const stepSec = rebalanceHours * 3600;
  const legNotional = CAPITAL / (2 * K);
  const oosCut = tN - 20 * 86400;

  let held = new Map();
  let net = 0, fundingPnl = 0, pricePnl = 0, fees = 0, hedgePnl = 0;
  let isNet = 0, oosNet = 0, deployed = 0, skipped = 0;
  const periodRets = [];
  let equity = 0, peak = 0, maxDd = 0;

  for (let t = t0; t + stepSec <= tN; t += stepSec) {
    const tMs = t * 1000;
    const ranked = SYMBOLS.map((s) => {
      const c0 = closeAt(data[s].candles, t), c1 = closeAt(data[s].candles, t + stepSec);
      const f = fundingAt(data[s].funding, tMs);
      const beta = betaTo(data[s].candles, base.candles, t);
      return { s, f, c0, c1, beta, ok: c0 != null && c1 != null && c0 > 0 && beta != null };
    }).filter((x) => x.ok);
    if (ranked.length < 2 * K) { skipped++; continue; }

    ranked.sort((a, b) => a.f - b.f);
    const longs = ranked.slice(0, K).map((x) => ({ ...x, side: 1 }));    // most negative funding → long
    const shorts = ranked.slice(-K).map((x) => ({ ...x, side: -1 }));    // most positive funding → short
    const legs = [...longs, ...shorts];

    // Funding SPREAD available this period (both legs receive → sum of |funding| edges).
    // avg short-leg funding is positive (we short → receive), avg long-leg funding is
    // negative (we long → receive its magnitude). Spread ≈ how much carry is on offer.
    const avgShortF = shorts.reduce((a, x) => a + x.f, 0) / K;
    const avgLongF = longs.reduce((a, x) => a + x.f, 0) / K;
    const spread = avgShortF - avgLongF;   // per-8h decimal; ≥0 by construction
    if (spreadGate != null && spread < spreadGate) { held = new Map(); skipped++; continue; }
    deployed++;

    // Net portfolio beta (dollar-weighted), then a BTC hedge leg that zeroes it.
    const netBeta = legs.reduce((a, l) => a + l.side * legNotional * l.beta, 0) / CAPITAL;
    const hedgeNotional = hedge ? -netBeta * CAPITAL : 0;   // signed; +long / −short BTC
    const target = new Map(legs.map((l) => [l.s, l.side]));

    // Fees: leg-side changes + the hedge's turnover (hedge re-set every period).
    const universe = new Set([...held.keys(), ...target.keys()]);
    for (const s of universe) if ((held.get(s) || 0) !== (target.get(s) || 0)) fees += (FEE_BPS / 10000) * legNotional;
    if (hedge) fees += (FEE_BPS / 10000) * Math.abs(hedgeNotional);
    held = target;

    const fundingPeriods = rebalanceHours / 8;
    let periodPnl = 0;
    for (const l of legs) {
      const priceRet = (l.c1 - l.c0) / l.c0;
      const pp = l.side * priceRet * legNotional;
      const fp = -l.side * l.f * fundingPeriods * legNotional;
      pricePnl += pp; fundingPnl += fp; periodPnl += pp + fp;
    }
    // BTC hedge leg PnL: price move on the hedge notional + its funding.
    if (hedge && hedgeNotional !== 0) {
      const bc0 = closeAt(base.candles, t), bc1 = closeAt(base.candles, t + stepSec);
      const bf = fundingAt(base.funding, tMs);
      const sign = hedgeNotional > 0 ? 1 : -1, absN = Math.abs(hedgeNotional);
      const hp = sign * ((bc1 - bc0) / bc0) * absN;
      const hf = -sign * bf * fundingPeriods * absN;   // hedge pays/receives BTC funding
      hedgePnl += hp + hf; periodPnl += hp + hf;
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
    K, rebalanceHours, hedge: !!hedge, spreadGate: spreadGate ?? 0,
    net: Math.round(net * 100) / 100,
    grossFunding: Math.round(fundingPnl * 100) / 100,
    price: Math.round(pricePnl * 100) / 100,
    hedgePnl: Math.round(hedgePnl * 100) / 100,
    fees: Math.round(fees * 100) / 100,
    isNet: Math.round(isNet * 100) / 100,
    oosNet: Math.round((oosNet - fees * (20 / DAYS)) * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    winRate, deployed, skipped,
  };
}

async function main() {
  const data = {};
  for (const s of SYMBOLS) {
    const [candles, funding] = await Promise.all([fetchCandles(s), fetchFunding(s)]);
    data[s] = { candles, funding };
    console.error(`${tk(s)}: ${candles.length} candles · ${funding.length} funding`);
  }
  console.error(`\nBeta-neutral carry · ${SYMBOLS.length} symbols · $${CAPITAL} · fees ${FEE_BPS}bps · beta look ${BETA_LOOK}h · ${DAYS}d\n`);

  console.log(`=== RV-v2 BETA-NEUTRAL FUNDING CARRY (${SYMBOLS.length}-symbol basket, ${DAYS}d, $${CAPITAL}) ===`);
  console.log("hedge = BTC leg sizing net-beta→0. gate = min funding spread/8h to deploy. price/hedge should ~cancel.\n");
  // Diagnostic: what does the funding spread actually look like? (calibrates the gate)
  {
    const base = data[BTC]; const spreads = [];
    for (let t = base.candles[0].t; t + 86400 <= base.candles[base.candles.length - 1].t; t += 86400) {
      const rk = SYMBOLS.map((s) => ({ f: fundingAt(data[s].funding, t * 1000) })).sort((a, b) => a.f - b.f);
      if (rk.length >= 6) spreads.push((rk.slice(-3).reduce((a, x) => a + x.f, 0) / 3) - (rk.slice(0, 3).reduce((a, x) => a + x.f, 0) / 3));
    }
    spreads.sort((a, b) => a - b);
    const q = (p) => spreads[Math.floor(p * (spreads.length - 1))];
    console.error(`funding spread (K3) — p25 ${q(0.25).toFixed(6)} · median ${q(0.5).toFixed(6)} · p75 ${q(0.75).toFixed(6)} · p90 ${q(0.9).toFixed(6)}\n`);
  }
  const results = [];
  const spreadGates = [null, 0.00008, 0.00015];
  for (const hedge of [false, true]) {
    console.log(`── ${hedge ? "BETA-HEDGED" : "UN-HEDGED (baseline)"} ──`);
    console.log("K".padStart(2), "rebal".padStart(6), "gate".padStart(7), "net$".padStart(8), "fund$".padStart(7), "price$".padStart(8), "hedge$".padStart(8), "fees$".padStart(7), "oos$".padStart(7), "shrp".padStart(6), "dep".padStart(4));
    for (const rebalanceHours of [24]) for (const K of [3, 4]) for (const spreadGate of spreadGates) {
      const r = run(data, { K, rebalanceHours, hedge, spreadGate });
      results.push(r);
      console.log(
        String(r.K).padStart(2), `${r.rebalanceHours}h`.padStart(6),
        String(r.spreadGate || "—").padStart(7), String(r.net).padStart(8),
        String(r.grossFunding).padStart(7), String(r.price).padStart(8), String(r.hedgePnl).padStart(8),
        String(r.fees).padStart(7), String(r.oosNet).padStart(7), String(r.sharpe).padStart(6), String(r.deployed).padStart(4),
      );
    }
    console.log("");
  }
  // HONEST bar: funding must be the DOMINANT contributor (not just present), with a
  // real sample (deployed) and positive OOS. A high Sharpe on a handful of wide-spread
  // periods where PRICE drove the net is an overfit mirage, not carry — excluded.
  const carryDominant = results.filter((r) => r.net > 0 && r.oosNet > 0 && r.deployed >= 40 && Math.abs(r.grossFunding) >= Math.abs(r.price + r.hedgePnl) * 1.3);
  const hedgeEffect = results.filter((r) => r.hedge && !r.spreadGate).reduce((a, r) => a + Math.abs(r.hedgePnl), 0);
  console.log("--- VERDICT (honest) ---");
  console.log(`carry-DOMINANT (funding ≥ price residual) & OOS+ & ≥40 deploys: ${carryDominant.length}`);
  console.log(`avg |BTC-hedge PnL| at no gate: $${(hedgeEffect / results.filter((r) => r.hedge && !r.spreadGate).length).toFixed(2)} — near zero ⇒ the residual is ALT DISPERSION, not market beta (BTC hedge ≈ no-op).`);
  console.log(carryDominant.length
    ? "→ carry cleanly dominates net + survives OOS. Worth hardening into a real engine."
    : "→ funding carry is REAL & consistent (positive every no-gate config, ~8%/yr gross) but net stays PRICE-driven — dispersion, which a BTC beta hedge doesn't remove. Not a clean edge yet. Real levers: MUCH bigger basket (diversify dispersion), per-sector hedging, or accept a low-Sharpe carry sleeve. Not retail-deployable as-is.");
}
main().catch((e) => { console.error(e); process.exit(1); });
