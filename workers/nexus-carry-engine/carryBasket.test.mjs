// node --test workers/nexus-carry-engine/carryBasket.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTargetBook, diffBook, legFundingPnl, legPricePnl, bookIsNeutral,
  sectorMap, bareTicker, SECTORS, DEFAULT_CARRY_CONFIG,
} from "./carryBasket.mjs";

const SM = sectorMap();

test("bareTicker normalizes full symbols and bare tickers", () => {
  assert.equal(bareTicker("PERP_BTC_USDC"), "BTC");
  assert.equal(bareTicker("BTC"), "BTC");
});

test("buildTargetBook P1: within each sector, long most-negative funding, short most-positive", () => {
  // L1 sector only, contrived funding
  const funding = { BTC: -0.02, ETH: 0.01, SOL: 0.03, BNB: 0.0 };
  const { legs } = buildTargetBook(funding, SM, { perSide: 1 });
  const long = legs.find((l) => l.side === 1);
  const short = legs.find((l) => l.side === -1);
  assert.equal(long.symbol, "BTC", "most-negative funding is the long");
  assert.equal(short.symbol, "SOL", "most-positive funding is the short");
  assert.equal(legs.length, 2, "P1 in one sector = one long + one short");
});

test("buildTargetBook is dollar-neutral overall and per-sector; notional sums to capital", () => {
  const funding = {
    BTC: -0.02, ETH: 0.02,            // L1
    AAVE: -0.03, UNI: 0.03,           // DEFI
    DOGE: -0.01, WIF: 0.04,           // MEME
  };
  const book = buildTargetBook(funding, SM, { perSide: 1, capital: 1200 });
  assert.equal(book.legs.length, 6, "3 sectors × 2 legs");
  assert.equal(book.notionalPerLeg, 200, "1200 / 6 legs");
  const sum = book.legs.reduce((a, l) => a + Math.abs(l.notional), 0);
  assert.equal(sum, 1200, "book notional equals capital");
  const chk = bookIsNeutral(book.legs);
  assert.ok(chk.neutral, "neutral overall and within each sector");
});

test("buildTargetBook skips a sector with fewer than 2*P names", () => {
  const funding = { BTC: -0.02, ETH: 0.02, TAO: 0.05 }; // AI has only 1 name present
  const book = buildTargetBook(funding, SM, { perSide: 1 });
  assert.ok(!book.sectorsUsed.includes("AI"), "AI sector skipped (1 name < 2)");
  assert.ok(book.skipped.some((s) => s.sector === "AI" && s.reason === "too_few_names"));
});

test("buildTargetBook P2 takes two names per side per sector when available", () => {
  const funding = { BTC: -0.03, ETH: -0.02, SOL: 0.02, BNB: 0.03, AVAX: 0.0 };
  const book = buildTargetBook(funding, SM, { perSide: 2 });
  const longs = book.legs.filter((l) => l.side === 1).map((l) => l.symbol).sort();
  const shorts = book.legs.filter((l) => l.side === -1).map((l) => l.symbol).sort();
  assert.deepEqual(longs, ["BTC", "ETH"], "two most-negative are longs");
  assert.deepEqual(shorts, ["BNB", "SOL"], "two most-positive are shorts");
});

test("minFundingSpread gate skips a sector whose extreme spread is too thin", () => {
  const funding = { BTC: 0.0001, ETH: 0.0002, SOL: 0.0003 }; // tiny spread in L1
  const gated = buildTargetBook(funding, SM, { perSide: 1, minFundingSpread: 0.001 });
  assert.equal(gated.legs.length, 0, "thin-spread sector produces no legs");
  assert.ok(gated.skipped.some((s) => s.reason === "spread_too_thin"));
  const ungated = buildTargetBook(funding, SM, { perSide: 1, minFundingSpread: 0 });
  assert.equal(ungated.legs.length, 2, "no gate → legs form");
});

test("buildTargetBook ignores null/NaN funding and unknown tickers", () => {
  const funding = { BTC: -0.02, ETH: 0.02, FOOBAR: 0.9, SOL: null, BNB: NaN };
  const book = buildTargetBook(funding, SM, { perSide: 1 });
  const syms = book.legs.map((l) => l.symbol);
  assert.ok(!syms.includes("FOOBAR"), "unknown ticker ignored");
  assert.ok(!syms.includes("SOL"), "null funding ignored");
  assert.ok(!syms.includes("BNB"), "NaN funding ignored");
  assert.deepEqual(syms.sort(), ["BTC", "ETH"]);
});

test("diffBook emits OPEN, CLOSE, and FLIP correctly", () => {
  const current = [{ symbol: "BTC", side: 1 }, { symbol: "ETH", side: -1 }, { symbol: "SOL", side: 1 }];
  const target = [{ symbol: "BTC", side: 1 }, { symbol: "ETH", side: 1 }, { symbol: "DOGE", side: -1 }];
  const orders = diffBook(current, target);
  const by = Object.fromEntries(orders.map((o) => [o.symbol, o]));
  assert.equal(by.BTC, undefined, "unchanged leg → no order");
  assert.equal(by.ETH.action, "FLIP", "ETH short→long is a FLIP");
  assert.equal(by.SOL.action, "CLOSE", "SOL dropped from book → CLOSE");
  assert.equal(by.DOGE.action, "OPEN", "DOGE new → OPEN");
});

test("legFundingPnl: longs profit from negative funding, shorts from positive", () => {
  // long, funding −0.01/8h, 24h (3 periods), $1000 → +$30
  assert.equal(legFundingPnl(1, -0.01, 24, 1000), 30);
  // short, funding +0.01/8h, 24h, $1000 → +$30
  assert.equal(legFundingPnl(-1, 0.01, 24, 1000), 30);
  // long paying positive funding loses
  assert.equal(legFundingPnl(1, 0.01, 8, 1000), -10);
});

test("legPricePnl is signed and NaN-safe on bad entry", () => {
  assert.equal(legPricePnl(1, 100, 110, 1000), 100);   // long +10% on $1000
  assert.equal(legPricePnl(-1, 100, 110, 1000), -100); // short −10%
  assert.equal(legPricePnl(1, 0, 110, 1000), 0);       // bad entry → 0, no NaN
});

test("bookIsNeutral flags a book that is NOT sector-neutral", () => {
  const skewed = [
    { symbol: "BTC", sector: "L1", side: 1, notional: 100 },
    { symbol: "ETH", sector: "L1", side: 1, notional: 100 }, // two longs, no short → sector not neutral
  ];
  assert.ok(!bookIsNeutral(skewed).neutral);
});

test("DEFAULT_CARRY_CONFIG encodes the validated settings", () => {
  assert.equal(DEFAULT_CARRY_CONFIG.perSide, 1, "P1 is the carry-dominant setting");
  assert.equal(DEFAULT_CARRY_CONFIG.execution, "MAKER", "maker execution is mandatory");
  assert.equal(DEFAULT_CARRY_CONFIG.rebalanceHours, 24);
});

test("full 6-sector book from realistic universe forms 12 neutral legs", () => {
  const funding = {};
  // give every universe name a random-ish deterministic funding so all 6 sectors populate
  let i = 0;
  for (const arr of Object.values(SECTORS)) for (const t of arr) funding[t] = Math.sin(i++) * 0.02;
  const book = buildTargetBook(funding, SM, { perSide: 1, capital: 1000 });
  assert.equal(book.sectorsUsed.length, 6, "all six sectors present");
  assert.equal(book.legs.length, 12, "6 sectors × (1 long + 1 short)");
  assert.ok(bookIsNeutral(book.legs).neutral, "the 12-leg book is fully neutral");
});
