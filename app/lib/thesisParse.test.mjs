import { test } from "node:test";
import assert from "node:assert/strict";
import { parseThesis } from "./thesisParse.mjs";

test("empty input → all null, no fields filled", () => {
  const r = parseThesis("");
  assert.equal(r.symbol, null);
  assert.equal(r.direction, null);
  assert.deepEqual(r.filled, []);
});

test("symbol: TICKER+quote form (ZECUSD, ETH/USDT, BTC-USD)", () => {
  assert.equal(parseThesis("ZECUSD has survived the CHoCH").symbol, "ZEC");
  assert.equal(parseThesis("watching ETH/USDT here").symbol, "ETH");
  assert.equal(parseThesis("BTC-USD reclaim").symbol, "BTC");
});

test("symbol: cashtag and 'long TICKER'", () => {
  assert.equal(parseThesis("accumulating $SOL on dips").symbol, "SOL");
  assert.equal(parseThesis("going long ARB into the range").symbol, "ARB");
});

test("symbol: does not return the quote currency itself", () => {
  // "USD" alone must never be mistaken for the base ticker.
  assert.notEqual(parseThesis("price in USD terms").symbol, "USD");
});

test("direction: explicit bias wins", () => {
  assert.equal(parseThesis("The structure is now net bullish on the daily").direction, "LONG");
  assert.equal(parseThesis("this is a short entry at resistance").direction, "SHORT");
});

test("direction: keyword tally", () => {
  assert.equal(parseThesis("bearish OB, breakdown likely, sell rallies").direction, "SHORT");
  assert.equal(parseThesis("no clear bias either way").direction, null);
});

test("prices: keyword-anchored entry/stop/target", () => {
  const r = parseThesis("Entry $100, stop below $90, target $130 and second target $150");
  assert.equal(r.entryPrice, "100");
  assert.equal(r.stopLoss, "90");
  assert.equal(r.takeProfit1, "130");
  assert.equal(r.takeProfit2, "150");
});

test("prices: ignores %, leverage, hours, indicator readings", () => {
  const r = parseThesis("ADX 21.69, up 3.5% at 5x with 72h funding, entry $95000");
  assert.equal(r.entryPrice, "95000");
  assert.equal(r.stopLoss, null); // nothing spurious grabbed
});

test("prices: handles $ ranges (takes the near bound)", () => {
  const r = parseThesis("stop below $415, first target the supply zone $624–$685");
  assert.equal(r.stopLoss, "415");
  assert.equal(r.takeProfit1, "624");
});

test("prices: strips commas", () => {
  assert.equal(parseThesis("entry $1,850 stop $1,700").entryPrice, "1850");
});

test("real TradingView thesis (ZECUSD from the screenshot)", () => {
  const blob = `ZECUSD has survived the bearish CHoCH at $486.89 that defined our last analysis — it flushed to $252, reclaimed, and printed a new HH at $588. The structure is now net bullish on the daily. The current pullback to the $452 golden pocket, with daily Stochastics deeply oversold at 11.4 and the monthly macro still printing Strong Buy, is the highest-probability long entry since the Jun low. The $541 level is the trigger — a close above it confirms the weekly flip, and the bearish OB at $624–$685 is the first major supply zone to clear. Until then, accumulate the golden pocket, stop below $415, and let the monthly trend do the heavy lifting.`;
  const r = parseThesis(blob);
  assert.equal(r.symbol, "ZEC");
  assert.equal(r.direction, "LONG");
  assert.equal(r.stopLoss, "415");          // "stop below $415"
  assert.equal(r.takeProfit1, "624");       // trailing "supply zone $624–$685"
  assert.equal(r.takeProfit2, "685");       // far bound of the range
  assert.ok(r.notes.length > 50);           // full text preserved for the trader
  // Entry here ("the $452 golden pocket") is genuinely ambiguous prose — the parser
  // is conservative and leaves it for the trader rather than guessing wrong.
  assert.ok(r.filled.includes("symbol") && r.filled.includes("direction") &&
            r.filled.includes("stop") && r.filled.includes("target"));
});
