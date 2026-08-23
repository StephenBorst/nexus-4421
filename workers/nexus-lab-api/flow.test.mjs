import { test } from "node:test";
import assert from "node:assert";
import { coinToSpot, computeBasisPct, aggregateCvd, classifyBasis, computeImbalance, classifyOrderbook } from "./flow.mjs";

test("coinToSpot maps to OKX USDT spot", () => {
  assert.equal(coinToSpot("PERP_BTC_USDC"), "BTC-USDT");
  assert.equal(coinToSpot("eth"), "ETH-USDT");
  assert.equal(coinToSpot(""), null);
});

test("computeBasisPct: perp premium positive, discount negative, bad ticks null", () => {
  assert.equal(computeBasisPct(100, 100.5), 0.5);   // 0.5% premium
  assert.equal(computeBasisPct(100, 99.5), -0.5);   // discount
  assert.equal(computeBasisPct(0, 100), null);      // bad spot
  assert.equal(computeBasisPct(100, 200), null);    // >10% = bad data
});

test("aggregateCvd: buy − sell notional within window", () => {
  const now = Date.now();
  const trades = [
    { side: "buy", sz: "2", px: "100", ts: now - 1000 },   // +200
    { side: "sell", sz: "1", px: "100", ts: now - 2000 },  // -100
    { side: "buy", sz: "1", px: "100", ts: now - 999999 }, // stale (window 60s) → ignored
  ];
  const r = aggregateCvd(trades, now - 60000);
  assert.equal(r.buy, 200);
  assert.equal(r.sell, 100);
  assert.equal(r.cvd, 100);
  assert.equal(r.count, 2);
});

test("classifyBasis: premium → SHORT, discount → LONG, flat → null", () => {
  assert.equal(classifyBasis(0.1).side, "SHORT");
  assert.equal(classifyBasis(-0.1).side, "LONG");
  assert.equal(classifyBasis(0.01), null); // below the 0.03% threshold
  assert.equal(classifyBasis(null), null);
});

test("computeImbalance: bid-heavy positive, ask-heavy negative", () => {
  // rows: [price, size, _, orders]
  const imb = computeImbalance([["100", "10"]], [["100", "2"]]); // 1000 bid vs 200 ask
  assert.ok(imb > 0.6 && imb <= 1);
  assert.ok(computeImbalance([["100", "1"]], [["100", "9"]]) < 0); // ask-heavy
  assert.equal(computeImbalance([], []), null);
});

test("classifyOrderbook: decisive lean only (|imb| >= 0.35)", () => {
  assert.equal(classifyOrderbook(0.5).side, "LONG");   // bid-heavy → support
  assert.equal(classifyOrderbook(-0.5).side, "SHORT"); // ask-heavy → resistance
  assert.equal(classifyOrderbook(0.2), null);          // too balanced
  assert.equal(classifyOrderbook(null), null);
});
