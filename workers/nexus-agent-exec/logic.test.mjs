// Money-path unit tests for the agent executor.
// Run: node --test workers/nexus-agent-exec/logic.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { snapQty, shouldResetDaily, dailyCapBlocked, computePnl, exitReason } from "./logic.mjs";

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
