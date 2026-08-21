import { test } from "node:test";
import assert from "node:assert";
import { smartLeanByCoin, fusePositioning, positioningRead } from "./positioning.mjs";

const trader = (address, positions) => ({ address, positions });
const mkt = (coin, direction, status, fundingAnnualPct) => ({ coin, direction, status, fundingAnnualPct, edge: Math.abs(fundingAnnualPct) });

test("smartLeanByCoin: dominant side by trader count, needs a cluster, drops ties", () => {
  const board = [
    trader("0xa", [{ coin: "BTC", side: "LONG", szUsd: 5000 }]),
    trader("0xb", [{ coin: "BTC", side: "LONG", szUsd: 3000 }]),
    trader("0xc", [{ coin: "BTC", side: "SHORT", szUsd: 9000 }]), // more $ but fewer traders
    trader("0xd", [{ coin: "SOL", side: "LONG", szUsd: 1000 }]),  // only 1 trader → no cluster
  ];
  const m = smartLeanByCoin(board);
  assert.equal(m.get("BTC").side, "LONG", "2 long traders beat 1 short trader even with less $");
  assert.equal(m.get("BTC").traders, 3);
  assert.equal(m.has("SOL"), false, "single-trader coin has no lean");
});

test("smartLeanByCoin: an even trader count is broken by dollars", () => {
  const board = [
    trader("0xa", [{ coin: "ETH", side: "LONG", szUsd: 10000 }]),
    trader("0xb", [{ coin: "ETH", side: "LONG", szUsd: 8000 }]),
    trader("0xc", [{ coin: "ETH", side: "SHORT", szUsd: 3000 }]),
    trader("0xd", [{ coin: "ETH", side: "SHORT", szUsd: 2000 }]),
  ];
  assert.equal(smartLeanByCoin(board).get("ETH").side, "LONG", "2v2 tie → more dollars wins");
});

test("fusePositioning: CONFLUENCE when the fade and the smart money agree", () => {
  // crowd over-short BTC → fade LONG ; smart money also LONG
  const mispriced = [mkt("BTC", "LONG", "MISPRICED", -22)];
  const board = [trader("0xa", [{ coin: "BTC", side: "LONG", szUsd: 5000 }]), trader("0xb", [{ coin: "BTC", side: "LONG", szUsd: 4000 }])];
  const rows = fusePositioning(mispriced, board);
  assert.equal(rows[0].coin, "BTC");
  assert.equal(rows[0].verdict, "CONFLUENCE");
  assert.equal(rows[0].crowdFade, "LONG");
  assert.equal(rows[0].smartSide, "LONG");
  assert.match(positioningRead(rows[0]), /both point long/);
});

test("fusePositioning: SPLIT when the smart money is with the crowd", () => {
  // crowd over-short SOL → fade LONG ; but smart money is SHORT (with the crowd)
  const mispriced = [mkt("SOL", "LONG", "MISPRICED", -17)];
  const board = [trader("0xa", [{ coin: "SOL", side: "SHORT", szUsd: 5000 }]), trader("0xb", [{ coin: "SOL", side: "SHORT", szUsd: 4000 }])];
  const rows = fusePositioning(mispriced, board);
  assert.equal(rows[0].verdict, "SPLIT");
  assert.match(positioningRead(rows[0]), /contested/);
});

test("fusePositioning: CROWD-only and SMART-only singles", () => {
  const mispriced = [mkt("XRP", "SHORT", "MISPRICED", 30), mkt("DOGE", "NONE", "PRICED_FAIR", 1)];
  const board = [trader("0xa", [{ coin: "DOGE", side: "LONG", szUsd: 2000 }]), trader("0xb", [{ coin: "DOGE", side: "LONG", szUsd: 2000 }])];
  const rows = fusePositioning(mispriced, board);
  const xrp = rows.find((r) => r.coin === "XRP");
  const doge = rows.find((r) => r.coin === "DOGE");
  assert.equal(xrp.verdict, "CROWD", "mispriced but no smart cluster");
  assert.equal(doge.verdict, "SMART", "smart lean but priced-fair funding");
});

test("fusePositioning ranks CONFLUENCE above SPLIT above singles", () => {
  const mispriced = [mkt("BTC", "LONG", "MISPRICED", -22), mkt("SOL", "LONG", "MISPRICED", -17), mkt("XRP", "SHORT", "MISPRICED", 30)];
  const board = [
    trader("0xa", [{ coin: "BTC", side: "LONG", szUsd: 5000 }, { coin: "SOL", side: "SHORT", szUsd: 5000 }]),
    trader("0xb", [{ coin: "BTC", side: "LONG", szUsd: 4000 }, { coin: "SOL", side: "SHORT", szUsd: 4000 }]),
  ];
  const rows = fusePositioning(mispriced, board);
  assert.equal(rows[0].verdict, "CONFLUENCE"); // BTC
  assert.equal(rows[1].verdict, "SPLIT");       // SOL
  assert.equal(rows[2].verdict, "CROWD");       // XRP (no smart cluster)
});

test("fusePositioning is empty-safe", () => {
  assert.deepEqual(fusePositioning(null, null), []);
  assert.deepEqual(fusePositioning([], []), []);
});
