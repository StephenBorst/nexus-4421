import { test } from "node:test";
import assert from "node:assert";
import { coinToSpot, computeBasisPct, aggregateCvd, classifyBasis, computeImbalance, classifyOrderbook, parseDeribitInstrument, computeSkew, classifySkew, computeTermStructure } from "./flow.mjs";

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

test("parseDeribitInstrument parses expiry/strike/type", () => {
  const p = parseDeribitInstrument("BTC-25JUN27-150000-P");
  assert.equal(p.strike, 150000);
  assert.equal(p.type, "P");
  assert.ok(p.expiry > Date.UTC(2027, 0, 1));
  assert.equal(parseDeribitInstrument("garbage"), null);
});

test("computeSkew: nearest expiry 10%-OTM put−call IV", () => {
  const now = Date.now();
  const exp = now + 10 * 86400000;
  const u = 100000;
  const rows = [
    { expiry: exp, strike: 90000, type: "P", iv: 60, underlying: u }, // 10% OTM put
    { expiry: exp, strike: 80000, type: "P", iv: 70, underlying: u },
    { expiry: exp, strike: 95000, type: "P", iv: 55, underlying: u },
    { expiry: exp, strike: 110000, type: "C", iv: 50, underlying: u }, // 10% OTM call
    { expiry: exp, strike: 120000, type: "C", iv: 45, underlying: u },
    { expiry: exp, strike: 105000, type: "C", iv: 52, underlying: u },
  ];
  const s = computeSkew(rows, now);
  assert.equal(s.skew, 10);   // 60 (put) − 50 (call)
  assert.equal(s.days, 10);
});

test("computeTermStructure: front>back = backwardation (stress), front<back = contango", () => {
  const now = Date.now();
  const u = 100000;
  const front = now + 3 * 86400000, back = now + 30 * 86400000;
  // backwardation: front ATM IV 80 > back ATM IV 60
  const bw = [
    { expiry: front, strike: 100000, type: "C", iv: 80, underlying: u },
    { expiry: front, strike: 95000, type: "P", iv: 82, underlying: u },
    { expiry: front, strike: 105000, type: "C", iv: 79, underlying: u },
    { expiry: back, strike: 100000, type: "C", iv: 60, underlying: u },
    { expiry: back, strike: 95000, type: "P", iv: 61, underlying: u },
    { expiry: back, strike: 105000, type: "C", iv: 59, underlying: u },
  ];
  const t = computeTermStructure(bw, now);
  assert.equal(t.structure, "backwardation");
  assert.ok(t.ratio > 1.05);
  assert.equal(computeTermStructure([], now), null);
});

test("classifySkew: extreme vs own history → fear LONG / greed SHORT", () => {
  const hist = Array.from({ length: 20 }, () => ({ skew: 5 }));
  assert.equal(classifySkew(hist, 5), null);       // at its norm
  assert.equal(classifySkew(hist, 10).side, "LONG");  // +5 vs median = more fear → LONG
  assert.equal(classifySkew(hist, 0).side, "SHORT");  // less fear/more greed → SHORT
  assert.equal(classifySkew([], 99), null);        // too little history
});
