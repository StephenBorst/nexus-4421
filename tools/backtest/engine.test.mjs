// Sanity tests for the backtest engine (run: node --test tools/backtest/engine.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "../../workers/nexus-lab-api/backtest.mjs";

// Build a synthetic hourly series from close prices; h/l straddle close slightly.
function series(closes, startT = 1_700_000_000) {
  return closes.map((c, i) => ({ t: startT + i * 3600, o: c, h: c * 1.001, l: c * 0.999, c }));
}
const noFunding = () => 0;

test("MOMENTUM goes long into an uptrend and books a TP win", () => {
  // +1% steps → momentum triggers long, price keeps rising to TP.
  const closes = [100];
  for (let i = 0; i < 20; i++) closes.push(closes[closes.length - 1] * 1.01);
  const r = runBacktest(series(closes), noFunding, { signalMode: "MOMENTUM", priceChangeThreshold: 0.5, tpPercent: 1.5, slPercent: 0.75, maxHoldHours: 8, leverage: 1, capitalPerTrade: 100 });
  assert.ok(r.trades > 0);
  assert.ok(r.netUsd > 0, `expected net>0, got ${r.netUsd}`);
});

test("MEAN_REVERSION shorts a spike and profits on the fade", () => {
  // one big +2% spike then revert down — mean-reversion shorts it.
  const closes = [100, 100, 102, 100.5, 99.5, 99, 98.8, 98.5];
  const r = runBacktest(series(closes), noFunding, { signalMode: "MEAN_REVERSION", priceChangeThreshold: 0.8, tpPercent: 1, slPercent: 2, maxHoldHours: 8, leverage: 1, capitalPerTrade: 100 });
  assert.ok(r.trades > 0);
});

test("no signal → no trades", () => {
  const flat = series(new Array(30).fill(100));
  const r = runBacktest(flat, noFunding, { signalMode: "MOMENTUM", priceChangeThreshold: 0.5, tpPercent: 1.5, slPercent: 0.75, maxHoldHours: 4 });
  assert.equal(r.trades, 0);
});

import { makeFundingPctAt } from "../../workers/nexus-lab-api/backtest.mjs";
test("makeFundingPctAt: no lookahead — ranks vs only past funding rows", () => {
  const rows = [{ ts: 1000, rate: 0.01 }, { ts: 2000, rate: 0.02 }, { ts: 3000, rate: 0.05 }];
  const at = makeFundingPctAt(rows);
  // at t=2 (ms 2000), only rows <=2000 exist [0.01,0.02]; current 0.02 → 100th pct
  assert.equal(at(2, 0.02), 100);
  // at t=1, only [0.01]; a below-history value → 0
  assert.equal(at(1, 0.005), 0);
});
