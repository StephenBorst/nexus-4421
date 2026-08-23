import { test } from "node:test";
import assert from "node:assert";
import { rankConviction, convictionLevel } from "./conviction.mjs";

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
});
