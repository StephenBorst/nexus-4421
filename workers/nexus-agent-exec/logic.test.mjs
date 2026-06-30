// Money-path unit tests for the agent executor.
// Run: node --test workers/nexus-agent-exec/logic.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { snapQty, shouldResetDaily, dailyCapBlocked, computePnl, exitReason, agentThesisLevels, agentCloseStatus, volScaledLevels, evaluateExit, normTakeProfits } from "./logic.mjs";

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
