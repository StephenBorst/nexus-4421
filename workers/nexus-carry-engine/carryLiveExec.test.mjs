// node --test workers/nexus-carry-engine/carryLiveExec.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { positionsToLegs, openOrderIds } from "./carryLiveExec.mjs";

test("positionsToLegs parses signed qty into side + notional, skipping flat/dust", () => {
  const rows = [
    { symbol: "PERP_BTC_USDC", position_qty: "0.01", mark_price: "60000" },   // long, $600
    { symbol: "PERP_ETH_USDC", position_qty: "-0.5", mark_price: "3000" },    // short, $1500
    { symbol: "PERP_SOL_USDC", position_qty: "0", mark_price: "150" },        // flat → skip
    { symbol: "PERP_DOGE_USDC", position_qty: "0.001", mark_price: "0.12" },  // dust ($0.00012) → skip
  ];
  const legs = positionsToLegs(rows);
  assert.equal(legs.length, 2);
  const btc = legs.find((l) => l.symbol === "BTC");
  const eth = legs.find((l) => l.symbol === "ETH");
  assert.equal(btc.side, 1);
  assert.equal(Math.round(btc.notional), 600);
  assert.equal(eth.side, -1, "negative qty → short");
  assert.equal(Math.round(eth.notional), 1500);
});

test("positionsToLegs falls back to average_open_price and is safe on junk", () => {
  const legs = positionsToLegs([
    { symbol: "PERP_INJ_USDC", position_qty: "2", average_open_price: "25" }, // no mark → avg
    { symbol: "PERP_X_USDC", position_qty: "abc", mark_price: "1" },          // NaN qty → skip
    {},
  ]);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].symbol, "INJ");
  assert.equal(Math.round(legs[0].notional), 50);
});

test("openOrderIds extracts {symbol, orderId}, ignoring malformed rows", () => {
  const ids = openOrderIds([
    { order_id: 111, symbol: "PERP_BTC_USDC" },
    { order_id: 222, symbol: "PERP_ETH_USDC" },
    { symbol: "PERP_SOL_USDC" }, // no id → ignored
    null,
  ]);
  assert.deepEqual(ids, [{ symbol: "PERP_BTC_USDC", orderId: 111 }, { symbol: "PERP_ETH_USDC", orderId: 222 }]);
});

test("runLive is disarmed without CARRY_LIVE (no network touched)", async () => {
  const { runLive } = await import("./carryLiveExec.mjs");
  const res = await runLive({ CARRY_LIVE: "false" }, { funding: {}, mark: {} });
  assert.deepEqual(res, { skipped: "disarmed" });
});

test("runLive armed but keyless refuses before any call", async () => {
  const { runLive } = await import("./carryLiveExec.mjs");
  const res = await runLive({ CARRY_LIVE: "true", CARRY: { get: async () => null } }, { funding: {}, mark: {} });
  assert.deepEqual(res, { skipped: "no_key" });
});

test("runLive respects the kill switch before trading", async () => {
  const { runLive } = await import("./carryLiveExec.mjs");
  const env = { CARRY_LIVE: "true", CARRY_TRADING_KEY: "k", CARRY_ACCOUNT_ID: "a", CARRY: { get: async (k) => (k === "carry:kill" ? "1" : null) } };
  const res = await runLive(env, { funding: {}, mark: {} });
  assert.deepEqual(res, { skipped: "killed" });
});
