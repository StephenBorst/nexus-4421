// Money-path unit tests for the agent executor.
// Run: node --test workers/nexus-agent-exec/logic.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { snapQty, shouldResetDaily, dailyCapBlocked, computePnl, exitReason, agentThesisLevels, agentCloseStatus, volScaledLevels, evaluateExit, normTakeProfits, dcaUnitMargin, nextSafetyOrder, blendAvg, dcaTakeProfitPrice, breakevenArmed, directiveExpired, directiveShouldFill, directiveLevels, volScaledCapital, realizedVolPct, selectCopySignal } from "./logic.mjs";

// ─── snapQty ───────────────────────────────────────────────
test("snapQty: snaps cleanly to base_tick (no float artifacts)", () => {
  // The real -1104 bug: 340 * 1e-5 = 0.0034000000000000007. Must come back exact.
  const r = snapQty({ capitalPerTrade: 30, leverage: 5, markPrice: 71520, baseTick: 0.00001, baseMin: 0.00001, minNotional: 0 });
  assert.equal(r.ok, true);
  // qty must equal its own toFixed (i.e. no trailing float garbage)
  const decimals = 5;
  assert.equal(r.qty, parseFloat(r.qty.toFixed(decimals)));
  assert.ok(Number.isFinite(r.qty) && r.qty > 0);
});

test("snapQty: BTC-like tick produces a sane qty", () => {
  const r = snapQty({ capitalPerTrade: 30, leverage: 5, markPrice: 70000, baseTick: 0.0001, baseMin: 0.0001, minNotional: 0 });
  assert.equal(r.ok, true);
  // notional 150 / 70000 ≈ 0.00214 → floored to tick 0.0001 → 0.0021
  assert.equal(r.qty, 0.0021);
});

