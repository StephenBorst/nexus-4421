// node --test workers/nexus-carry-engine/carryLive.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotFromFutures, coverage } from "./carryLive.mjs";

const rows = [
  { symbol: "PERP_BTC_USDC", mark_price: "65000", last_funding_rate: "-0.00012" },
  { symbol: "PERP_ETH_USDC", mark_price: "3200", last_funding_rate: "0.00008" },
  { symbol: "PERP_SOL_USDC", mark_price: "150", est_funding_rate: "0.0002" }, // fallback to est
  { symbol: "PERP_DOGE_USDC", mark_price: "0.12", last_funding_rate: "-0.0001" },
  { symbol: "PERP_WIF_USDC", mark_price: "2.1", last_funding_rate: "0.0003" },
  { symbol: "PERP_NAS100_USDC", mark_price: "20000", last_funding_rate: "0.0" }, // index perp, not in universe
  { symbol: "PERP_ZZZ_USDC", mark_price: "1", last_funding_rate: "0.001" },       // unknown ticker
  { symbol: "PERP_LINK_USDC", mark_price: "0", last_funding_rate: "0.0001" },     // bad mark → dropped
  { symbol: "PERP_AAVE_USDC", mark_price: "90", last_funding_rate: null },        // no funding → dropped
];

test("snapshotFromFutures keeps universe names with a valid mark + funding", () => {
  const snap = snapshotFromFutures(rows);
  assert.deepEqual(Object.keys(snap.mark).sort(), ["BTC", "DOGE", "ETH", "SOL", "WIF"]);
  assert.equal(snap.funding.BTC, -0.00012);
  assert.equal(snap.funding.SOL, 0.0002, "est_funding_rate used when last is absent");
  assert.equal(snap.mark.ETH, 3200);
});

test("snapshotFromFutures drops index perps, unknown tickers, bad marks, and missing funding", () => {
  const snap = snapshotFromFutures(rows);
  assert.ok(!("NAS100" in snap.funding), "index perp excluded from universe");
  assert.ok(!("ZZZ" in snap.funding), "unknown ticker excluded");
  assert.ok(!("LINK" in snap.funding), "zero mark dropped");
  assert.ok(!("AAVE" in snap.funding), "null funding dropped");
});

test("snapshotFromFutures is safe on empty / garbage input", () => {
  assert.deepEqual(snapshotFromFutures(null), { funding: {}, mark: {} });
  assert.deepEqual(snapshotFromFutures([{}, { symbol: "BTCUSD" }]), { funding: {}, mark: {} });
});

test("coverage counts names and tradable sectors (≥2 names)", () => {
  const snap = snapshotFromFutures(rows);
  const cov = coverage(snap);
  assert.equal(cov.names, 5);
  // L1: BTC,ETH,SOL (3) ; MEME: DOGE,WIF (2) → both tradable
  assert.equal(cov.perSector.L1, 3);
  assert.equal(cov.perSector.MEME, 2);
  assert.equal(cov.tradableSectors, 2);
});
