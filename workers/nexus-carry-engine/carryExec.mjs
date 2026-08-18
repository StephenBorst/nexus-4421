// ── nexus-carry-engine · LIVE MAKER ORDER PLANNING (pure) ─────────────────────
// Phase 3b core — the part that must be PROVABLY correct before any capital moves.
// Turns a rebalance diff (from diffBook) into concrete POST_ONLY (maker) order specs:
// correct side, maker-side price, and a quantity snapped to the exchange's step size
// that clears base_min + min_notional. NO signing, NO network, NO order placement here
// — those live behind an explicit CARRY_LIVE arming step. This module is unit-tested so
// the risky arithmetic (step snapping, min-notional) can't be wrong when it's wired up.
//
// Why POST_ONLY: the carry sleeve is only +EV on maker fees. A POST_ONLY limit order
// rests as a maker and is cancelled by the exchange if it would cross (take) — so we
// never accidentally pay taker and eat the edge. The live loop re-quotes unfilled legs.

// snapQty — step-size-safe quantity (mirrors the validated agent-exec snapQty).
// Floor to base_tick without float artifacts, floor-guard base_min, then CEIL up to
// clear min_notional (a floor-snap can dip the value under min_notional → Orderly -1104).
export function snapQty(rawQty, baseTick, baseMin, minNotional, price) {
  if (!(baseTick > 0) || !(rawQty > 0)) return 0;
  const decimals = Math.max(0, Math.round(-Math.log10(baseTick)));
  const round = (q) => parseFloat((q).toFixed(decimals));
  let q = round(Math.floor(rawQty / baseTick) * baseTick);
  if (baseMin > 0 && q < baseMin) q = round(Math.ceil(baseMin / baseTick) * baseTick);
  if (minNotional > 0 && price > 0 && q * price < minNotional) {
    q = round(Math.ceil(minNotional / price / baseTick) * baseTick);
  }
  return q;
}

// makerPrice — the resting price that keeps us a maker: BUY joins the bid, SELL joins
// the ask. (A BUY at the ask, or SELL at the bid, would cross → POST_ONLY cancels it.)
export function makerPrice(side, bestBid, bestAsk) {
  return side === "BUY" ? Number(bestBid) : Number(bestAsk);
}

// planOrders(rebalanceOrders, currentLegs, targetLegs, marketInfo)
//   rebalanceOrders : diffBook() output — [{symbol, action:OPEN|CLOSE|FLIP, side?, from?, to?}]
//   currentLegs     : the book being replaced (for CLOSE/FLIP notional)
//   targetLegs      : the new book (for OPEN/FLIP notional)
//   marketInfo      : { [ticker]: { baseTick, baseMin, minNotional, bestBid, bestAsk } }
// returns POST_ONLY specs: { symbol, side, qty, price, orderType:"POST_ONLY", reduceOnly, reason }
//   plus { symbol, skip } for any leg missing usable market data (never a blind order).
export function planOrders(rebalanceOrders, currentLegs, targetLegs, marketInfo) {
  const cur = new Map((currentLegs || []).map((l) => [l.symbol, l]));
  const tgt = new Map((targetLegs || []).map((l) => [l.symbol, l]));
  const out = [];
  for (const o of rebalanceOrders || []) {
    const info = marketInfo?.[o.symbol];
    if (!info || !(info.bestBid > 0) || !(info.bestAsk > 0)) { out.push({ symbol: o.symbol, skip: "no_market_data" }); continue; }
    const { baseTick, baseMin, minNotional, bestBid, bestAsk } = info;

    if (o.action === "CLOSE") {
      const held = cur.get(o.symbol);
      if (!held) { out.push({ symbol: o.symbol, skip: "no_current_leg" }); continue; }
      const side = held.side === 1 ? "SELL" : "BUY"; // exit a long by selling, a short by buying
      const price = makerPrice(side, bestBid, bestAsk);
      const qty = snapQty(held.notional / price, baseTick, baseMin, minNotional, price);
      if (qty > 0) out.push({ symbol: o.symbol, side, qty, price, orderType: "POST_ONLY", reduceOnly: true, reason: "CLOSE" });
      continue;
    }
    if (o.action === "OPEN") {
      const t = tgt.get(o.symbol);
      if (!t) { out.push({ symbol: o.symbol, skip: "no_target_leg" }); continue; }
      const side = t.side === 1 ? "BUY" : "SELL";
      const price = makerPrice(side, bestBid, bestAsk);
      const qty = snapQty(t.notional / price, baseTick, baseMin, minNotional, price);
      if (qty > 0) out.push({ symbol: o.symbol, side, qty, price, orderType: "POST_ONLY", reduceOnly: false, reason: "OPEN" });
      continue;
    }
    if (o.action === "FLIP") {
      const t = tgt.get(o.symbol);
      if (!t) { out.push({ symbol: o.symbol, skip: "no_target_leg" }); continue; }
      const side = o.to === 1 ? "BUY" : "SELL";
      const price = makerPrice(side, bestBid, bestAsk);
      // flip through zero in one order: close the old notional + open the new = ~2× leg notional
      const qty = snapQty((t.notional * 2) / price, baseTick, baseMin, minNotional, price);
      if (qty > 0) out.push({ symbol: o.symbol, side, qty, price, orderType: "POST_ONLY", reduceOnly: false, reason: "FLIP" });
      continue;
    }
  }
  return out;
}

// planIsBalanced — a safety assertion the live executor MUST run before sending: the net
// signed notional of the planned OPEN/FLIP legs (the new exposure) should be ~neutral.
// A non-neutral plan means a data glitch skewed the book — abort rather than send a
// directional bet. (CLOSE/reduce legs are excluded; they unwind, they don't add exposure.)
export function planIsBalanced(targetLegs, tol = 0.02) {
  const legs = targetLegs || [];
  if (!legs.length) return { balanced: true, net: 0 };
  const net = legs.reduce((a, l) => a + l.side * (l.notional || 0), 0);
  const gross = legs.reduce((a, l) => a + Math.abs(l.notional || 0), 0) || 1;
  return { balanced: Math.abs(net) / gross <= tol, net };
}