test("snapQty: rejects below base_min", () => {
  const r = snapQty({ capitalPerTrade: 1, leverage: 1, markPrice: 70000, baseTick: 0.0001, baseMin: 0.001, minNotional: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /base_min/);
});

test("snapQty: rejects below min_notional (qty valid but notional too small)", () => {
  // notional 41 / 70000 → qty 0.0005 (above base_min 0.0001), notional 35 < 50
  const r = snapQty({ capitalPerTrade: 41, leverage: 1, markPrice: 70000, baseTick: 0.0001, baseMin: 0.0001, minNotional: 50 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /notional/);
});

test("snapQty: rejects bad mark price", () => {
  assert.equal(snapQty({ capitalPerTrade: 30, leverage: 5, markPrice: 0, baseTick: 0.001, baseMin: 0.001, minNotional: 0 }).ok, false);
});

// ─── daily reset + caps ────────────────────────────────────
test("shouldResetDaily: true after >24h, false within", () => {
  const now = 1_000_000_000_000;
  assert.equal(shouldResetDaily(now - (25 * 3600_000), now), true);
  assert.equal(shouldResetDaily(now - (1 * 3600_000), now), false);
  assert.equal(shouldResetDaily(0, now), true);          // never reset
  assert.equal(shouldResetDaily(undefined, now), true);
});

test("dailyCapBlocked: blocks at max trades/day", () => {
  const r = dailyCapBlocked({ trades_today: 10, daily_pnl: 0 }, { maxTradesPerDay: 10, maxDailyLossUsdc: 5 });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /max trades/);
});

test("dailyCapBlocked: blocks at daily loss cap (only when negative)", () => {
  const cfg = { maxTradesPerDay: 99, maxDailyLossUsdc: 5 };
  assert.equal(dailyCapBlocked({ trades_today: 1, daily_pnl: -5 }, cfg).blocked, true);
  assert.equal(dailyCapBlocked({ trades_today: 1, daily_pnl: -6 }, cfg).blocked, true);
  // A big WIN must never block (abs >= cap but positive)
  assert.equal(dailyCapBlocked({ trades_today: 1, daily_pnl: 50 }, cfg).blocked, false);
  assert.equal(dailyCapBlocked({ trades_today: 1, daily_pnl: -4.99 }, cfg).blocked, false);
});

test("dailyCapBlocked: clean state is allowed", () => {
  assert.equal(dailyCapBlocked({ trades_today: 0, daily_pnl: 0 }, { maxTradesPerDay: 10, maxDailyLossUsdc: 5 }).blocked, false);
  assert.equal(dailyCapBlocked({}, { maxTradesPerDay: 10, maxDailyLossUsdc: 5 }).blocked, false);
});

// ─── P&L ───────────────────────────────────────────────────
test("computePnl: LONG win/loss", () => {
  const win = computePnl("LONG", 100, 110, 2);   // +10% on qty 2 @ entry 100 → +$20
  assert.ok(Math.abs(win.pnlPct - 10) < 1e-9);
  assert.ok(Math.abs(win.pnlUsdc - 20) < 1e-9);
  const loss = computePnl("LONG", 100, 95, 2);    // -5% → -$10
  assert.ok(Math.abs(loss.pnlPct + 5) < 1e-9);
  assert.ok(Math.abs(loss.pnlUsdc + 10) < 1e-9);
});

test("computePnl: SHORT is inverted", () => {
  const win = computePnl("SHORT", 100, 90, 2);    // price down 10% → short +10% → +$20
  assert.ok(Math.abs(win.pnlPct - 10) < 1e-9);
  assert.ok(Math.abs(win.pnlUsdc - 20) < 1e-9);
  const loss = computePnl("SHORT", 100, 110, 2);  // price up → short loses
  assert.ok(Math.abs(loss.pnlPct + 10) < 1e-9);
  assert.ok(Math.abs(loss.pnlUsdc + 20) < 1e-9);
});

// ─── exit reason ───────────────────────────────────────────
test("exitReason: TP/SL/timeout priority", () => {
  const cfg = { tpPercent: 1.5, slPercent: 0.75, maxHoldHours: 4 };
  assert.equal(exitReason(2, 0, cfg), "TP");
  assert.equal(exitReason(1.5, 0, cfg), "TP");           // boundary inclusive
  assert.equal(exitReason(-1, 0, cfg), "SL");
  assert.equal(exitReason(-0.75, 0, cfg), "SL");         // boundary inclusive
  assert.equal(exitReason(0.5, 5 * 3600_000, cfg), "TIMEOUT");
  assert.equal(exitReason(0.5, 1 * 3600_000, cfg), null); // still holding
  // TP takes priority even if also timed out
  assert.equal(exitReason(2, 5 * 3600_000, cfg), "TP");
});

// ─── evaluateExit (multi-TP + trailing) ───────────────────
const H = 3600_000;

test("normTakeProfits: legacy single tpPercent → one 100% level", () => {
  assert.deepEqual(normTakeProfits({ tpPercent: 1.5 }, {}), [{ pct: 1.5, sizePct: 100 }]);
  // config-level fallback when pos has none
  assert.deepEqual(normTakeProfits({}, { tpPercent: 2 }), [{ pct: 2, sizePct: 100 }]);
});

test("normTakeProfits: array is filtered + sorted ascending", () => {
  const tps = normTakeProfits({ takeProfits: [{ pct: 2.5, sizePct: 50 }, { pct: 1, sizePct: 50 }, { pct: 0, sizePct: 10 }] }, {});
  assert.deepEqual(tps, [{ pct: 1, sizePct: 50 }, { pct: 2.5, sizePct: 50 }]);
});

test("evaluateExit: legacy single TP → FULL_CLOSE TP at/above target", () => {
  const cfg = { tpPercent: 1.5, slPercent: 0.75, maxHoldHours: 4 };
  assert.deepEqual(evaluateExit({}, 2, 0, cfg), { type: "FULL_CLOSE", reason: "TP" });
  assert.deepEqual(evaluateExit({}, 1.5, 0, cfg), { type: "FULL_CLOSE", reason: "TP" });
});

test("evaluateExit: SL and TIMEOUT full-close; SL wins over TP same tick", () => {
  const cfg = { tpPercent: 1.5, slPercent: 0.75, maxHoldHours: 4 };
  assert.deepEqual(evaluateExit({}, -1, 0, cfg), { type: "FULL_CLOSE", reason: "SL" });
  assert.deepEqual(evaluateExit({}, 0.5, 5 * H, cfg), { type: "FULL_CLOSE", reason: "TIMEOUT" });
  assert.deepEqual(evaluateExit({}, 0.5, 1 * H, cfg), null);
  // pos.slPercent overrides config (vol-scaled stop stored on the position)
  assert.deepEqual(evaluateExit({ slPercent: 2 }, -1, 0, cfg), null);
});

test("evaluateExit: two-level ladder → partial at TP1, full close at TP2", () => {
  const cfg = { slPercent: 1, maxHoldHours: 4, takeProfits: [{ pct: 1, sizePct: 50 }, { pct: 2.5, sizePct: 50 }] };
  // hit TP1, none filled yet → scale out 50%
  assert.deepEqual(evaluateExit({ tp_hits: [] }, 1.2, 0, cfg), { type: "PARTIAL_TP", level: 0, sizePct: 50 });
  // TP1 already filled, now at TP2 (last level) → full close
  assert.deepEqual(evaluateExit({ tp_hits: [0] }, 2.6, 0, cfg), { type: "FULL_CLOSE", reason: "TP" });
});

test("evaluateExit: already-filled level is skipped (no double scale-out)", () => {
  const cfg = { slPercent: 1, maxHoldHours: 4, takeProfits: [{ pct: 1, sizePct: 50 }, { pct: 2.5, sizePct: 50 }] };
  // back at TP1 price after filling it, TP2 not reached → hold
  assert.equal(evaluateExit({ tp_hits: [0] }, 1.1, 0, cfg), null);
});

test("evaluateExit: cumulative size reaching 100% closes fully even mid-ladder", () => {
  const cfg = { slPercent: 1, maxHoldHours: 4, takeProfits: [{ pct: 1, sizePct: 60 }, { pct: 2, sizePct: 40 }] };
  // TP1 (60%) filled, TP2 (40%) reached → cum 100% → full close
  assert.deepEqual(evaluateExit({ tp_hits: [0] }, 2.1, 0, cfg), { type: "FULL_CLOSE", reason: "TP" });
});

test("evaluateExit: trailing stop locks gains once activated", () => {
  const cfg = { slPercent: 1, maxHoldHours: 99, trailingStopPct: 0.5, takeProfits: [{ pct: 1, sizePct: 100 }] };
  // below activation (TP1=1%) → no trail action, just holding
  assert.equal(evaluateExit({ peak_pnl_pct: 0.5 }, 0.6, 0, cfg), null);
  // rose to 1.2% (≥ activation) and is a new peak → ratchet the stop to 0.7
  assert.deepEqual(evaluateExit({ peak_pnl_pct: 0.5 }, 1.2, 0, cfg), { type: "TRAIL_UPDATE", trailStop: 0.7, peak: 1.2 });
  // peak was 1.5, now pulled back to 0.9 ≤ (1.5-0.5=1.0) → trail close
  assert.deepEqual(evaluateExit({ peak_pnl_pct: 1.5 }, 0.9, 0, cfg), { type: "FULL_CLOSE", reason: "TRAIL" });
});

test("evaluateExit: hard SL still beats an active trailing profit", () => {
  const cfg = { slPercent: 1, maxHoldHours: 99, trailingStopPct: 0.5, takeProfits: [{ pct: 1, sizePct: 100 }] };
  assert.deepEqual(evaluateExit({ peak_pnl_pct: 2 }, -1.2, 0, cfg), { type: "FULL_CLOSE", reason: "SL" });
});

// ─── breakevenArmed / breakeven stop ("risk-free trade") ────
test("breakevenArmed: off when trigger unset, latches on cross, stays latched on pullback", () => {
  assert.equal(breakevenArmed({}, 5, 0), false); // 0 = feature off, no matter the pnl
  assert.equal(breakevenArmed({}, 0.5, 1), false); // below trigger, not armed yet
  assert.equal(breakevenArmed({}, 1, 1), true); // crosses trigger this tick
  assert.equal(breakevenArmed({ be_armed: true }, -5, 1), true); // once latched, a pullback can't un-arm it
});

test("evaluateExit: breakeven stop closes flat once armed and price falls back to entry", () => {
  const cfg = { slPercent: 5, maxHoldHours: 99, breakevenBufferPct: 0 };
  // armed (be_armed:true from a prior tick), price pulled back to exactly entry (0%)
  assert.deepEqual(evaluateExit({ be_armed: true }, 0, 0, cfg), { type: "FULL_CLOSE", reason: "BE" });
  // still above the buffer → holds
  assert.equal(evaluateExit({ be_armed: true }, 0.2, 0, cfg), null);
  // not armed yet → the wide 5% SL applies, not breakeven (0.5% loss doesn't close)
  assert.equal(evaluateExit({}, -0.5, 0, cfg), null);
});

test("evaluateExit: breakeven buffer locks in a real profit, not just entry price", () => {
  const cfg = { slPercent: 5, maxHoldHours: 99, breakevenBufferPct: 0.1 };
  // armed, pulled back to +0.05% — below the 0.1% buffer floor → closes (still a win, covers fees)
  assert.deepEqual(evaluateExit({ be_armed: true }, 0.05, 0, cfg), { type: "FULL_CLOSE", reason: "BE" });
  assert.equal(evaluateExit({ be_armed: true }, 0.15, 0, cfg), null);
});

test("evaluateExit: breakeven fires before the wider hard SL once armed", () => {
  const cfg = { slPercent: 5, maxHoldHours: 99, breakevenBufferPct: 0 };
  // a fast reversal to -2% would normally be well inside a 5% SL and hold — but
  // once armed, breakeven is the tighter, controlling stop.
  assert.deepEqual(evaluateExit({ be_armed: true }, -2, 0, cfg), { type: "FULL_CLOSE", reason: "BE" });
});

// ─── agent → feed bridge ───────────────────────────────────
test("agentThesisLevels: LONG projects TP up / SL down + R:R", () => {
  const r = agentThesisLevels({ entryPrice: 100, direction: "LONG", tpPercent: 1.5, slPercent: 0.75 });
  assert.ok(Math.abs(r.takeProfit1 - 101.5) < 1e-9);
  assert.ok(Math.abs(r.stopLoss - 99.25) < 1e-9);
  assert.ok(Math.abs(r.riskReward - 2) < 1e-9);
});

test("agentThesisLevels: SHORT inverts TP/SL", () => {
  const r = agentThesisLevels({ entryPrice: 100, direction: "SHORT", tpPercent: 2, slPercent: 1 });
  assert.ok(Math.abs(r.takeProfit1 - 98) < 1e-9);   // TP below entry
  assert.ok(Math.abs(r.stopLoss - 101) < 1e-9);     // SL above entry
  assert.ok(Math.abs(r.riskReward - 2) < 1e-9);
});

test("agentThesisLevels: zero slPercent → R:R 0 (no divide-by-zero)", () => {
  assert.equal(agentThesisLevels({ entryPrice: 100, direction: "LONG", tpPercent: 1, slPercent: 0 }).riskReward, 0);
});

test("agentCloseStatus: maps exit reason → feed status", () => {
  assert.equal(agentCloseStatus("TP"), "HIT_TP");
  assert.equal(agentCloseStatus("SL"), "STOPPED_OUT");
  assert.equal(agentCloseStatus("TIMEOUT"), "CLOSED");
  assert.equal(agentCloseStatus("KILLED"), "CLOSED");
});

// ── volScaledLevels (ATR-scaled stops) ──────────────────────────────────────
test("volScaledLevels: invalid/zero ATR → falls back to fixed config", () => {
  const cfg = { tpPercent: 1.5, slPercent: 0.75 };
  assert.deepEqual(volScaledLevels(null, cfg), { slPercent: 0.75, tpPercent: 1.5 });
  assert.deepEqual(volScaledLevels(0, cfg), { slPercent: 0.75, tpPercent: 1.5 });
});
test("volScaledLevels: scales SL to ATR and preserves R:R", () => {
  const cfg = { tpPercent: 1.5, slPercent: 0.75 }; // RR = 2
  const lv = volScaledLevels(1.2, cfg); // 1.2% ATR, slMult 1 → SL 1.2, TP 2.4
  assert.equal(lv.slPercent, 1.2);
  assert.equal(lv.tpPercent, 2.4);
  assert.equal(lv.tpPercent / lv.slPercent, 2); // RR preserved
});
test("volScaledLevels: clamps SL to [0.3, 3.0]", () => {
  const cfg = { tpPercent: 1.5, slPercent: 0.75 };
  assert.equal(volScaledLevels(0.05, cfg).slPercent, 0.3);  // tiny ATR floored
  assert.equal(volScaledLevels(9, cfg).slPercent, 3.0);     // huge ATR capped
});
test("volScaledLevels: slAtrMult widens the stop", () => {
  const cfg = { tpPercent: 1.5, slPercent: 0.75, slAtrMult: 1.5 };
  assert.equal(volScaledLevels(1.0, cfg).slPercent, 1.5); // 1.0 ATR × 1.5
});

// ─── DCA / safety orders ───────────────────────────────────
test("dcaUnitMargin: base + safety orders sum to capitalPerTrade", () => {
  // 3 SOs, volumeScale 1 (flat) → 4 equal units of 100/4 = 25
  assert.equal(dcaUnitMargin(100, { maxSafetyOrders: 3, safetyOrderVolumeScale: 1 }), 25);
  // volumeScale 2 → units 1+2+4 = 7 → base 70/7 = 10
  assert.equal(dcaUnitMargin(70, { maxSafetyOrders: 2, safetyOrderVolumeScale: 2 }), 10);
  // no safety orders → whole budget is the base
  assert.equal(dcaUnitMargin(50, { maxSafetyOrders: 0 }), 50);
});

test("nextSafetyOrder: fires when price deviates past the cumulative step (LONG)", () => {
  const dca = { maxSafetyOrders: 2, safetyOrderStepPct: 1, safetyOrderStepScale: 1, safetyOrderVolumeScale: 2 };
  const pos = { direction: "LONG", base_entry_price: 100, filled_safety_orders: 0 };
  // SO1 triggers at 1% below base = 99
  assert.equal(nextSafetyOrder(pos, 99.5, 70, dca).shouldAdd, false);
  const so = nextSafetyOrder(pos, 99, 70, dca);
  assert.equal(so.shouldAdd, true);
  assert.equal(so.trigger, 99);
  assert.equal(so.level, 1);
  // SO1 margin = base(10) * vs^1 = 20
  assert.equal(so.soMargin, 20);
});

test("nextSafetyOrder: SHORT inverts trigger direction + cumulative step widens", () => {
  const dca = { maxSafetyOrders: 2, safetyOrderStepPct: 1, safetyOrderStepScale: 2, safetyOrderVolumeScale: 1 };
  const pos = { direction: "SHORT", base_entry_price: 100, filled_safety_orders: 1 };
  // already filled 1; next is SO2 at cumDev = 1*(1) + 1*(2) = 3% ABOVE base = 103
  const so = nextSafetyOrder(pos, 103, 40, dca);
  assert.equal(so.shouldAdd, true);
  assert.equal(so.trigger, 103);
  assert.equal(so.level, 2);
});

test("nextSafetyOrder: stops once maxSafetyOrders reached", () => {
  const dca = { maxSafetyOrders: 2, safetyOrderStepPct: 1 };
  assert.equal(nextSafetyOrder({ direction: "LONG", base_entry_price: 100, filled_safety_orders: 2 }, 50, 70, dca).shouldAdd, false);
});

test("blendAvg: weighted average of two fills", () => {
  const r = blendAvg(1, 100, 1, 90); // equal qty → midpoint 95
  assert.equal(r.newQty, 2);
  assert.equal(r.newAvg, 95);
  const r2 = blendAvg(3, 100, 1, 80); // (300+80)/4 = 95
  assert.equal(r2.newAvg, 95);
});

test("dcaTakeProfitPrice: TP off avg, direction-aware", () => {
  assert.equal(dcaTakeProfitPrice(100, 2, "LONG"), 102);
  assert.equal(dcaTakeProfitPrice(100, 2, "SHORT"), 98);
});

// ─── Directional directives ────────────────────────────────
test("directiveExpired: only past validUntil", () => {
  assert.equal(directiveExpired({ validUntil: 100 }, 99), false);
  assert.equal(directiveExpired({ validUntil: 100 }, 101), true);
  assert.equal(directiveExpired({}, 999), false); // no expiry set
});

test("directiveShouldFill: MARKET always fills at a valid price", () => {
  assert.equal(directiveShouldFill({ entryType: "MARKET", direction: "LONG" }, 95000), true);
  assert.equal(directiveShouldFill({ direction: "LONG" }, 95000), true); // default MARKET
  assert.equal(directiveShouldFill({ entryType: "MARKET" }, 0), false);  // bad price
});

test("directiveShouldFill: LIMIT LONG fills at/just-above entry, not past maxChase", () => {
  const d = { entryType: "LIMIT", direction: "LONG", entryPrice: 95000, entryTolerancePct: 0.1, maxChasePct: 1 };
  assert.equal(directiveShouldFill(d, 95000), true);           // at entry
  assert.equal(directiveShouldFill(d, 95090), true);           // within +0.1% tolerance
  assert.equal(directiveShouldFill(d, 95200), false);          // too far above (missed)
  assert.equal(directiveShouldFill(d, 94500), true);           // below entry (better) within chase
  assert.equal(directiveShouldFill(d, 93000), false);          // gapped >1% below → refuse
});

test("directiveShouldFill: LIMIT SHORT mirrors LONG", () => {
  const d = { entryType: "LIMIT", direction: "SHORT", entryPrice: 95000, entryTolerancePct: 0.1, maxChasePct: 1 };
  assert.equal(directiveShouldFill(d, 95000), true);
  assert.equal(directiveShouldFill(d, 94910), true);           // within -0.1% tolerance
  assert.equal(directiveShouldFill(d, 95500), true);           // above entry (better) within chase
  assert.equal(directiveShouldFill(d, 97000), false);          // gapped >1% above → refuse
});

test("directiveLevels: LONG converts prices to % off fill + builds TP ladder", () => {
  const r = directiveLevels({ direction: "LONG", stopLoss: 93000, takeProfit1: 98000, takeProfit2: 102000, tp1SizePct: 60 }, 95000);
  assert.ok(!r.error);
  assert.equal(r.slPercent, 2.11);   // |93000-95000|/95000
  assert.equal(r.tpPercent, 3.16);   // |98000-95000|/95000
  assert.deepEqual(r.takeProfits, [{ pct: 3.16, sizePct: 60 }, { pct: 7.37, sizePct: 40 }]);
});

test("directiveLevels: single TP when tp2 absent (100% size)", () => {
  const r = directiveLevels({ direction: "LONG", stopLoss: 93000, takeProfit1: 98000 }, 95000);
  assert.deepEqual(r.takeProfits, [{ pct: 3.16, sizePct: 100 }]);
});

test("directiveLevels: rejects inverted levels", () => {
  // LONG with stop ABOVE entry is self-contradicting.
  assert.match(directiveLevels({ direction: "LONG", stopLoss: 96000, takeProfit1: 98000 }, 95000).error, /inverted/);
  // SHORT with TP above entry is wrong.
  assert.match(directiveLevels({ direction: "SHORT", stopLoss: 96000, takeProfit1: 98000 }, 95000).error, /inverted/);
});

test("directiveLevels: SHORT direction-side correct", () => {
  const r = directiveLevels({ direction: "SHORT", stopLoss: 97000, takeProfit1: 92000 }, 95000);
  assert.ok(!r.error);
  assert.equal(r.slPercent, 2.11);
  assert.equal(r.tpPercent, 3.16);
});

// ─── volScaledCapital / realizedVolPct (B: vol-targeted sizing) ───
test("volScaledCapital: off when volTargetPct<=0 → capital unchanged", () => {
  assert.equal(volScaledCapital(50, 2.4, 0), 50);
  assert.equal(volScaledCapital(50, 2.4, undefined), 50);
});

test("volScaledCapital: off when realized vol absent → capital unchanged", () => {
  assert.equal(volScaledCapital(50, 0, 2), 50);
  assert.equal(volScaledCapital(50, null, 2), 50);
});

test("volScaledCapital: high vol → sizes DOWN, calm vol → sizes UP", () => {
  // target 2%, realized 4% → scale 0.5 → 25
  assert.equal(volScaledCapital(50, 4, 2), 25);
  // target 2%, realized 1% → scale 2 → 100
  assert.equal(volScaledCapital(50, 1, 2), 100);
});

test("volScaledCapital: clamps scale to [minScale, maxScale]", () => {
  // realized 10% vs target 2% → 0.2 but clamped to 0.4 → 20
  assert.equal(volScaledCapital(50, 10, 2), 20);
  // realized 0.1% vs target 2% → 20x but clamped to 2 → 100
  assert.equal(volScaledCapital(50, 0.1, 2), 100);
});

test("volScaledCapital: guards bad capital", () => {
  assert.equal(volScaledCapital(0, 2, 2), 0);
  assert.equal(volScaledCapital(-5, 2, 2), 0);
});

test("realizedVolPct: null on too-few points", () => {
  assert.equal(realizedVolPct([100]), null);
  assert.equal(realizedVolPct([100, 101]), null);
});

test("realizedVolPct: flat series → ~0 vol", () => {
  const v = realizedVolPct([100, 100, 100, 100]);
  assert.ok(v !== null && v < 1e-9);
});

test("realizedVolPct: computes a positive vol for a moving series", () => {
  const v = realizedVolPct([100, 102, 99, 103, 98]);
  assert.ok(v !== null && v > 0);
});

// ── Autocopy — selectCopySignal ──────────────────────────────────────────────
const acCfg = (leaders) => ({ autocopy: { enabled: true, leaders } });
const leaderLong = { wallet: "0xLEAD", position: { symbol: "PERP_BTC_USDC", direction: "LONG", opened_at: 111, entry_price: 60000 } };

test("selectCopySignal: off / empty → null", () => {
  assert.equal(selectCopySignal({}, [leaderLong], null), null);
  assert.equal(selectCopySignal({ autocopy: { enabled: false, leaders: ["0xlead"] } }, [leaderLong], null), null);
  assert.equal(selectCopySignal(acCfg([]), [leaderLong], null), null);
});

test("selectCopySignal: mirrors a followed leader's open position (case-insensitive)", () => {
  const s = selectCopySignal(acCfg(["0xLEAD"]), [leaderLong], null);
  assert.equal(s.symbol, "PERP_BTC_USDC");
  assert.equal(s.direction, "LONG");
  assert.equal(s.leader, "0xlead");
});

test("selectCopySignal: ignores un-followed leaders + flat leaders", () => {
  assert.equal(selectCopySignal(acCfg(["0xOTHER"]), [leaderLong], null), null);
  assert.equal(selectCopySignal(acCfg(["0xLEAD"]), [{ wallet: "0xLEAD", position: null }], null), null);
});

test("selectCopySignal: never copies a PAPER leader position (real trades only)", () => {
  const paper = { wallet: "0xLEAD", position: { ...leaderLong.position, paper: true } };
  assert.equal(selectCopySignal(acCfg(["0xLEAD"]), [paper], null), null);
});

test("selectCopySignal: dedupes an already-copied leader position by key", () => {
  const first = selectCopySignal(acCfg(["0xLEAD"]), [leaderLong], null);
  assert.equal(selectCopySignal(acCfg(["0xLEAD"]), [leaderLong], first.key), null); // same position → skip
  // leader opens a NEW position (different opened_at) → copies again
  const next = { wallet: "0xLEAD", position: { symbol: "PERP_ETH_USDC", direction: "SHORT", opened_at: 222 } };
  const s2 = selectCopySignal(acCfg(["0xLEAD"]), [next], first.key);
  assert.equal(s2.symbol, "PERP_ETH_USDC");
});
