// Execution-adherence tests. Run: node --test app/lib/adherence.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { baseTicker, matchThesisToTrade, scoreAdherence, adherenceReport } from "./adherence.mjs";

const HOUR = 3600 * 1000;
const NOW = 1_700_000_000_000;

// Plan: LONG BTC, entry 100, stop 95 (risk 5), target 110. $10k account, 1% risk
// → planned risk $100, planned notional $2,000 (20 units at 100).
const plan = (over = {}) => ({
  id: "t1", symbol: "BTC", direction: "LONG", entryPrice: 100, stopLoss: 95, takeProfit1: 110,
  accountSize: 10000, riskPercent: 1, positionSize: 2000, createdAt: NOW, ...over,
});

// The fill that followed the plan exactly: 20 units at 100, out at 110 for +$200.
const fill = (over = {}) => ({
  symbol: "PERP_BTC_USDC", direction: "LONG", entryPrice: 100, price: 110, qty: 20,
  pnl: 200, openTimestamp: NOW + HOUR, timestamp: NOW + 5 * HOUR, ...over,
});

test("baseTicker: normalizes fill symbols to the thesis's bare ticker", () => {
  assert.equal(baseTicker("PERP_BTC_USDC"), "BTC");
  assert.equal(baseTicker("btc"), "BTC");
  assert.equal(baseTicker("ETH-USD"), "ETH");
  assert.equal(baseTicker("PERP_1000PEPE_USDC"), "1000PEPE");
  assert.equal(baseTicker(null), "");
});

// ── matching ────────────────────────────────────────────────────────

test("match: pairs the thesis with the fill in the same market and direction", () => {
  assert.ok(matchThesisToTrade(plan(), [fill()]));
});

test("match: refuses a different market or the opposite direction", () => {
  assert.equal(matchThesisToTrade(plan(), [fill({ symbol: "PERP_ETH_USDC" })]), null);
  assert.equal(matchThesisToTrade(plan(), [fill({ direction: "SHORT" })]), null);
});

test("match: refuses fills outside the window (before the call, or long after)", () => {
  assert.equal(matchThesisToTrade(plan(), [fill({ openTimestamp: NOW - 6 * HOUR })]), null);
  assert.equal(matchThesisToTrade(plan(), [fill({ openTimestamp: NOW + 100 * HOUR })]), null);
});

test("match: a fill just BEFORE the writeup still counts (sized in, then posted)", () => {
  assert.ok(matchThesisToTrade(plan(), [fill({ openTimestamp: NOW - 10 * 60 * 1000 })]));
});

test("match: picks the earliest candidate when several qualify", () => {
  const later = fill({ openTimestamp: NOW + 10 * HOUR, entryPrice: 105 });
  const earlier = fill({ openTimestamp: NOW + HOUR, entryPrice: 100 });
  assert.equal(matchThesisToTrade(plan(), [later, earlier]).entryPrice, 100);
});

test("match: no fills → null, not a guess", () => {
  assert.equal(matchThesisToTrade(plan(), []), null);
  assert.equal(matchThesisToTrade(plan(), null), null);
  assert.equal(matchThesisToTrade(null, [fill()]), null);
});

// ── scoring ─────────────────────────────────────────────────────────

test("score: a trade that followed the plan scores 100 with no flags", () => {
  const s = scoreAdherence(plan(), fill());
  assert.deepEqual(s.flags, []);
  assert.equal(s.score, 100);
});

test("score: STOP_BLOWN when the realized loss exceeds planned risk", () => {
  // planned risk $100; lost $350
  const s = scoreAdherence(plan(), fill({ pnl: -350, price: 82 }));
  assert.ok(s.flags.includes("STOP_BLOWN"));
  assert.equal(s.costUsd.STOP_BLOWN, 250); // the excess beyond the plan
  assert.equal(s.score, 60);
});

test("score: a loss WITHIN planned risk is not a violation — that's the stop working", () => {
  const s = scoreAdherence(plan(), fill({ pnl: -95, price: 95.2 }));
  assert.ok(!s.flags.includes("STOP_BLOWN"));
  assert.equal(s.score, 100);
});

test("score: small overrun inside tolerance is not flagged", () => {
  const s = scoreAdherence(plan(), fill({ pnl: -110, price: 94.5 })); // 1.1x planned
  assert.ok(!s.flags.includes("STOP_BLOWN"));
});

test("score: OVERSIZED and UNDERSIZED are separate, and weighted differently", () => {
  const over = scoreAdherence(plan(), fill({ qty: 40 }));  // 2x planned notional
  const under = scoreAdherence(plan(), fill({ qty: 8 }));  // 0.4x
  assert.ok(over.flags.includes("OVERSIZED"));
  assert.equal(over.components.sizeRatio, 2);
  assert.ok(under.flags.includes("UNDERSIZED"));
  assert.ok(over.score < under.score); // risking too much costs more than too little
});

test("score: size within tolerance is not flagged", () => {
  const s = scoreAdherence(plan(), fill({ qty: 22 })); // 1.1x
  assert.ok(!s.flags.some((f) => f === "OVERSIZED" || f === "UNDERSIZED"));
});

