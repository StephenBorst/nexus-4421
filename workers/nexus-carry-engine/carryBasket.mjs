// ── nexus-carry-engine · PURE BASKET LOGIC ───────────────────────────────────
// The sector-neutral funding-carry construction validated in tools/backtest/relvalue4.mjs
// (RV-v4). This is the ONE engine — the research backtest and the paper/live executor
// both import these pure functions, so a proven backtest == deployed behavior (same
// discipline as deriveSignal/evaluateExit). No I/O, no keys, fully unit-tested.
//
// The finding (why the construction is what it is):
//   • Rank funding WITHIN each sector, long the most-negative name, short the most-positive.
//     Every sector is $-neutral → sector co-movement (the residual that swamped v2/v3) cancels.
//   • perSide=1 is the ONLY carry-dominant setting: at P1 the price residual collapses (85%
//     carry share, OOS+). P2/P3 dilute the funding and let dispersion back in (~30% carry).
//   • MAKER execution is mandatory: at 24h/taker the fees eat the carry to breakeven; at
//     maker it nets ~12%/yr, Sharpe ~0.9. TAKER is not deployable.

export const SECTORS = {
  L1: ["BTC","ETH","SOL","BNB","AVAX","NEAR","DOT","ADA","APT","SUI","SEI","TRX","TIA"],
  DEFI: ["AAVE","UNI","LINK","INJ","JUP","ENA","ONDO","PENDLE","CRV","CAKE","MORPHO","ETHFI"],
  MEME: ["DOGE","1000BONK","1000PEPE","1000SHIB","WIF","FARTCOIN","PENGU","PUMP","TRUMP","SPX"],
  AI: ["FET","TAO","WLD","VIRTUAL"],
  PAY: ["LTC","XRP","BCH","HBAR","ZEC","XMR"],
  L2: ["ARB","OP","POL","MNT","MERL"],
};

// Build the {ticker → sector} map. Accepts bare tickers ("BTC") or full symbols ("PERP_BTC_USDC").
export function sectorMap(sectors = SECTORS) {
  const m = {};
  for (const [sec, arr] of Object.entries(sectors)) for (const t of arr) m[t] = sec;
  return m;
}
export const bareTicker = (s) => String(s).replace("PERP_", "").replace("_USDC", "");

export const DEFAULT_CARRY_CONFIG = {
  capital: 1000,        // total book notional (sum of |leg notional|)
  perSide: 1,           // P — names per side per sector. 1 is the validated carry-dominant setting.
  rebalanceHours: 24,   // research optimum; slower drifts the book off the funding rank
  execution: "MAKER",   // MAKER (post-only) required — TAKER eats the carry
  minFundingSpread: 0,  // optional gate: skip a sector unless |short.funding − long.funding| ≥ this (per-8h)
};

// buildTargetBook(funding, sectors, config)
//   funding : { [ticker|symbol]: fundingRate8h }  (positive = longs pay shorts)
//   sectors : { [ticker]: sectorName }             (from sectorMap())
//   returns : { legs:[{symbol(bare), sector, side(+1 long/−1 short), funding, notional}],
//               notionalPerLeg, sectorsUsed, skipped, config }
export function buildTargetBook(funding, sectors, config = {}) {
  const cfg = { ...DEFAULT_CARRY_CONFIG, ...config };
  const P = Math.max(1, Math.floor(cfg.perSide) || 1);
  const bySector = {};
  for (const [rawSym, rawRate] of Object.entries(funding)) {
    const rate = Number(rawRate);
    if (rawRate == null || Number.isNaN(rate)) continue;
    const t = bareTicker(rawSym);
    const sec = sectors[t];
    if (!sec) continue;
    (bySector[sec] ||= []).push({ symbol: t, funding: rate, sector: sec });
  }
  const legs = [];
  const skipped = [];
  for (const [sec, names] of Object.entries(bySector)) {
    const p = Math.min(P, Math.floor(names.length / 2));
    if (p < 1) { skipped.push({ sector: sec, reason: "too_few_names", names: names.length }); continue; }
    names.sort((a, b) => a.funding - b.funding);
    const longs = names.slice(0, p);
    const shorts = names.slice(names.length - p);
    if (cfg.minFundingSpread > 0) {
      const spread = shorts[shorts.length - 1].funding - longs[0].funding;
      if (spread < cfg.minFundingSpread) { skipped.push({ sector: sec, reason: "spread_too_thin", spread }); continue; }
    }
    for (const l of longs) legs.push({ symbol: l.symbol, sector: sec, side: 1, funding: l.funding });
    for (const s of shorts) legs.push({ symbol: s.symbol, sector: sec, side: -1, funding: s.funding });
  }
  const notionalPerLeg = legs.length ? cfg.capital / legs.length : 0;
  for (const l of legs) l.notional = notionalPerLeg;
  return { legs, notionalPerLeg, sectorsUsed: [...new Set(legs.map((l) => l.sector))], skipped, config: cfg };
}

// diffBook(currentLegs, targetLegs) → rebalance orders.
//   OPEN  : flat → position ; CLOSE : position → flat ; FLIP : long↔short (close + reverse)
// currentLegs/targetLegs : [{symbol, side}]. Symbols normalized to bare tickers.
export function diffBook(currentLegs = [], targetLegs = []) {
  const cur = new Map(currentLegs.map((l) => [bareTicker(l.symbol), l.side]));
  const tgt = new Map(targetLegs.map((l) => [bareTicker(l.symbol), l.side]));
  const orders = [];
  for (const sym of new Set([...cur.keys(), ...tgt.keys()])) {
    const c = cur.get(sym) || 0, t = tgt.get(sym) || 0;
    if (c === t) continue;
    if (c !== 0 && t === 0) orders.push({ symbol: sym, action: "CLOSE", side: c });
    else if (c === 0 && t !== 0) orders.push({ symbol: sym, action: "OPEN", side: t });
    else orders.push({ symbol: sym, action: "FLIP", from: c, to: t });
  }
  return orders;
}

// legFundingPnl — funding a leg accrues over `hours`, sign-correct and matching relvalue4.
//   longs (side +1) PROFIT from NEGATIVE funding; shorts (side −1) profit from POSITIVE funding.
export function legFundingPnl(side, fundingRate8h, hours, notional) {
  const periods = hours / 8;
  return -side * Number(fundingRate8h) * periods * Number(notional);
}

// legPricePnl — mark-to-market price P&L for one leg (signed).
export function legPricePnl(side, entryPx, markPx, notional) {
  if (!(entryPx > 0)) return 0;
  return side * ((Number(markPx) - Number(entryPx)) / Number(entryPx)) * Number(notional);
}

// bookIsNeutral — sanity guard the executor runs before sending orders: the book must be
// dollar-neutral overall AND within each sector (that neutrality IS the strategy).
export function bookIsNeutral(legs, tol = 1e-6) {
  const net = {};
  let total = 0;
  for (const l of legs) {
    const n = l.side * (l.notional || 0);
    total += n;
    net[l.sector] = (net[l.sector] || 0) + n;
  }
  const cap = legs.reduce((a, l) => a + Math.abs(l.notional || 0), 0) || 1;
  const overall = Math.abs(total) / cap <= tol;
  const perSector = Object.values(net).every((v) => Math.abs(v) / cap <= tol);
  return { neutral: overall && perSector, overall: total, bySector: net };
}
