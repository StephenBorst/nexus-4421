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

/**
 * Volatility-targeted position sizing (opt-in, "B"). Scale capital INVERSELY to
 * recent realized volatility so risk-per-trade stays roughly constant across
 * symbols and regimes — size up in calm tape, down in wild tape. This is the
 * mechanic our own backtests point to (R:R / sizing beats signal quality).
 * Off when volTargetPct<=0 or realized vol is absent → returns capital unchanged
 * (existing agents are byte-for-byte the same). Clamped so it never blows up size.
 * @param {number} capitalPerTrade  base margin per trade (USDC)
 * @param {number} realizedVolPct   recent realized volatility, in % (e.g. 2.4)
 * @param {number} volTargetPct     target volatility, in % (0/undefined = off)
 * @param {{minScale?:number,maxScale?:number}} [opts]
 * @returns {number} scaled capital (clamped, 2dp)
 */
export function volScaledCapital(capitalPerTrade, realizedVolPct, volTargetPct, opts = {}) {
  const minScale = opts.minScale ?? 0.4;
  const maxScale = opts.maxScale ?? 2;
  if (!(capitalPerTrade > 0)) return 0;
  if (!(volTargetPct > 0) || !(realizedVolPct > 0)) return capitalPerTrade; // off / no data
  const scale = Math.min(maxScale, Math.max(minScale, volTargetPct / realizedVolPct));
  return parseFloat((capitalPerTrade * scale).toFixed(2));
}

/**
 * Realized volatility (%) from a recent close series — stdev of pct returns,
 * annualization-free (period vol, matches the cadence of the samples). Returns
 * null if fewer than 3 points. Used to feed volScaledCapital.
 * @param {number[]} closes
 * @returns {number|null} realized vol in %
 */
