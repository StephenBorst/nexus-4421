// Trustless call-grading tests for nexus-lab-api.
// Run: node --test workers/nexus-lab-api/logic.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { gradeCall } from "./logic.mjs";

// Helper: candle series starting at t0 (sec), each 1h apart.
const series = (t0, bars) => ({
  t: bars.map((_, i) => t0 + i * 3600),
  h: bars.map((b) => b.h),
  l: bars.map((b) => b.l),
});

const baseLong = { direction: "LONG", entryPrice: 100, stopLoss: 95, takeProfit1: 110, riskReward: 2, createdAt: 1_000_000 * 1000 };
const t0 = 1_000_000; // sec == createdAt/1000

test("LONG win: high reaches TP1 first → +R", () => {
  const cd = series(t0, [{ h: 105, l: 99 }, { h: 111, l: 104 }]);
  const g = gradeCall(baseLong, cd);
  assert.equal(g.outcome, "WIN");
  assert.equal(g.r, 2);
});

test("LONG loss: low hits SL first → -1R", () => {
  const cd = series(t0, [{ h: 102, l: 94 }, { h: 111, l: 100 }]);
  const g = gradeCall(baseLong, cd);
  assert.equal(g.outcome, "LOSS");
  assert.equal(g.r, -1);
});

test("same-candle TP+SL = LOSS (conservative)", () => {
  const cd = series(t0, [{ h: 111, l: 94 }]); // both touched in one bar
  assert.equal(gradeCall(baseLong, cd).outcome, "LOSS");
});

test("first-touch ordering respected across bars", () => {
  // SL bar comes before TP bar → LOSS even though TP later reached
  const cd = series(t0, [{ h: 101, l: 94 }, { h: 120, l: 100 }]);
  assert.equal(gradeCall(baseLong, cd).outcome, "LOSS");
});

test("candles before the call timestamp are ignored", () => {
  // Pre-call bar would have hit SL, but it's before createdAt → ignored; later TP wins
  const cd = { t: [t0 - 7200, t0 - 3600, t0, t0 + 3600], h: [90, 90, 105, 111], l: [80, 80, 99, 104] };
  assert.equal(gradeCall(baseLong, cd).outcome, "WIN");
});

test("PENDING when neither level touched", () => {
  const cd = series(t0, [{ h: 108, l: 96 }, { h: 109, l: 97 }]);
  assert.equal(gradeCall(baseLong, cd).outcome, "PENDING");
});

test("SHORT is inverted (low=TP, high=SL)", () => {
  const short = { direction: "SHORT", entryPrice: 100, stopLoss: 105, takeProfit1: 90, riskReward: 1.5, createdAt: t0 * 1000 };
  assert.equal(gradeCall(short, series(t0, [{ h: 101, l: 89 }])).outcome, "WIN"); // low hit TP
  assert.equal(gradeCall(short, series(t0, [{ h: 106, l: 99 }])).outcome, "LOSS"); // high hit SL
  assert.equal(gradeCall(short, series(t0, [{ h: 106, l: 89 }])).outcome, "LOSS"); // same-candle → loss
});

test("INVALID on missing levels or candles", () => {
  assert.equal(gradeCall({ ...baseLong, takeProfit1: 0 }, series(t0, [{ h: 111, l: 99 }])).outcome, "INVALID");
  assert.equal(gradeCall(baseLong, null).outcome, "INVALID");
});

test("default R is 1 when riskReward missing/invalid", () => {
  const noRR = { direction: "LONG", entryPrice: 100, stopLoss: 95, takeProfit1: 110, createdAt: t0 * 1000 };
  assert.equal(gradeCall(noRR, series(t0, [{ h: 111, l: 99 }])).r, 1);
});

// ── verifyErc20Payment (PRO subscription rail) ──────────────
import { verifyErc20Payment, ERC20_TRANSFER_TOPIC } from "./logic.mjs";

const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const RECV = "0x06cD9c281E6ab09906B46a10e059F2770EfdE49A";
const PAYER = "0x1111111111111111111111111111111111111111";
const toTopic = (a) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const mkReceipt = (over = {}) => ({
  status: "0x1",
  logs: [{
    address: USDC,
    topics: [ERC20_TRANSFER_TOPIC, toTopic(PAYER), toTopic(RECV)],
    data: "0x" + (20n * 1000000n).toString(16), // 20 USDC (6 decimals)
  }],
  ...over,
});
const MIN = 198n * 100000n; // 19.8 USDC

test("verifyErc20Payment: valid 20 USDC transfer to receiver → ok + payer", () => {
  const v = verifyErc20Payment(mkReceipt(), { token: USDC, receiver: RECV, minAmount: MIN });
  assert.equal(v.ok, true);
  assert.equal(v.from, PAYER.toLowerCase());
});

test("verifyErc20Payment: failed tx → not ok", () => {
  const v = verifyErc20Payment(mkReceipt({ status: "0x0" }), { token: USDC, receiver: RECV, minAmount: MIN });
  assert.equal(v.ok, false);
});

test("verifyErc20Payment: amount below min → not ok", () => {
  const logs = [{ address: USDC, topics: [ERC20_TRANSFER_TOPIC, toTopic(PAYER), toTopic(RECV)], data: "0x" + (5n * 1000000n).toString(16) }];
  const v = verifyErc20Payment({ status: "0x1", logs }, { token: USDC, receiver: RECV, minAmount: MIN });
  assert.equal(v.ok, false);
});

test("verifyErc20Payment: transfer to a DIFFERENT receiver → not ok", () => {
  const other = "0x9999999999999999999999999999999999999999";
  const logs = [{ address: USDC, topics: [ERC20_TRANSFER_TOPIC, toTopic(PAYER), toTopic(other)], data: "0x" + (20n * 1000000n).toString(16) }];
  const v = verifyErc20Payment({ status: "0x1", logs }, { token: USDC, receiver: RECV, minAmount: MIN });
  assert.equal(v.ok, false);
});

test("verifyErc20Payment: wrong token contract → not ok", () => {
  const logs = [{ address: "0xdead000000000000000000000000000000000000", topics: [ERC20_TRANSFER_TOPIC, toTopic(PAYER), toTopic(RECV)], data: "0x" + (20n * 1000000n).toString(16) }];
  const v = verifyErc20Payment({ status: "0x1", logs }, { token: USDC, receiver: RECV, minAmount: MIN });
  assert.equal(v.ok, false);
});
