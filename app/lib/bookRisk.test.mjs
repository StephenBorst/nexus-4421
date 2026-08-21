import { test } from "node:test";
import assert from "node:assert";
import { bookConcentration, sectorOf, bareTicker } from "./bookRisk.mjs";

test("sectorOf / bareTicker map symbols to sectors", () => {
  assert.equal(bareTicker("PERP_BTC_USDC"), "BTC");
  assert.equal(sectorOf("PERP_BTC_USDC"), "L1");
  assert.equal(sectorOf("WIF"), "MEME");
  assert.equal(sectorOf("ZZZ"), "OTHER");
});

test("flags a long L1 book as one correlated bet", () => {
  const r = bookConcentration([
    { symbol: "BTC", direction: "LONG" },
    { symbol: "ETH", direction: "LONG" },
    { symbol: "SOL", direction: "LONG" },
  ]);
  assert.ok(r, "expected a concentration read");
  assert.equal(r.kind, "sector");
  assert.equal(r.topSector.name, "L1");
  assert.equal(r.topSector.side, "LONG");
  assert.equal(r.topSector.pct, 100);
  assert.equal(r.netPct, 100, "all one side");
});

test("notional-weighting: one huge position dominates a diversified-looking book", () => {
  const r = bookConcentration([
    { symbol: "BTC", direction: "LONG", notional: 9000 },
    { symbol: "DOGE", direction: "LONG", notional: 300 },
    { symbol: "XRP", direction: "SHORT", notional: 300 },
  ]);
  assert.ok(r, "expected a read");
  assert.equal(r.weighted, true, "weighted by notional");
  // net = 9000 + 300 - 300 = 9000 of 9600 gross → 94% net long
  assert.ok(r.netPct >= 90);
});

test("a genuinely hedged / mixed book does NOT fire", () => {
  const r = bookConcentration([
    { symbol: "BTC", direction: "LONG", notional: 1000 },   // L1 long
    { symbol: "ETH", direction: "SHORT", notional: 1000 },  // L1 short → sector not one-way
    { symbol: "WIF", direction: "LONG", notional: 1000 },   // MEME
    { symbol: "AAVE", direction: "SHORT", notional: 1000 }, // DEFI
  ]);
  assert.equal(r, null, "balanced book has no concentration story");
});

test("flags a lopsided directional book even across sectors", () => {
  const r = bookConcentration([
    { symbol: "BTC", direction: "SHORT", notional: 1000 },
    { symbol: "WIF", direction: "SHORT", notional: 1000 },
    { symbol: "AAVE", direction: "SHORT", notional: 1000 },
  ]);
  assert.ok(r, "expected a read");
  assert.equal(r.kind, "directional"); // one position per sector → the directional rule catches the one-way book
  assert.equal(r.netSide, "SHORT");
  assert.equal(r.netPct, 100);
});

test("null on a book smaller than the minimum", () => {
  assert.equal(bookConcentration([{ symbol: "BTC", direction: "LONG" }, { symbol: "ETH", direction: "SHORT" }]), null);
});

test("accepts numeric side and PERP_ symbols", () => {
  const r = bookConcentration([
    { symbol: "PERP_BTC_USDC", side: 1 },
    { symbol: "PERP_ETH_USDC", side: 1 },
    { symbol: "PERP_SOL_USDC", side: 1 },
  ]);
  assert.ok(r);
  assert.equal(r.topSector.name, "L1");
});
