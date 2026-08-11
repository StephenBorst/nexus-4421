// Signal-synthesis tests. Run: node --test app/lib/signals.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildSignals, countUnseen } from "./signals.mjs";

const sig = (symbol, f) => ({ symbol, funding_rate_8h: f });

test("buildSignals: funding + crowd agree → high-priority FADE_ALIGN", () => {
  const out = buildSignals({ signals: [sig("BTC", 0.0006)], consensus: { BTC: { side: "SHORT" } } });
  assert.equal(out[0].kind, "FADE_ALIGN");
  assert.equal(out[0].id, "fade-align-BTC-SHORT");
  assert.match(out[0].title, /fade short/);
});

test("buildSignals: funding vs callers disagree → DIVERGENCE", () => {
  const out = buildSignals({ signals: [sig("BTC", 0.0006)], consensus: { BTC: { side: "LONG" } } });
  assert.equal(out[0].kind, "DIVERGENCE");
});

test("buildSignals: no crowd data → plain FUNDING signal", () => {
  const out = buildSignals({ signals: [sig("SOL", -0.0005)], consensus: null });
  assert.equal(out[0].kind, "FUNDING");
  // neg funding → crowd is short → the fade is LONG.
  assert.match(out[0].detail, /crowd is heavily short/);
  assert.match(out[0].detail, /short is where a long fade/);
});

test("buildSignals: ignores funding below the stretch threshold", () => {
  assert.deepEqual(buildSignals({ signals: [sig("BTC", 0.0001)] }), []);
});

test("buildSignals: tier events get stable per-day ids and sort under fades", () => {
  const ts = 1_700_000_000_000;
  const out = buildSignals({ signals: [sig("BTC", 0.0006)], consensus: { BTC: { side: "SHORT" } }, xrayEvents: [{ wallet: "0xAbC0000000000000000000000000000000000000", kind: "TIER_UP", toTier: "CONSISTENT", ts }] });
  const tier = out.find((s) => s.kind === "TIER");
  assert.ok(tier);
  assert.equal(tier.id, `tier-0xabc0000000000000000000000000000000000000-CONSISTENT-${Math.floor(ts / 86400000)}`);
  assert.ok(out[0].kind === "FADE_ALIGN"); // fade outranks the tier event
});

test("countUnseen: counts only ids not in the seen set", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(countUnseen(list, new Set(["a"])), 2);
  assert.equal(countUnseen(list, { a: 1, b: 1, c: 1 }), 0);
  assert.equal(countUnseen(list, {}), 3);
});

test("buildSignals: a strong OI-confirmed trend surfaces a MOMENTUM signal (ride it)", () => {
  const out = buildSignals({ signals: [{ symbol: "BTC", funding_rate_8h: 0.0001, trend: "TREND_UP", trend_move_pct: 6.2, trend_oi_pct: 3.4 }] });
  const mom = out.find((s) => s.kind === "MOMENTUM");
  assert.ok(mom, "expected a MOMENTUM signal");
  assert.equal(mom.id, "mom-BTC-LONG");
  assert.match(mom.title, /long momentum/);
  assert.match(mom.detail, /open interest rising/);
});

test("buildSignals: a trend on FLAT/falling OI is NOT momentum (squeeze, not conviction)", () => {
  const out = buildSignals({ signals: [{ symbol: "BTC", funding_rate_8h: 0.0001, trend: "TREND_UP", trend_move_pct: 6.2, trend_oi_pct: 0.2 }] });
  assert.equal(out.find((s) => s.kind === "MOMENTUM"), undefined);
});

test("buildSignals: CHOP / no trend → no momentum signal", () => {
  const out = buildSignals({ signals: [{ symbol: "BTC", funding_rate_8h: 0.0001, trend: "CHOP", trend_move_pct: 0.2, trend_oi_pct: 5 }] });
  assert.equal(out.find((s) => s.kind === "MOMENTUM"), undefined);
});

test("buildSignals: momentum funding cross-check — crowded funding flags a LATE ride", () => {
  const clean = buildSignals({ signals: [{ symbol: "BTC", funding_rate_8h: 0.0001, trend: "TREND_UP", trend_move_pct: 6, trend_oi_pct: 3 }] }).find((s) => s.kind === "MOMENTUM");
  assert.match(clean.detail, /room to run/);
  assert.ok(!/late/i.test(clean.title));
  const late = buildSignals({ signals: [{ symbol: "BTC", funding_rate_8h: 0.0009, trend: "TREND_UP", trend_move_pct: 6, trend_oi_pct: 3 }] }).find((s) => s.kind === "MOMENTUM");
  assert.match(late.title, /\(late\)/);
  assert.match(late.detail, /crowded long/);
});