test("score: ENTRY_DRIFT when the fill is far off the planned level", () => {
  // risk distance is 5; filled 4 away = 0.8R off
  const s = scoreAdherence(plan(), fill({ entryPrice: 104 }));
  assert.ok(s.flags.includes("ENTRY_DRIFT"));
  assert.equal(s.components.entryOffR, 0.8);
});

test("score: a fill near the planned level is clean", () => {
  assert.ok(!scoreAdherence(plan(), fill({ entryPrice: 101 })).flags.includes("ENTRY_DRIFT"));
});

test("score: EXIT_EARLY prices the money left on the table", () => {
  // target 110 (reward 10/unit); banked at 102 = 20% of the way, 8/unit x 20 units
  const s = scoreAdherence(plan(), fill({ price: 102, pnl: 40 }));
  assert.ok(s.flags.includes("EXIT_EARLY"));
  assert.equal(s.components.targetCaptured, 0.2);
  assert.equal(s.costUsd.EXIT_EARLY, 160);
});

test("score: EXIT_EARLY never fires on a loss (that's the stop, not impatience)", () => {
  const s = scoreAdherence(plan(), fill({ price: 96, pnl: -80 }));
  assert.ok(!s.flags.includes("EXIT_EARLY"));
});

test("score: shorts invert the capture calculation", () => {
  const shortPlan = plan({ direction: "SHORT", entryPrice: 100, stopLoss: 105, takeProfit1: 90 });
  const shortFill = fill({ direction: "SHORT", entryPrice: 100, price: 98, pnl: 40 });
  const s = scoreAdherence(shortPlan, shortFill);
  assert.equal(s.components.targetCaptured, 0.2); // 2 of 10 captured
  assert.ok(s.flags.includes("EXIT_EARLY"));
  // a short that ran to target is clean
  assert.deepEqual(scoreAdherence(shortPlan, fill({ direction: "SHORT", entryPrice: 100, price: 90, pnl: 200 })).flags, []);
});

test("score: flags compound and the score floors at 0", () => {
  const s = scoreAdherence(plan(), fill({ qty: 60, entryPrice: 106, price: 80, pnl: -1500 }));
  assert.ok(s.flags.includes("STOP_BLOWN") && s.flags.includes("OVERSIZED") && s.flags.includes("ENTRY_DRIFT"));
  assert.ok(s.score >= 0);
});

test("score: unscoreable plans return null instead of a fabricated verdict", () => {
  assert.equal(scoreAdherence(plan({ stopLoss: 100 }), fill()), null); // zero risk distance
  assert.equal(scoreAdherence(plan({ entryPrice: 0 }), fill()), null);
  assert.equal(scoreAdherence(plan(), null), null);
});

test("score: a plan without account/risk skips the stop check but still scores the rest", () => {
  const s = scoreAdherence(plan({ accountSize: 0, riskPercent: 0 }), fill({ pnl: -900, price: 60 }));
  assert.ok(!s.flags.includes("STOP_BLOWN"));
  assert.equal(s.components.plannedRiskUsd, undefined);
});

// ── report ──────────────────────────────────────────────────────────

test("report: names the leak that cost the most money, not the most frequent one", () => {
  const theses = [
    plan({ id: "a", createdAt: NOW }),
    plan({ id: "b", createdAt: NOW + 200 * HOUR }),
    plan({ id: "c", createdAt: NOW + 400 * HOUR }),
  ];
  const trades = [
    // one expensive stop overrun ($400 excess)
    fill({ openTimestamp: NOW + HOUR, pnl: -500, price: 75 }),
    // two cheap early exits ($40 each) — more frequent, far less costly
    fill({ openTimestamp: NOW + 201 * HOUR, price: 102, pnl: 40, qty: 5 }),
    fill({ openTimestamp: NOW + 401 * HOUR, price: 102, pnl: 40, qty: 5 }),
  ];
  const rep = adherenceReport(theses, trades);
  assert.equal(rep.matched, 3);
  assert.equal(rep.flagCounts.EXIT_EARLY, 2);
  assert.equal(rep.flagCounts.STOP_BLOWN, 1);
  assert.equal(rep.topLeak.flag, "STOP_BLOWN");
  assert.equal(rep.topLeak.costUsd, 400);
  assert.equal(rep.costUsd.EXIT_EARLY, 80);
});

test("report: counts theses that were never traded as unmatched, not as failures", () => {
  const rep = adherenceReport([plan({ id: "a" }), plan({ id: "b", symbol: "SOL" })], [fill()]);
  assert.equal(rep.matched, 1);
  assert.equal(rep.unmatched, 1);
  assert.equal(rep.score, 100); // the untraded call doesn't drag the score down
});

test("report: empty input is an honest empty report, not a zero score", () => {
  const rep = adherenceReport([], []);
  assert.equal(rep.matched, 0);
  assert.equal(rep.score, null);
  assert.equal(rep.topLeak, null);
});

test("report: rows come back newest-first", () => {
  const theses = [plan({ id: "old", createdAt: NOW }), plan({ id: "new", createdAt: NOW + 300 * HOUR })];
  const trades = [fill({ openTimestamp: NOW + HOUR }), fill({ openTimestamp: NOW + 301 * HOUR })];
  assert.equal(adherenceReport(theses, trades).rows[0].id, "new");
});
