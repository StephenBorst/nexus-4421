import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSignal } from "./logic.mjs";

// raw helper: funding in decimal, changes in decimal
const raw = (o) => ({ fundingRate: 0, priceChange: 0, oiChange: 0, hasPrev: true, ...o });

test("CONFLUENCE: both agree (funding SHORT + OI SHORT) → SHORT conf 80", () => {
  // funding +0.02% >= 0.01% → SHORT; price up + OI down → SHORT
  const s = deriveSignal(raw({ fundingRate: 0.0002, priceChange: 0.01, oiChange: -0.01 }), { signalMode: "CONFLUENCE", fundingThreshold: 0.01 });
  assert.equal(s.direction, "SHORT");
  assert.equal(s.confidence, 80);
});

test("CONFLUENCE: signals conflict → NONE", () => {
  // funding SHORT, but price down + OI up → LONG
  const s = deriveSignal(raw({ fundingRate: 0.0002, priceChange: -0.01, oiChange: 0.01 }), { signalMode: "CONFLUENCE", fundingThreshold: 0.01 });
  assert.equal(s.direction, "NONE");
});

test("CONFLUENCE: only funding fires → NONE (needs both)", () => {
  const s = deriveSignal(raw({ fundingRate: 0.0002, priceChange: 0, oiChange: 0 }), { signalMode: "CONFLUENCE", fundingThreshold: 0.01 });
  assert.equal(s.direction, "NONE");
});

test("FUNDING_ONLY: funding fires alone → trades, conf 65", () => {
  const s = deriveSignal(raw({ fundingRate: -0.0002, priceChange: 0, oiChange: 0 }), { signalMode: "FUNDING_ONLY", fundingThreshold: 0.01 });
  assert.equal(s.direction, "LONG"); // negative funding → LONG
  assert.equal(s.confidence, 65);
});

test("OI_ONLY: OI fires alone → trades; funding ignored", () => {
  const s = deriveSignal(raw({ fundingRate: 0, priceChange: 0.01, oiChange: 0.01 }), { signalMode: "OI_ONLY" });
  assert.equal(s.direction, "LONG"); // price up + OI up → follow → LONG
  assert.equal(s.confidence, 65);
});

test("MOMENTUM: price up over threshold → LONG (trade with the move)", () => {
  const s = deriveSignal(raw({ priceChange: 0.01 }), { signalMode: "MOMENTUM", priceChangeThreshold: 0.5 });
  assert.equal(s.direction, "LONG");
  assert.equal(s.confidence, 60);
});

test("MOMENTUM: price down over threshold → SHORT", () => {
  const s = deriveSignal(raw({ priceChange: -0.01 }), { signalMode: "MOMENTUM", priceChangeThreshold: 0.5 });
  assert.equal(s.direction, "SHORT");
});

test("MEAN_REVERSION: price up over threshold → SHORT (fade)", () => {
  const s = deriveSignal(raw({ priceChange: 0.01 }), { signalMode: "MEAN_REVERSION", priceChangeThreshold: 0.5 });
  assert.equal(s.direction, "SHORT");
  assert.equal(s.confidence, 60);
});

test("MOMENTUM/MEAN_REVERSION: move below threshold → NONE", () => {
  // 0.2% move < 0.5% threshold
  assert.equal(deriveSignal(raw({ priceChange: 0.002 }), { signalMode: "MOMENTUM", priceChangeThreshold: 0.5 }).direction, "NONE");
  assert.equal(deriveSignal(raw({ priceChange: 0.002 }), { signalMode: "MEAN_REVERSION", priceChangeThreshold: 0.5 }).direction, "NONE");
});

test("MOMENTUM: no prior snapshot → NONE", () => {
  assert.equal(deriveSignal(raw({ priceChange: 0.01, hasPrev: false }), { signalMode: "MOMENTUM", priceChangeThreshold: 0.5 }).direction, "NONE");
});

test("fundingThreshold respected: below threshold → no funding signal", () => {
  // funding 0.005% < 0.01% threshold
  const s = deriveSignal(raw({ fundingRate: 0.00005, priceChange: 0.01, oiChange: -0.01 }), { signalMode: "CONFLUENCE", fundingThreshold: 0.01 });
  assert.equal(s.direction, "NONE"); // funding doesn't fire → no confluence
});

test("oiChangeThreshold respected: tiny OI move ignored", () => {
  // oiChange 0.05% < 0.1% threshold → OI signal suppressed
  const s = deriveSignal(raw({ fundingRate: 0.0002, priceChange: 0.01, oiChange: 0.0005 }), { signalMode: "CONFLUENCE", fundingThreshold: 0.01, oiChangeThreshold: 0.1 });
  assert.equal(s.direction, "NONE");
});

test("no prior snapshot (hasPrev false) → OI signal can't fire", () => {
  const s = deriveSignal(raw({ fundingRate: 0.0002, priceChange: 0.01, oiChange: -0.01, hasPrev: false }), { signalMode: "CONFLUENCE", fundingThreshold: 0.01 });
  assert.equal(s.direction, "NONE");
});

test("default config = CONFLUENCE behavior", () => {
  const s = deriveSignal(raw({ fundingRate: 0.0002, priceChange: 0.01, oiChange: -0.01 }), {});
  assert.equal(s.direction, "SHORT");
  assert.equal(s.confidence, 80);
});
