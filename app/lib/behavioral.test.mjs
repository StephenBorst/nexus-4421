import { test } from "node:test";
import assert from "node:assert";
import { tiltRead, sessionEdge } from "./behavioral.mjs";

const HOUR = 3600000, DAY = 86400000;
const base = Date.UTC(2026, 7, 3, 3, 0, 0); // 03:00 UTC = Asia

test("tiltRead fires when after-loss trades underperform", () => {
  // 10 wins then a 6-loss block → after-loss trades are all losses (0%) vs ~62% overall.
  const trades = [];
  for (let i = 0; i < 10; i++) trades.push({ pnl: 50, timestamp: base + i * HOUR });
  for (let i = 0; i < 6; i++) trades.push({ pnl: -40, timestamp: base + (10 + i) * HOUR });
  const r = tiltRead(trades);
  assert.ok(r, "expected a tilt read");
  assert.equal(r.afterLossWr, 0);
  assert.ok(r.baselineWr > r.afterLossWr + 12);
  assert.equal(r.n, 5); // the 2nd..6th loss follow a loss
});

test("tiltRead is null when after-loss trades are fine", () => {
  const trades = [];
  for (let i = 0; i < 16; i++) trades.push({ pnl: i % 2 === 0 ? 50 : -40, timestamp: base + i * HOUR });
  assert.equal(tiltRead(trades), null);
});

test("tiltRead needs >=8 trades and >=5 after-loss", () => {
  const trades = [{ pnl: -1, timestamp: base }, { pnl: -1, timestamp: base + HOUR }, { pnl: -1, timestamp: base + 2 * HOUR }];
  assert.equal(tiltRead(trades), null);
});

test("sessionEdge fires when one session pays and another bleeds", () => {
  const trades = [];
  for (let i = 0; i < 5; i++) trades.push({ pnl: 60, timestamp: base + i * DAY });              // Asia winners
  for (let i = 0; i < 5; i++) trades.push({ pnl: -50, timestamp: base + i * DAY + 15 * HOUR });  // US losers (18:00 UTC)
  const r = sessionEdge(trades);
  assert.ok(r, "expected a session read");
  assert.equal(r.best.name, "Asia");
  assert.equal(r.worst.name, "US");
  assert.ok(r.best.net > 0 && r.worst.net < 0);
});

test("sessionEdge needs >=2 populated sessions", () => {
  const trades = [];
  for (let i = 0; i < 6; i++) trades.push({ pnl: 10, timestamp: base + i * DAY }); // all Asia
  assert.equal(sessionEdge(trades), null);
});

test("sessionEdge null when no session is net-negative", () => {
  const trades = [];
  for (let i = 0; i < 5; i++) trades.push({ pnl: 60, timestamp: base + i * DAY });
  for (let i = 0; i < 5; i++) trades.push({ pnl: 30, timestamp: base + i * DAY + 15 * HOUR }); // US also positive
  assert.equal(sessionEdge(trades), null);
});
