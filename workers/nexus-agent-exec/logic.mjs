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
 * Normalize a position's take-profit ladder into ascending [{pct,sizePct}].
 * Falls back to a single 100%-size level from the legacy single tpPercent so
 * positions opened before multi-TP existed behave exactly as before.
 */
export function normTakeProfits(pos, config) {
  const tps = pos.takeProfits || config.takeProfits;
  if (Array.isArray(tps) && tps.length) {
    return tps
      .map((t) => ({ pct: Number(t.pct), sizePct: Number(t.sizePct) }))
      .filter((t) => t.pct > 0 && t.sizePct > 0)
      .sort((a, b) => a.pct - b.pct);
  }
  const tp = pos.tpPercent ?? config.tpPercent;
  return [{ pct: Number(tp), sizePct: 100 }];
}

/**
 * Generalized exit decision (supersedes exitReason for multi-TP + trailing).
 * Pure: takes the position, current price-move pnlPct, hold time, and config;
 * returns ONE action for this tick. The exec persists peak_pnl_pct/trail_stop/
 * tp_hits/remaining_qty between ticks.
 *
 *  { type:"FULL_CLOSE", reason:"SL"|"TIMEOUT"|"TRAIL"|"TP" }
 *  { type:"PARTIAL_TP", level, sizePct }   // scale out this fraction, keep running
 *  { type:"TRAIL_UPDATE", trailStop, peak } // ratchet the trailing stop (no exit)
 *  null                                      // hold
 *
 * Priority: hard stops (SL → TIMEOUT → trail hit) before profit-taking, so a
 * disaster exit always wins over a take-profit on the same tick.
 */
export function evaluateExit(pos, pnlPct, holdMs, config) {
  const sl = pos.slPercent ?? config.slPercent;
  const maxHoldMs = (config.maxHoldHours || 0) * 60 * 60 * 1000;

  // 1) Hard full-close conditions (act on remaining qty).
  if (sl > 0 && pnlPct <= -sl) return { type: "FULL_CLOSE", reason: "SL" };
  if (maxHoldMs > 0 && holdMs >= maxHoldMs) return { type: "FULL_CLOSE", reason: "TIMEOUT" };

  const tps = normTakeProfits(pos, config);

  // 2) Trailing stop — only once in profit past the activation threshold, so it
  // locks gains instead of noise-stopping early. peak ratchets up, never down.
  const trailPct = Number(config.trailingStopPct) || 0;
  if (trailPct > 0) {
    const activate = config.trailActivatePct ?? tps[0]?.pct ?? 0;
    const peak = Math.max(pos.peak_pnl_pct ?? -Infinity, pnlPct);
    if (peak >= activate) {
      const trailStop = peak - trailPct;
      if (pnlPct <= trailStop) return { type: "FULL_CLOSE", reason: "TRAIL" };
      if (peak > (pos.peak_pnl_pct ?? -Infinity)) return { type: "TRAIL_UPDATE", trailStop, peak };
    }
  }

  // 3) Take-profit ladder — first unfilled level whose target is reached. If it's
  // the last defined level (or filling it accounts for ~all size) → full close;
  // otherwise scale out this slice and keep the runner.
  const hits = pos.tp_hits || [];
  for (let i = 0; i < tps.length; i++) {
    if (hits.includes(i)) continue;
    if (pnlPct >= tps[i].pct) {
      const moreLevels = tps.some((_, j) => j > i && !hits.includes(j));
      const cumAfter = [...hits, i].reduce((s, j) => s + (tps[j]?.sizePct || 0), 0);
      if (!moreLevels || cumAfter >= 100) return { type: "FULL_CLOSE", reason: "TP" };
      return { type: "PARTIAL_TP", level: i, sizePct: tps[i].sizePct };
    }
  }

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

/**
 * Volatility-scaled TP/SL (opt-in via config.volScaledStops). FIXED-% stops are
 * the core leak: 0.75% noise-stops a high-vol symbol (SOL) but over-gives on a
 * calm one — so the same setting is wrong for every symbol. Scaling the stop to
 * each symbol's recent ATR makes risk proportional to how much it actually moves,
 * while PRESERVING the configured reward:risk ratio. atrPct = ATR as a % of price.
 * Falls back to the fixed config when atrPct is missing/invalid. Clamped to sane
 * bounds so a vol spike can't set an absurd stop.
 */
export function volScaledLevels(atrPct, config) {
  const baseSl = Number(config?.slPercent) || 0.75;
  const baseTp = Number(config?.tpPercent) || 1.5;
  const rr = baseSl > 0 ? baseTp / baseSl : 2;
  if (!Number.isFinite(atrPct) || atrPct <= 0) return { slPercent: baseSl, tpPercent: baseTp };
  const slMult = Number(config?.slAtrMult) > 0 ? Number(config.slAtrMult) : 1.0; // stop = slMult × ATR
  const MIN_SL = 0.3, MAX_SL = 3.0;
  const slPercent = Math.min(MAX_SL, Math.max(MIN_SL, atrPct * slMult));
  return {
    slPercent: Math.round(slPercent * 100) / 100,
    tpPercent: Math.round(slPercent * rr * 100) / 100,
  };
}
