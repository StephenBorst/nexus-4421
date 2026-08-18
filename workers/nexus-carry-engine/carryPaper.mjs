// ── nexus-carry-engine · PAPER EXECUTION STEPPER (pure) ───────────────────────
// Faithful simulation of running the sector-neutral carry basket so it accrues a
// forward, verifiable track record BEFORE a single real maker order (Phase 2 of the
// executor build). No I/O: the worker feeds it a live market snapshot + KV state and
// persists what it returns. The live maker executor (Phase 3) will drive the SAME
// buildTargetBook/diffBook, so the paper record and live behavior share one engine.
//
// Accounting per tick:
//   1. accrue funding on every held leg over the elapsed time (this is the edge)
//   2. if a rebalance is due (>= rebalanceHours since the last one, or the book is empty),
//      close/flip dropped legs (realize price PnL + maker fee), open new legs at mark
//   3. mark the held book to market; equity = capital + funding + realized-price
//      + unrealized-price − fees. Maker fee is a REBATE (negative bps) → tiny income.
import { buildTargetBook, diffBook, legFundingPnl, legPricePnl, sectorMap } from "./carryBasket.mjs";

export function freshState(config = {}) {
  return {
    book: { legs: [] },            // [{symbol,sector,side,notional,entryPx,entryTs}]
    lastRebalTs: 0,
    lastTickTs: 0,
    startedTs: 0,
    cumFunding: 0,
    cumRealizedPrice: 0,
    cumFees: 0,
    rebalances: 0,
    trades: 0,
    equityCurve: [],               // [{t, equity, funding, price}]
    config,
  };
}

const H = 3600000; // ms per hour

// stepPaper(state, snapshot, nowMs, config) → { state, tick }
//   snapshot : { funding:{ticker:rate8h}, mark:{ticker:price} }
//   returns a NEW state (input not mutated) + a tick summary for logging.
export function stepPaper(prev, snapshot, nowMs, config = {}) {
  const cfg = {
    capital: 1000, perSide: 1, rebalanceHours: 24, makerFeeBps: -0.1,
    minFundingSpread: 0, maxEquityCurve: 400,
    ...(prev.config || {}), ...config,
  };
  const s = structuredClone(prev);
  s.config = cfg;
  const funding = snapshot.funding || {};
  const mark = snapshot.mark || {};
  const markOf = (sym, fallback) => (Number(mark[sym]) > 0 ? Number(mark[sym]) : fallback);

  if (!s.startedTs) s.startedTs = nowMs;

  // 1) accrue funding on held legs over elapsed time (at each leg's current live rate)
  const dtHours = s.lastTickTs ? Math.max(0, (nowMs - s.lastTickTs) / H) : 0;
  let fundingAccrued = 0;
  if (dtHours > 0) {
    for (const l of s.book.legs) {
      const rate = funding[l.symbol] != null ? Number(funding[l.symbol]) : l.funding;
      fundingAccrued += legFundingPnl(l.side, rate, dtHours, l.notional);
    }
  }
  s.cumFunding += fundingAccrued;

  // 2) rebalance if due (or first run / empty book)
  const due = s.book.legs.length === 0 || !s.lastRebalTs || (nowMs - s.lastRebalTs) >= cfg.rebalanceHours * H;
  let orders = [];
  let rebalanced = false;
  const feeRate = cfg.makerFeeBps / 10000;
  if (due) {
    const target = buildTargetBook(funding, sectorMap(), cfg);
    orders = diffBook(s.book.legs, target.legs);
    if (orders.length) {
      const cur = new Map(s.book.legs.map((l) => [l.symbol, l]));
      // realize price PnL + fee on legs being closed or flipped
      for (const o of orders) {
        if (o.action === "CLOSE" || o.action === "FLIP") {
          const held = cur.get(o.symbol);
          if (held) {
            const m = markOf(o.symbol, held.entryPx);
            s.cumRealizedPrice += legPricePnl(held.side, held.entryPx, m, held.notional);
            s.cumFees += feeRate * held.notional; // exit fill
          }
        }
        if (o.action === "OPEN" || o.action === "FLIP") {
          const tl = target.legs.find((t) => t.symbol === o.symbol);
          if (tl) s.cumFees += feeRate * tl.notional; // entry fill
        }
      }
      // adopt the new book, stamping entry px/ts (carry forward entries for unchanged legs)
      s.book.legs = target.legs.map((t) => {
        const held = cur.get(t.symbol);
        const unchanged = held && held.side === t.side;
        return {
          symbol: t.symbol, sector: t.sector, side: t.side, notional: t.notional, funding: t.funding,
          entryPx: unchanged ? held.entryPx : markOf(t.symbol, 0),
          entryTs: unchanged ? held.entryTs : nowMs,
        };
      });
      s.trades += orders.length;
      s.rebalances += 1;
    }
    s.lastRebalTs = nowMs;
    rebalanced = true; // the rebalance cycle ran (orders may be empty if nothing changed)
  }

  // 3) mark to market
  let unrealizedPrice = 0;
  for (const l of s.book.legs) {
    const m = markOf(l.symbol, l.entryPx);
    unrealizedPrice += legPricePnl(l.side, l.entryPx, m, l.notional);
  }
  const equity = cfg.capital + s.cumFunding + s.cumRealizedPrice + unrealizedPrice - s.cumFees;

  s.lastTickTs = nowMs;
  s.equityCurve.push({ t: nowMs, equity: round2(equity), funding: round2(s.cumFunding), price: round2(s.cumRealizedPrice + unrealizedPrice) });
  if (s.equityCurve.length > cfg.maxEquityCurve) s.equityCurve = s.equityCurve.slice(-cfg.maxEquityCurve);

  return {
    state: s,
    tick: {
      nowMs, dtHours: round2(dtHours), rebalanced, orders,
      fundingAccrued: round2(fundingAccrued), unrealizedPrice: round2(unrealizedPrice),
      equity: round2(equity), legs: s.book.legs.length,
    },
  };
}

// summarize(state) → track-record stats for the status endpoint (pure, from equityCurve).
export function summarize(state) {
  const cap = state.config?.capital || 1000;
  const eq = state.equityCurve;
  const equity = eq.length ? eq[eq.length - 1].equity : cap;
  const netPnl = round2(equity - cap);
  // per-tick returns for a rough annualized Sharpe (paper cadence-agnostic display)
  const rets = [];
  for (let i = 1; i < eq.length; i++) rets.push((eq[i].equity - eq[i - 1].equity) / cap);
  const n = rets.length;
  const mean = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  const carry = state.cumFunding;
  const priceComp = (equity - cap) - carry + state.cumFees; // funding vs price attribution
  const carryShare = (Math.abs(carry) + Math.abs(priceComp)) > 0
    ? Math.round((Math.abs(carry) / (Math.abs(carry) + Math.abs(priceComp))) * 100) : 0;
  return {
    equity, netPnl,
    cumFunding: round2(carry), cumPrice: round2(priceComp), cumFees: round2(state.cumFees),
    carrySharePct: carryShare,
    rebalances: state.rebalances, trades: state.trades, legs: state.book.legs.length,
    sharpePerTick: round2(sd > 0 ? mean / sd : 0),
    startedTs: state.startedTs, lastTickTs: state.lastTickTs, points: eq.length,
  };
}

const round2 = (x) => Math.round(x * 100) / 100;
