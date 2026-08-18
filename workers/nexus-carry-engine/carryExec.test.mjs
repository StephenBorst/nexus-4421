// node --test workers/nexus-carry-engine/carryExec.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapQty, makerPrice, planOrders, planIsBalanced } from "./carryExec.mjs";

test("snapQty floors to base_tick without float artifacts", () => {
  // 0.0034/0.001 → 3 steps → 0.003 exactly (not 0.0030000000000000005)
  const q = snapQty(0.0034, 0.001, 0.001, 0, 0);
  assert.equal(q, 0.003);
  assert.equal(String(q), "0.003");
});

test("snapQty ceils up to clear min_notional (a floor-snap can dip under)", () => {
  // $10 of a $60 asset with tick 0.001: raw 0.1667 → floor 0.166 → $9.96 < $10 → ceil to 0.167
  const q = snapQty(10 / 60, 0.001, 0.001, 10, 60);
  assert.ok(q * 60 >= 10, "value clears min_notional");
  assert.equal(q, 0.167);
});

test("snapQty respects base_min and returns 0 on bad input", () => {
  assert.equal(snapQty(0.0001, 0.001, 0.01, 0, 0), 0.01, "lifts to base_min");
  assert.equal(snapQty(0, 0.001, 0.001, 0, 0), 0);
  assert.equal(snapQty(1, 0, 0, 0, 0), 0, "no base_tick → 0");
});

test("makerPrice joins the correct side of the book", () => {
  assert.equal(makerPrice("BUY", 99, 101), 99, "buy rests on the bid");
  assert.equal(makerPrice("SELL", 99, 101), 101, "sell rests on the ask");
});

const MI = {
  BTC: { baseTick: 0.001, baseMin: 0.001, minNotional: 10, bestBid: 60000, bestAsk: 60010 },
  SOL: { baseTick: 0.01, baseMin: 0.01, minNotional: 10, bestBid: 150, bestAsk: 150.2 },
};

test("planOrders OPEN long → BUY POST_ONLY at the bid, not reduce-only", () => {
  const orders = [{ symbol: "BTC", action: "OPEN", side: 1 }];
  const target = [{ symbol: "BTC", sector: "L1", side: 1, notional: 83 }];
  const [spec] = planOrders(orders, [], target, MI);
  assert.equal(spec.side, "BUY");
  assert.equal(spec.price, 60000, "rests on the bid");
  assert.equal(spec.orderType, "POST_ONLY");
  assert.equal(spec.reduceOnly, false);
  assert.ok(spec.qty > 0 && spec.qty * spec.price >= 10);
});

test("planOrders OPEN short → SELL at the ask", () => {
  const [spec] = planOrders([{ symbol: "SOL", action: "OPEN", side: -1 }], [], [{ symbol: "SOL", side: -1, notional: 83 }], MI);
  assert.equal(spec.side, "SELL");
  assert.equal(spec.price, 150.2, "rests on the ask");
  assert.equal(spec.reduceOnly, false);
});

test("planOrders CLOSE a long → SELL reduce-only at the ask, sized to the held leg", () => {
  const current = [{ symbol: "BTC", sector: "L1", side: 1, notional: 83 }];
  const [spec] = planOrders([{ symbol: "BTC", action: "CLOSE", side: 1 }], current, [], MI);
  assert.equal(spec.side, "SELL");
  assert.equal(spec.reduceOnly, true);
  assert.equal(spec.reason, "CLOSE");
});

test("planOrders FLIP long→short → single SELL of ~2× leg notional (through zero)", () => {
  const current = [{ symbol: "SOL", side: 1, notional: 83 }];
  const target = [{ symbol: "SOL", side: -1, notional: 83 }];
  const [spec] = planOrders([{ symbol: "SOL", action: "FLIP", from: 1, to: -1 }], current, target, MI);
  assert.equal(spec.side, "SELL");
  assert.equal(spec.reduceOnly, false, "flip crosses zero — not reduce-only");
  // ~2*83/150.2 ≈ 1.105 SOL
  assert.ok(Math.abs(spec.qty - (2 * 83) / 150.2) < 0.02, "sized to close + open");
});

test("planOrders skips a leg with no market data instead of sending a blind order", () => {
  const specs = planOrders([{ symbol: "WIF", action: "OPEN", side: 1 }], [], [{ symbol: "WIF", side: 1, notional: 83 }], MI);
  assert.equal(specs[0].skip, "no_market_data");
});

test("planIsBalanced accepts a neutral book and rejects a skewed one", () => {
  const neutral = [{ side: 1, notional: 83 }, { side: -1, notional: 83 }, { side: 1, notional: 83 }, { side: -1, notional: 83 }];
  assert.ok(planIsBalanced(neutral).balanced);
  const skewed = [{ side: 1, notional: 83 }, { side: 1, notional: 83 }, { side: -1, notional: 83 }];
  assert.ok(!planIsBalanced(skewed).balanced, "2 longs vs 1 short is a directional bet — abort");
});
