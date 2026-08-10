// Coaching-loop tests. Run: node --test app/lib/coaching.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { recordFlag, coachingInsight } from "./coaching.mjs";

const DAY = 86400000;
const now = 1_700_000_000_000;

test("recordFlag: appends, normalizes symbol, dedupes per symbol|dir|day", () => {
  let s = recordFlag([], { symbol: "PERP_BTC_USDC", direction: "SHORT" }, now);
  assert.equal(s.length, 1);
  assert.equal(s[0].symbol, "BTC");
  s = recordFlag(s, { symbol: "BTC", direction: "SHORT" }, now + 100); // same day → no dup
  assert.equal(s.length, 1);
  s = recordFlag(s, { symbol: "BTC", direction: "SHORT" }, now + DAY); // next day → new
  assert.equal(s.length, 2);
});

test("recordFlag: rejects malformed setups + prunes >30d", () => {
  assert.equal(recordFlag([], { symbol: "", direction: "SHORT" }, now).length, 0);
  assert.equal(recordFlag([], { symbol: "BTC", direction: "SIDEWAYS" }, now).length, 0);
  const old = [{ symbol: "ETH", direction: "LONG", ts: now - 40 * DAY }];
  const s = recordFlag(old, { symbol: "BTC", direction: "LONG" }, now);
  assert.equal(s.length, 1); // the 40d-old one pruned
  assert.equal(s[0].symbol, "BTC");
});

test("coachingInsight: counts taken vs skipped + sums taken PnL", () => {
  const flags = [
    { symbol: "BTC", direction: "SHORT", ts: now - 5 * DAY },
    { symbol: "ETH", direction: "LONG", ts: now - 4 * DAY },
    { symbol: "SOL", direction: "SHORT", ts: now - 3 * DAY },
  ];
  const trades = [
    { symbol: "PERP_BTC_USDC", direction: "SHORT", pnl: 120, timestamp: now - 5 * DAY + 3600000 }, // taken (in window)
    { symbol: "PERP_ETH_USDC", direction: "LONG", pnl: -40, timestamp: now - 4 * DAY + 10 * DAY },  // too late → skipped
  ];
  const r = coachingInsight(flags, trades, now);
  assert.equal(r.flags, 3);
  assert.equal(r.taken, 1);
  assert.equal(r.skipped, 2);
  assert.equal(r.takenPnl, 120);
  assert.equal(r.rate, 33);
});

test("coachingInsight: null below the minimum flag sample", () => {
  assert.equal(coachingInsight([{ symbol: "BTC", direction: "SHORT", ts: now }], [], now), null);
});
