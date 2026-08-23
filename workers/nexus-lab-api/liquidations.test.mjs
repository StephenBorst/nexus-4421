import { test } from "node:test";
import assert from "node:assert";
import { coinToInstFamily, aggregateLiquidations, classifyFlush, computeLevels } from "./liquidations.mjs";

test("coinToInstFamily maps our perp coins to OKX USDT swaps", () => {
  assert.equal(coinToInstFamily("PERP_BTC_USDC"), "BTC-USDT");
  assert.equal(coinToInstFamily("eth"), "ETH-USDT");
  assert.equal(coinToInstFamily(""), null);
});

test("aggregateLiquidations sums by side within the window, ignores stale/bad rows", () => {
  const now = Date.now();
  const details = [
    { posSide: "long", sz: "10", bkPx: "100", ts: now - 1000 },   // 1000 down-flush
    { posSide: "short", sz: "5", bkPx: "200", ts: now - 2000 },   // 1000 up-squeeze
    { posSide: "long", sz: "2", bkPx: "50", ts: now - 999999999 }, // stale → ignored
    { posSide: "long", sz: "0", bkPx: "100", ts: now },            // zero size → ignored
  ];
  const r = aggregateLiquidations(details, now - 60000);
  assert.equal(r.longMag, 1000);
  assert.equal(r.shortMag, 1000);
  assert.equal(r.count, 2);
});

test("computeLevels buckets liquidations by price, ranks by magnitude", () => {
  const now = Date.now();
  const details = [
    { posSide: "long", sz: "100", bkPx: "70000", ts: now - 1000 },  // big cluster ~70k (longs → DOWN)
    { posSide: "long", sz: "50", bkPx: "70050", ts: now - 2000 },   // same bucket (0.3% wide)
    { posSide: "short", sz: "10", bkPx: "80000", ts: now - 3000 },  // smaller cluster ~80k (shorts → UP)
    { posSide: "long", sz: "1", bkPx: "70000", ts: now - 999999999 }, // stale → ignored
  ];
  const levels = computeLevels(details, now - 60000, 0.3, 4);
  assert.ok(levels.length >= 2);
  assert.equal(levels[0].side, "DOWN");       // biggest cluster is the 70k longs
  assert.ok(levels[0].mag > levels[1].mag);   // ranked by magnitude
});

test("classifyFlush needs enough history and a real spike", () => {
  const hist = Array.from({ length: 20 }, () => ({ longMag: 100, shortMag: 100 }));
  assert.equal(classifyFlush(hist, { longMag: 120, shortMag: 90 }), null); // no spike
  const down = classifyFlush(hist, { longMag: 500, shortMag: 90 });        // 5x long median
  assert.equal(down.side, "DOWN");
  assert.ok(down.ratio >= 2.5);
  const up = classifyFlush(hist, { longMag: 90, shortMag: 400 });
  assert.equal(up.side, "UP");
  assert.equal(classifyFlush([], { longMag: 999, shortMag: 0 }), null);    // too little history
});
