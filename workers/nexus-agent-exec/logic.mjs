// ═══════════════════════════════════════════════════════════
// Pure money-path logic for the agent executor.
// Extracted from index.js so it can be unit-tested in isolation — index.js
// imports these, so the tests cover the REAL deployed behavior, not a copy.
// Everything here is pure (no I/O, no env) and deterministic.
// ═══════════════════════════════════════════════════════════

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Snap order quantity to the exchange step size.
 * Formatting to the tick's decimal places avoids float artifacts
 * (e.g. 340 * 1e-5 = 0.0034000000000000007) that Orderly rejects with
 * -1104 "does not match the step size".
 * @returns {{ qty:number, ok:boolean, reason:string|null }}
 */
export function snapQty({ capitalPerTrade, leverage, markPrice, baseTick, baseMin, minNotional }) {
  const tick = baseTick || 0.001;
  const min = baseMin || tick;
  if (!(markPrice > 0)) return { qty: 0, ok: false, reason: "bad mark price" };
  const notional = capitalPerTrade * leverage;
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  const steps = Math.floor((notional / markPrice) / tick);
  const qty = parseFloat((steps * tick).toFixed(decimals));
  if (qty < min || qty <= 0) return { qty, ok: false, reason: `qty ${qty} below base_min ${min}` };
  if (minNotional && qty * markPrice < minNotional) {
    return { qty, ok: false, reason: `notional ${(qty * markPrice).toFixed(2)} below min ${minNotional}` };
  }
  return { qty, ok: true, reason: null };
}

/** Whether the daily counters should reset (>24h since last reset). */
export function shouldResetDaily(lastReset, now, dayMs = DAY_MS) {
  return now - (lastReset || 0) > dayMs;
}

/**
 * Whether daily risk caps block opening a new trade. Mirrors the live gate:
 * - trades_today >= maxTradesPerDay
 * - daily loss has reached the cap (only when net-negative)
 * @returns {{ blocked:boolean, reason:string|null }}
 */
export function dailyCapBlocked(state, config) {
  if ((state.trades_today || 0) >= config.maxTradesPerDay) {
    return { blocked: true, reason: "max trades reached" };
  }
  const pnl = state.daily_pnl || 0;
  if (Math.abs(pnl) >= config.maxDailyLossUsdc && pnl < 0) {
    return { blocked: true, reason: "max daily loss reached" };
  }
  return { blocked: false, reason: null };
}

/** Direction-aware realized P&L for a position. */
export function computePnl(direction, entryPrice, exitPrice, qty) {
  const pnlPct = direction === "LONG"
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  const pnlUsdc = (pnlPct / 100) * qty * entryPrice;
  return { pnlPct, pnlUsdc };
}

/**
 * Which exit a held position should take, in priority order TP → SL → timeout.
 * @returns {"TP"|"SL"|"TIMEOUT"|null}
 */
export function exitReason(pnlPct, holdMs, config) {
  if (pnlPct >= config.tpPercent) return "TP";
  if (pnlPct <= -config.slPercent) return "SL";
  if (holdMs >= config.maxHoldHours * 60 * 60 * 1000) return "TIMEOUT";
  return null;
}

/**
 * Derive thesis-style TP/SL price levels for an agent entry from its plan
 * percentages. tpPercent/slPercent are PRICE-move percents (exitReason compares
 * them directly to the price-move pnlPct from computePnl), so the levels are a
 * straight projection off the entry price. Used to publish agent trades to the
 * public feed in the same shape as human theses.
 * @returns {{ stopLoss:number, takeProfit1:number, riskReward:number }}
 */
export function agentThesisLevels({ entryPrice, direction, tpPercent, slPercent }) {
  const tpMove = entryPrice * (tpPercent / 100);
  const slMove = entryPrice * (slPercent / 100);
  const takeProfit1 = direction === "LONG" ? entryPrice + tpMove : entryPrice - tpMove;
  const stopLoss = direction === "LONG" ? entryPrice - slMove : entryPrice + slMove;
  const riskReward = slPercent > 0 ? tpPercent / slPercent : 0;
  return { stopLoss, takeProfit1, riskReward };
}

/**
 * Map an internal exit reason to a public feed thesis status.
 * TP→HIT_TP, SL→STOPPED_OUT, everything else (TIMEOUT/KILLED/manual)→CLOSED.
 */
export function agentCloseStatus(reason) {
  if (reason === "TP") return "HIT_TP";
  if (reason === "SL") return "STOPPED_OUT";
  return "CLOSED";
}
