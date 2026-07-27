// In-flight call progress tests. Run: node --test app/lib/callProgress.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { callProgress, openCallsSummary } from "./callProgress.mjs";

// LONG: entry 100, stop 95 (risk 5), target 110 (reward 10 = 2R)
const long = { direction: "LONG", entryPrice: 100, stopLoss: 95, takeProfit1: 110 };
const short = { direction: "SHORT", entryPrice: 100, stopLoss: 105, takeProfit1: 90 };

test("R is measured in risk units, matching how the product ranks everything else", () => {
  assert.equal(callProgress(long, 100).r, 0);      // at entry
  assert.equal(callProgress(long, 105).r, 1);      // +1R
  assert.equal(callProgress(long, 92.5).r, -1.5);  // through the stop
  assert.equal(callProgress(long, 110).rewardR, 2);
});

test("shorts invert: price falling is the call working", () => {
  assert.equal(callProgress(short, 95).r, 1);
  assert.equal(callProgress(short, 105).r, -1);
  assert.equal(callProgress(short, 90).pctToTarget, 1);
});

test("pctToTarget is the journey from entry to target, clamped", () => {
  assert.equal(callProgress(long, 105).pctToTarget, 0.5);
  assert.equal(callProgress(long, 110).pctToTarget, 1);
  assert.equal(callProgress(long, 130).pctToTarget, 1);   // overshoot clamps
  assert.ok(callProgress(long, 90).pctToTarget < 0);      // adverse is negative
});

test("barPos maps price onto the SL→TP span and stays in range", () => {
  assert.equal(callProgress(long, 95).barPos, 0);         // at stop
  assert.equal(callProgress(long, 110).barPos, 1);        // at target
  assert.ok(Math.abs(callProgress(long, 102.5).barPos - 0.5) < 0.01);
  for (const px of [1, 50, 95, 100, 110, 500]) {
    const b = callProgress(long, px).barPos;
    assert.ok(b >= 0 && b <= 1, `barPos ${b} out of range at ${px}`);
  }
});

test("state describes where price is NOW and never claims an outcome", () => {
  assert.equal(callProgress(long, 100).state, "FLAT");
  assert.equal(callProgress(long, 103).state, "WINNING");
  assert.equal(callProgress(long, 97).state, "LOSING");
  assert.equal(callProgress(long, 110).state, "AT_TARGET");
  assert.equal(callProgress(long, 95).state, "AT_STOP");
  // Deliberately NOT "WIN"/"LOSS" — only gradeCall may say that, from first-touch
  // across the candle series. A retraced winner still grades WIN; this read wouldn't.
  for (const px of [90, 100, 120]) {
    assert.ok(!["WIN", "LOSS"].includes(callProgress(long, px).state));
  }
});

test("distance-to-level is expressed against current price", () => {
  const p = callProgress(long, 100);
  assert.equal(p.toTpPct, 10);  // 100 → 110
  assert.equal(p.toSlPct, 5);   // 100 → 95
});

test("unusable input yields null instead of a misleading zero", () => {
  assert.equal(callProgress(null, 100), null);
  assert.equal(callProgress(long, 0), null);
  assert.equal(callProgress(long, NaN), null);
  assert.equal(callProgress({ ...long, stopLoss: 100 }, 105), null); // no risk distance
  assert.equal(callProgress({ ...long, entryPrice: 0 }, 105), null);
});

test("openCallsSummary aggregates the live book", () => {
  const rows = [
    { progress: callProgress(long, 105) },   // +1R
    { progress: callProgress(long, 97.5) },  // -0.5R
    { progress: callProgress(short, 95) },   // +1R
  ];
  const s = openCallsSummary(rows);
  assert.equal(s.open, 3);
  assert.equal(s.winning, 2);
  assert.equal(s.losing, 1);
  assert.equal(s.rSum, 1.5);
  assert.equal(s.avgR, 0.5);
  assert.equal(openCallsSummary([]), null);
  assert.equal(openCallsSummary([{ progress: null }]), null);
});
