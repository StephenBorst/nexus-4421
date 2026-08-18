// node --test workers/nexus-carry-engine/carryPaper.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshState, stepPaper, summarize } from "./carryPaper.mjs";
import { SECTORS } from "./carryBasket.mjs";

const H = 3600000;
// a snapshot where all 6 sectors populate: deterministic funding + flat marks at 100
function snapshot(fundingOverrides = {}) {
  const funding = {}, mark = {};
  let i = 0;
  for (const arr of Object.values(SECTORS)) for (const t of arr) { funding[t] = Math.sin(i++) * 0.02; mark[t] = 100; }
  return { funding: { ...funding, ...fundingOverrides }, mark: { ...mark } };
}

test("first tick opens the full 12-leg book and stamps entries", () => {
  const t0 = 1_700_000_000_000;
  const { state, tick } = stepPaper(freshState({ capital: 1000 }), snapshot(), t0);
  assert.equal(tick.rebalanced, true, "first tick rebalances");
  assert.equal(state.book.legs.length, 12, "6 sectors × 2 legs");
  assert.equal(tick.fundingAccrued, 0, "no funding on the opening tick (no elapsed time)");
  assert.ok(state.book.legs.every((l) => l.entryPx === 100 && l.entryTs === t0));
  assert.equal(state.rebalances, 1);
});

test("funding accrues on held legs over elapsed time and drives equity up when carry is positive", () => {
  const t0 = 1_700_000_000_000;
  // force a clean carry: L1 long BTC at -0.03 (long profits), short SOL at +0.03 (short profits)
  const snap = snapshot({ BTC: -0.03, SOL: 0.03, ETH: 0, BNB: 0, AVAX: 0, NEAR: 0, DOT: 0, ADA: 0, APT: 0, SUI: 0, SEI: 0, TRX: 0, TIA: 0 });
  let st = stepPaper(freshState({ capital: 1000 }), snap, t0).state;
  // 24h later, same marks (no price move) → pure funding accrual, no rebalance churn yet
  const r = stepPaper(st, snap, t0 + 24 * H);
  assert.ok(r.tick.fundingAccrued > 0, "positive carry accrues");
  assert.ok(r.tick.equity > 1000, "equity rises on funding alone");
  // with flat marks the price component is ~0 → carry share should be dominant
  const sum = summarize(r.state);
  assert.ok(sum.cumFunding > 0);
  assert.ok(Math.abs(sum.cumPrice) < 0.01, "flat marks → ~zero price component");
});

test("no rebalance before the schedule; rebalance after it", () => {
  const t0 = 1_700_000_000_000;
  let st = stepPaper(freshState({ rebalanceHours: 24 }), snapshot(), t0).state;
  const early = stepPaper(st, snapshot(), t0 + 12 * H); // 12h < 24h
  assert.equal(early.tick.rebalanced, false, "no rebalance inside the window");
  const late = stepPaper(early.state, snapshot(), t0 + 30 * H); // 30h > 24h since last rebal
  assert.equal(late.tick.rebalanced, true, "rebalances once the window elapses");
});

test("a funding flip triggers a FLIP order that charges two maker fills and keeps the book neutral", () => {
  const t0 = 1_700_000_000_000;
  const snapA = snapshot({ BTC: -0.05, SOL: 0.05 }); // BTC long, SOL short in L1
  let st = stepPaper(freshState({ makerFeeBps: 1 }), snapA, t0).state; // taker-ish fee to make it visible
  const feesBefore = st.cumFees;
  const snapB = snapshot({ BTC: 0.05, SOL: -0.05 }); // funding inverts → BTC should now short, SOL long
  const r = stepPaper(st, snapB, t0 + 24 * H);
  assert.equal(r.tick.rebalanced, true);
  assert.ok(r.state.cumFees > feesBefore, "rebalance incurs fills");
  // book still balanced within L1
  const l1 = r.state.book.legs.filter((l) => l.sector === "L1");
  const net = l1.reduce((a, l) => a + l.side * l.notional, 0);
  assert.ok(Math.abs(net) < 1e-6, "L1 stays dollar-neutral after the flip");
});

test("maker rebate (negative bps) is income, not cost", () => {
  const t0 = 1_700_000_000_000;
  const st = stepPaper(freshState({ makerFeeBps: -0.1 }), snapshot(), t0).state;
  assert.ok(st.cumFees < 0, "a maker rebate accrues negative fees (income)");
});

test("price move is marked to market and attributed to the price component, not carry", () => {
  const t0 = 1_700_000_000_000;
  const snap0 = snapshot({ BTC: -0.05, SOL: 0.05, ETH: 0, BNB: 0, AVAX: 0, NEAR: 0, DOT: 0, ADA: 0, APT: 0, SUI: 0, SEI: 0, TRX: 0, TIA: 0 });
  let st = stepPaper(freshState({ capital: 1000 }), snap0, t0).state;
  // BTC (a long) rallies 10% before the next rebalance window
  const snap1 = { ...snap0, mark: { ...snap0.mark, BTC: 110 } };
  const r = stepPaper(st, snap1, t0 + 12 * H); // inside window → no rebalance, pure MTM
  assert.equal(r.tick.rebalanced, false);
  assert.ok(r.tick.unrealizedPrice > 0, "long BTC up 10% shows unrealized price gain");
  const sum = summarize(r.state);
  assert.ok(sum.cumPrice > 0, "price move attributed to price, not funding");
});

test("summarize reports carry share and never divides by zero on a fresh book", () => {
  const sum = summarize(freshState({ capital: 1000 }));
  assert.equal(sum.equity, 1000);
  assert.equal(sum.netPnl, 0);
  assert.equal(sum.carrySharePct, 0);
  assert.equal(sum.legs, 0);
});

test("state is not mutated in place (stepPaper is pure)", () => {
  const t0 = 1_700_000_000_000;
  const base = freshState({ capital: 1000 });
  const snap = snapshot();
  stepPaper(base, snap, t0);
  assert.equal(base.book.legs.length, 0, "input state untouched");
  assert.equal(base.rebalances, 0);
});

test("equityCurve is capped to maxEquityCurve", () => {
  let st = freshState({ capital: 1000, maxEquityCurve: 5, rebalanceHours: 1 });
  let t = 1_700_000_000_000;
  for (let i = 0; i < 20; i++) { st = stepPaper(st, snapshot(), t).state; t += 2 * H; }
  assert.ok(st.equityCurve.length <= 5, "curve trimmed to the cap");
});
