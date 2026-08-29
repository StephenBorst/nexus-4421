import { test } from "node:test";
import assert from "node:assert";
import { rankConviction, convictionLevel, FADE_FUNDING_FLOOR_PCT_YR } from "./conviction.mjs";

test("rankConviction drops sub-floor funding — a trivial band is not a fade candidate", () => {
  const markets = [
    { coin: "HYPE", direction: "LONG", fundingAnnualPct: -27 },  // real fade
    { coin: "ZEC", direction: "LONG", fundingAnnualPct: -0.66 }, // trivial → filtered
    { coin: "SOL", direction: "LONG", fundingAnnualPct: -4.86 }, // under 10% → filtered
  ];
  const ranked = rankConviction(markets, {}, {});
  const coins = ranked.map((r) => r.coin);
  assert.ok(coins.includes("HYPE"));
  assert.ok(!coins.includes("ZEC"));
  assert.ok(!coins.includes("SOL"));
  assert.equal(FADE_FUNDING_FLOOR_PCT_YR, 10);
});

test("rankConviction tallies agreement and ranks by net confirmation", () => {
  const markets = [
    { coin: "PERP_BTC_USDC", direction: "SHORT", fundingAnnualPct: 40 },
    { coin: "ETH", direction: "SHORT", fundingAnnualPct: 80 },   // funding-only, bigger edge
    { coin: "SOL", direction: "LONG", fundingAnnualPct: 30 },
  ];
  const sm = { BTC: { side: "SHORT" }, SOL: { side: "SHORT" } };       // BTC confirms, SOL opposes
  const callers = { BTC: { side: "SHORT" } };                          // BTC also confirms
  const ranked = rankConviction(markets, sm, callers);
  assert.equal(ranked[0].coin, "BTC");      // 2 confirmations → ranks first
  assert.equal(ranked[0].extra, 2);
  assert.equal(ranked[0].against, 0);
  const sol = ranked.find((r) => r.coin === "SOL");
  assert.equal(sol.against, 1);             // smart opposes the SOL long
});

test("convictionLevel maps net confirmations to a label", () => {
  assert.equal(convictionLevel({ extra: 2, against: 0 }), "HIGH");
  assert.equal(convictionLevel({ extra: 1, against: 0 }), "MODERATE");
  assert.equal(convictionLevel({ extra: 0, against: 1 }), "CONFLICTED");
  assert.equal(convictionLevel({ extra: 0, against: 0 }), "FUNDING_ONLY");
  // A weak reversion clock docks conviction — aligned lenses over a losing hist can't read HIGH.
  assert.equal(convictionLevel({ extra: 2, against: 0, histWeak: true }), "FUNDING_ONLY");
  assert.equal(convictionLevel({ extra: 0, against: 2, histWeak: true }), "CONFLICTED");
});