export function realizedVolPct(closes) {
  if (!Array.isArray(closes) || closes.length < 3) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (a > 0 && b > 0) rets.push((b - a) / a);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * 100;
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
 * Whether the breakeven stop has latched. Once price has moved
 * breakevenTriggerPct in our favor it latches ON permanently (pos.be_armed is
 * persisted across ticks) — a pullback afterward does NOT un-arm it, which is
 * the whole point: the stop only ever ratchets toward less risk, never back.
 * bePct<=0 means the feature is off (always false).
 */
export function breakevenArmed(pos, pnlPct, breakevenTriggerPct) {
  const bePct = Number(breakevenTriggerPct) || 0;
  return bePct > 0 && (pos.be_armed === true || pnlPct >= bePct);
}

/**
 * Generalized exit decision (supersedes exitReason for multi-TP + trailing).
 * Pure: takes the position, current price-move pnlPct, hold time, and config;
 * returns ONE action for this tick. The exec persists peak_pnl_pct/trail_stop/
 * tp_hits/remaining_qty/be_armed between ticks (be_armed is set via
 * breakevenArmed() BEFORE calling this, so the check below just reads it).
 *
 *  { type:"FULL_CLOSE", reason:"SL"|"TIMEOUT"|"TRAIL"|"TP"|"BE" }
 *  { type:"PARTIAL_TP", level, sizePct }   // scale out this fraction, keep running
 *  { type:"TRAIL_UPDATE", trailStop, peak } // ratchet the trailing stop (no exit)
 *  null                                      // hold
 *
 * Priority: breakeven stop → hard stops (SL → TIMEOUT) → trailing → profit-taking.
 * Breakeven is checked first because once armed it's a TIGHTER stop than the
 * original SL by definition (it only arms after enough favorable move) — so it
 * should fire before a wider SL ever could, on a fast reversal.
 */
export function evaluateExit(pos, pnlPct, holdMs, config) {
  const sl = pos.slPercent ?? config.slPercent;
  const maxHoldMs = (config.maxHoldHours || 0) * 60 * 60 * 1000;

  // 0) Breakeven / "risk-free trade" stop — once armed, ratchets the stop up to
  // entry + breakevenBufferPct (default 0 = exact entry price; set slightly
  // positive to also clear round-trip fees) so the position can no longer close
  // at a real loss.
  if (pos.be_armed) {
    const beStop = Number(config.breakevenBufferPct) || 0;
    if (pnlPct <= beStop) return { type: "FULL_CLOSE", reason: "BE" };
  }

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

// ── DCA / safety orders (PRO mode) ───────────────────────────────────────────
// Averages INTO a position on adverse moves, recomputing TP off the blended avg.
// The whole ladder (base + N safety orders) fits inside capitalPerTrade — base
// margin = capitalPerTrade / Σ vs^i (i=0..N), safety order k margin = base·vs^k —
// so it reuses the existing balance guardrail (no extra pre-check / -1101 risk).
// Pure + tested; the exec handles ordering/snapping/persistence.

/** Base-order margin so base + all safety orders sum to capitalPerTrade. */
export function dcaUnitMargin(capitalPerTrade, dca) {
  const n = Math.max(0, Math.floor(Number(dca?.maxSafetyOrders) || 0));
  const vs = Number(dca?.safetyOrderVolumeScale) || 1;
  let U = 0;
  for (let i = 0; i <= n; i++) U += Math.pow(vs, i);
  return U > 0 ? capitalPerTrade / U : capitalPerTrade;
}

/**
 * Should the next safety order fire? Triggers at a cumulative deviation from the
 * BASE entry (each step widened by safetyOrderStepScale), against the position.
 * @returns {{ shouldAdd:boolean, soMargin?:number, trigger?:number, level?:number }}
 */
export function nextSafetyOrder(pos, price, capitalPerTrade, dca) {
  const filled = pos.filled_safety_orders || 0;
  const maxSO = Math.floor(Number(dca?.maxSafetyOrders) || 0);
  const step = Number(dca?.safetyOrderStepPct) || 0;
  if (filled >= maxSO || !(step > 0) || !(price > 0)) return { shouldAdd: false };
  const stepScale = Number(dca.safetyOrderStepScale) || 1;
  const vs = Number(dca.safetyOrderVolumeScale) || 1;
  const k = filled + 1; // the safety order under consideration (1-based)
  let cumDev = 0;
  for (let i = 0; i < k; i++) cumDev += step * Math.pow(stepScale, i);
  const base = pos.base_entry_price ?? pos.entry_price;
  const trigger = pos.direction === "LONG" ? base * (1 - cumDev / 100) : base * (1 + cumDev / 100);
  const hit = pos.direction === "LONG" ? price <= trigger : price >= trigger;
  const soMargin = dcaUnitMargin(capitalPerTrade, dca) * Math.pow(vs, k);
  return { shouldAdd: hit, soMargin, trigger, level: k };
}

/** Blend a fill into the running average. */
export function blendAvg(qty0, avg0, qty1, price1) {
  const newQty = qty0 + qty1;
  if (!(newQty > 0)) return { newQty: 0, newAvg: avg0 };
  return { newQty, newAvg: (qty0 * avg0 + qty1 * price1) / newQty };
}

/** Take-profit price a given % off the (blended) average entry. */
export function dcaTakeProfitPrice(avg, tpPct, direction) {
  const move = avg * ((Number(tpPct) || 0) / 100);
  return direction === "LONG" ? avg + move : avg - move;
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

// ─── Directional directives ("trade my exact thesis") ────────────────────────
// A directive is a user-authored, direction-EXPLICIT, one-shot managed order (see
// docs/directional-agent-spec.md). Unlike the signal bot, the direction is honored
// verbatim — the user supplies the edge; the agent supplies the execution rigor.
// These three pure functions are the decision points the exec's directive block +
// enterPosition override will call. Kept here so tests cover the real behavior.

/** An ARMED directive past its validUntil should never fill (no stale entries). */
export function directiveExpired(directive, now) {
  return !!directive?.validUntil && now > Number(directive.validUntil);
}

/**
 * Should an ARMED directive fill at the current mark?
 *  - MARKET: fills immediately (next tick).
 *  - LIMIT: fills only when the mark is inside a sane band around the planned entry.
 *    LONG fills at/just-above entry (tolerance) but NOT if price gapped too far below
 *    (maxChase — a crash through the level may mean the thesis is invalidated); SHORT
 *    mirrors. maxChasePct ≤ 0 / unset = no chase bound (any favorable price fills).
 */
export function directiveShouldFill(directive, markPrice) {
  if (!(markPrice > 0)) return false;
  if ((directive?.entryType || "MARKET") === "MARKET") return true;
  const entry = Number(directive.entryPrice);
  if (!(entry > 0)) return false;
  const tol = (Number(directive.entryTolerancePct) || 0) / 100;
  const chase = Number(directive.maxChasePct) > 0 ? Number(directive.maxChasePct) / 100 : Infinity;
  if (directive.direction === "LONG") {
    const upper = entry * (1 + tol);
    const lower = Number.isFinite(chase) ? entry * (1 - chase) : 0;
    return markPrice <= upper && markPrice >= lower;
  }
  if (directive.direction === "SHORT") {
    const lower = entry * (1 - tol);
    const upper = Number.isFinite(chase) ? entry * (1 + chase) : Infinity;
    return markPrice >= lower && markPrice <= upper;
  }
  return false;
}

/**
 * Convert a directive's ABSOLUTE price levels into the agent's %-based TP/SL + TP
 * ladder, measured off the ACTUAL fill price (a market fill can differ from plan).
 * Guards direction-side sanity: LONG needs sl < entry < tp1; SHORT needs tp1 < entry
 * < sl. Returns { error } on a self-contradicting directive so the exec refuses it
 * rather than entering a nonsensical trade. tp2 (if on the correct side) adds a
 * runner leg; tp1SizePct scales out at TP1 (fractions of original sum to 100).
 * @returns {{ tpPercent:number, slPercent:number, takeProfits:{pct:number,sizePct:number}[] } | { error:string }}
 */
export function directiveLevels(directive, fillPrice) {
  const entry = Number(fillPrice);
  const sl = Number(directive?.stopLoss);
  const tp1 = Number(directive?.takeProfit1);
  const tp2 = Number(directive?.takeProfit2);
  const dir = directive?.direction;
  if (!(entry > 0) || !(sl > 0) || !(tp1 > 0)) return { error: "missing entry/stop/tp1" };
  if (dir === "LONG" && !(sl < entry && tp1 > entry)) return { error: "levels inverted for LONG" };
  if (dir === "SHORT" && !(sl > entry && tp1 < entry)) return { error: "levels inverted for SHORT" };
  if (dir !== "LONG" && dir !== "SHORT") return { error: "bad direction" };
  const pct = (a, b) => Math.round((Math.abs(a - b) / b) * 10000) / 100;
  const slPercent = pct(sl, entry);
  const tp1Percent = pct(tp1, entry);
  let takeProfits;
  const tp2OnSide = tp2 > 0 && ((dir === "LONG" && tp2 > tp1) || (dir === "SHORT" && tp2 < tp1));
  if (tp2OnSide) {
    const size1 = Math.min(99, Math.max(1, Number(directive.tp1SizePct) || 50));
    takeProfits = [{ pct: tp1Percent, sizePct: size1 }, { pct: pct(tp2, entry), sizePct: 100 - size1 }];
  } else {
    takeProfits = [{ pct: tp1Percent, sizePct: 100 }];
  }
  return { tpPercent: tp1Percent, slPercent, takeProfits };
}

// ── AUTOCOPY — trustless copy-trading ────────────────────────────────────────
// A follower opts into mirroring one or more LEADERS by adding their wallets to
// config.autocopy.leaders (written through the normal owner-authed config path —
// no new money-path). When the follower is FLAT, the exec adopts a followed
// leader's currently-OPEN position as its own entry signal: the copy supplies only
// SYMBOL + DIRECTION, so it flows through the exact same enterPosition path and
// inherits the FOLLOWER's mode (PAPER simulates / AUTONOMOUS trades), sizing
// (capitalPerTrade), TP/SL, cooldown-exempt priority, and every guardrail (daily-
// loss cap, max trades/day, kill switch). This is why copy-trading here is
// trustless AND safe: the leader's record is graded from public price, and the
// follower's own risk model governs execution.
export const AUTOCOPY_MAX_LEADERS = 20;
export const AUTOCOPY_CALL_FRESH_MS = 15 * 60 * 1000; // only mirror a call published in the last 15 min

// A followed LEADER is either an AGENT (mirror its real open position) or a human
// CALLER (mirror its newest public call). leaders = [{ wallet, position, latestCall }]
//   • position   = leader's agent current_position (or null when flat)
//   • latestCall = { symbol(PERP_), direction, id, stampedAt } — the caller's freshest
//                  public call (lab-api stamps it on publish; self-expiring)
// alreadyCopiedKey = follower state.last_copy_key (dedupe). Returns { symbol, direction,
// leader, key, kind } for the first followed leader with a NEW thing to copy, or null.
// Paper positions are skipped (copy REAL graded trades); stale calls are skipped.
export function selectCopySignal(config, leaders, alreadyCopiedKey, now = Date.now()) {
  const ac = config?.autocopy;
  if (!ac || !ac.enabled || !Array.isArray(ac.leaders) || !ac.leaders.length) return null;
  const follow = new Set(ac.leaders.map((a) => String(a).toLowerCase()));
  for (const entry of leaders || []) {
    const wallet = String(entry?.wallet || "").toLowerCase();
    if (!follow.has(wallet)) continue;

    // 1) AGENT leader — mirror a real, currently-open position.
    const p = entry?.position;
    if (p && !p.paper && p.symbol && (p.direction === "LONG" || p.direction === "SHORT")) {
      const key = `${wallet}:${p.symbol}:${p.opened_at || p.entry_price || ""}`;
      if (!alreadyCopiedKey || key !== alreadyCopiedKey) {
        return { symbol: p.symbol, direction: p.direction, leader: wallet, key, kind: "agent" };
      }
    }

    // 2) HUMAN CALLER — mirror a FRESH public call (freshness gate stops a first-time
    //    follow from back-entering a stale call).
    const c = entry?.latestCall;
    if (c && c.symbol && (c.direction === "LONG" || c.direction === "SHORT") &&
        Number.isFinite(c.stampedAt) && (now - c.stampedAt) <= AUTOCOPY_CALL_FRESH_MS) {
      const key = `${wallet}:call:${c.id || c.stampedAt}`;
      if (!alreadyCopiedKey || key !== alreadyCopiedKey) {
        return { symbol: c.symbol, direction: c.direction, leader: wallet, key, kind: "call" };
      }
    }
  }
  return null;
}

// ── TWAP slicing (our own, on-infra) ─────────────────────────────────────────
// Build vs. buy: the marketplace twap-plugin routes order flow through a THIRD-PARTY
// hosted backend holding a 30-day delegated key. We already own scheduled Orderly
// order placement + snapQty + signing, so we build TWAP natively — same order-only
// key, our infra, "verify don't trust". This is the PURE planner: it splits a total
// order into N time-sliced child orders, each snapped to base_tick and each
// individually clearing base_min / min_notional (an undersized slice is exactly what
// Orderly rejects with -1104 / "order value should be ≥ min"). The exec worker fires
// each slice at its offset via the same signing path as a normal market order.
export const TWAP = {
  minSlices: 2,
  maxSlices: 50,
  minSliceNotionalFloor: 10, // absolute floor; effective floor = max(this, minNotional)
};

export function twapSchedule({ totalNotional, durationMin, slices, side, markPrice, baseTick, baseMin, minNotional }, cfg = TWAP) {
  if (!(markPrice > 0)) return { ok: false, reason: "bad mark price", slices: [] };
  if (!(totalNotional > 0)) return { ok: false, reason: "totalNotional must be > 0", slices: [] };
  const dur = Math.max(1, Number(durationMin) || 0);
  const wantSlices = Math.min(cfg.maxSlices, Math.max(cfg.minSlices, Math.round(Number(slices) || cfg.minSlices)));
  const minSliceNotional = Math.max(cfg.minSliceNotionalFloor, minNotional || 0);
  // Each slice must clear the min slice notional, else Orderly rejects it. Cap the
  // slice count so we never emit an undersized child; below one valid slice = not doable.
  const maxByNotional = Math.floor(totalNotional / minSliceNotional);
  if (maxByNotional < 1) return { ok: false, reason: `total ${totalNotional} below one min slice (${minSliceNotional})`, slices: [] };
  const n = Math.max(1, Math.min(wantSlices, maxByNotional));
  const sliceNotional = totalNotional / n;
  const tick = baseTick || 0.001;
  const min = baseMin || tick;
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  const intervalMs = Math.round((dur * 60 * 1000) / n);
  const totalQtyTarget = totalNotional / markPrice;
  const out = [];
  let placedQty = 0;
  let firstErr = null;
  for (let i = 0; i < n; i++) {
    // Last slice absorbs the accumulated rounding remainder so Σ slices ≈ total.
    const rawQty = i === n - 1 ? (totalQtyTarget - placedQty) : (sliceNotional / markPrice);
    let steps = Math.floor(rawQty / tick);
    let qty = parseFloat((steps * tick).toFixed(decimals));
    // Ceil up one step if snapping dipped the slice under min_notional (same guard as /trade).
    if (minNotional && qty * markPrice < minNotional) { steps += 1; qty = parseFloat((steps * tick).toFixed(decimals)); }
    if (qty < min || qty <= 0) { firstErr = firstErr || `slice ${i} qty ${qty} < base_min ${min}`; continue; }
    placedQty += qty;
    out.push({ seq: i, qty, notionalEst: parseFloat((qty * markPrice).toFixed(2)), offsetMs: i * intervalMs, side });
  }
  if (!out.length) return { ok: false, reason: firstErr || "no valid slices", slices: [] };
  return { ok: true, reason: null, count: out.length, intervalMs, totalQtyEst: parseFloat(placedQty.toFixed(decimals)), slices: out };
}
