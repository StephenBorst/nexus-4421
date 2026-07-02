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

import { makeOiChangeAt, oiSeriesInfo } from "../../workers/nexus-lab-api/backtest.mjs";
test("makeOiChangeAt: no lookahead — fractional OI delta of the two samples at/before t", () => {
  // hourly {t(ms), oi}. delta = (cur.oi - prev.oi)/prev.oi vs the sample before it.
  const rows = [{ t: 3600_000, oi: 100 }, { t: 7200_000, oi: 110 }, { t: 10800_000, oi: 99 }];
  const at = makeOiChangeAt(rows);
  assert.equal(at(1000), null);   // cutoff 1.0M ms → no samples at/before → null
  assert.equal(at(3600), null);   // cutoff 3.6M ms → only the first sample → null (need 2)
  assert.equal(Math.round(at(7200) * 100) / 100, 0.1);   // prev 100 → cur 110 = +0.10
  assert.equal(Math.round(at(10800) * 100) / 100, -0.1); // prev 110 → cur 99  = -0.10
});

test("oiSeriesInfo: samples + day-span coverage", () => {
  assert.deepEqual(oiSeriesInfo([]), { samples: 0, days: 0 });
  const day = 86400_000;
  const rows = [{ t: 0, oi: 1 }, { t: day, oi: 1 }, { t: 3 * day, oi: 1 }];
  assert.deepEqual(oiSeriesInfo(rows), { samples: 3, days: 3 });
  // rows without a positive oi are ignored
  assert.deepEqual(oiSeriesInfo([{ t: 0, oi: 0 }, { t: day, oi: NaN }]), { samples: 0, days: 0 });
});

import { atrPctAt } from "../../workers/nexus-lab-api/backtest.mjs";
test("atrPctAt: no-lookahead rolling ATR% (null until enough prior candles)", () => {
  // constant 2-wide bars around a ~100 close → ATR ≈ 2, ATR% ≈ 2%.
  const candles = Array.from({ length: 20 }, (_, i) => ({ t: i * 3600, o: 100, h: 101, l: 99, c: 100 }));
  assert.equal(atrPctAt(candles, 2), null, "too few prior candles → null");
  const a = atrPctAt(candles, 18);
  assert.ok(a > 1.8 && a < 2.2, `expected ~2%, got ${a}`);
});

test("runBacktest: volScaledStops overrides the fixed stop from ATR", () => {
  // A momentum uptrend; compare fixed tight stop vs vol-scaled. Just assert the
  // vol-scaled run produces a DIFFERENT result (the ATR stop replaced the fixed one).
  const closes = [100]; for (let i = 0; i < 30; i++) closes.push(closes[closes.length - 1] * 1.008);
  const candles = closes.map((c, i) => ({ t: 1_700_000_000 + i * 3600, o: c, h: c * 1.004, l: c * 0.996, c }));
  const base = { signalMode: "MOMENTUM", priceChangeThreshold: 0.5, tpPercent: 1.5, slPercent: 0.75, maxHoldHours: 8, leverage: 1, capitalPerTrade: 100 };
  const fixed = runBacktest(candles, noFunding, base);
  const scaled = runBacktest(candles, noFunding, { ...base, volScaledStops: true, slAtrMult: 1.0 });
  assert.ok(scaled.trades > 0, "vol-scaled still trades");
  assert.notEqual(scaled.avgPnlPct, fixed.avgPnlPct, "ATR stop should change the exit vs fixed");
});

test("runBacktest: CONFLUENCE fires only with an oiChangeAt that agrees with funding", () => {
  // i=1 price falls (priceChange<0) while funding is deeply negative (→ funding says
  // LONG) and OI is RISING (oiChange>0) → LONG divergence agrees → CONFLUENCE LONG.
  // i=2 rips up past the 1% TP so the trade closes and is recorded. Without an
  // oiChangeAt the OI rule is inert, funding≠oi, and CONFLUENCE never enters.
  const closes = [100, 99, 100.5];
  const candles = closes.map((c, i) => ({ t: 1_700_000_000 + i * 3600, o: c, h: c * 1.001, l: c * 0.999, c }));
  const funding = () => -0.02; // ≤ -fundingThreshold(0.01) → funding says LONG
  const cfg = { signalMode: "CONFLUENCE", fundingThreshold: 0.01, oiChangeThreshold: 0, tpPercent: 1, slPercent: 2, maxHoldHours: 8, leverage: 1, capitalPerTrade: 100 };
  const oiRows = candles.map((c, i) => ({ t: c.t * 1000, oi: 100 + i * 10 })); // OI rising each bar
  const withOi = runBacktest(candles, funding, cfg, null, makeOiChangeAt(oiRows));
  const withoutOi = runBacktest(candles, funding, cfg, null, null);
  assert.equal(withoutOi.trades, 0, "no OI series → CONFLUENCE inert");
  assert.ok(withOi.trades > 0, `expected CONFLUENCE trades with agreeing OI, got ${withOi.trades}`);
});
