// Operator-profile synthesis tests. Run: node --test app/lib/operatorProfile.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOperatorProfile, deriveArchetype, medianHoldHours, buildHeadline,
  buildUnlocks, profileNarrative, PUBLIC_READS,
} from "./operatorProfile.mjs";

const HOUR = 3600000;
const T0 = 1_700_000_000_000; // a real epoch — 0 legitimately means "no timestamp"
const trade = (over = {}) => ({ symbol: "PERP_BTC_USDC", pnl: 100, openTimestamp: T0, timestamp: T0 + 4 * HOUR, ...over });

// A rich, established record: fat-tail trend-follower with an expensive leak.
const fullProcess = {
  calls: 30, hitRate: 41, avgR: 0.6,
  expectancy: { expectancy: 0.6, profitFactor: 1.8, tailRatio: 0.62, avgWinR: 2.4, avgLossR: 1 },
  regimeEdges: {
    trend: { dimension: "trend", best: { bucket: "trend:TREND_UP", avgR: 1.2, calls: 12 }, worst: { bucket: "trend:CHOP", avgR: -0.8, calls: 9 }, gapR: 2 },
    align: { dimension: "align", best: { bucket: "align:WITH_TREND", avgR: 1.1, calls: 14 }, worst: { bucket: "align:AGAINST_TREND", avgR: -0.5, calls: 8 }, gapR: 1.6 },
    vol: null,
  },
  discipline: { score: 78, scored: 30, flagCounts: { LATE_ENTRY: 12 }, topFlag: { flag: "LATE_ENTRY", count: 12, rate: 40 } },
  calibration: { calibrated: true, inverted: false, gap: 0.7, highN: 15, lowN: 15 },
  meritRank: { tier: "SHARP", title: "Sharp", glyph: "◆" },
};
const fullEdge = { closed_trades: 40, best_symbol: { symbol: "BTC", trades: 20, pnl: 3000 }, worst_symbol: { symbol: "DOGE", trades: 8, pnl: -900 } };
const fullAdherence = { matched: 12, topLeak: { flag: "EXIT_EARLY", costUsd: 1240, count: 6 } };
const fullLeaks = { tagged: 8, top: { reason: "OVERSIZED", costUsd: 400, count: 3 } };
const fullTrades = Array.from({ length: 40 }, () => trade());

// ── hold time / archetype ───────────────────────────────────────────

test("medianHoldHours: median of realized hold times, ignoring unusable rows", () => {
  assert.equal(medianHoldHours([
    trade({ timestamp: T0 + 2 * HOUR }),
    trade({ timestamp: T0 + 4 * HOUR }),
    trade({ timestamp: T0 + 6 * HOUR }),
    trade({ timestamp: 0 }),                          // no close → ignored
    trade({ openTimestamp: T0 + 5 * HOUR, timestamp: T0 + HOUR }), // closes before open → ignored
    trade({ openTimestamp: 0 }),                      // no open (0 is missing, not epoch) → ignored
  ]), 4);
  assert.equal(medianHoldHours([]), null);
  assert.equal(medianHoldHours(null), null);
});

test("archetype: fat-tail + trend-follower + horizon, each axis evidence-gated", () => {
  const a = deriveArchetype({ regimeEdges: fullProcess.regimeEdges, expectancy: fullProcess.expectancy, holdHours: 4 });
  assert.match(a.label, /Fat-tail/);
  assert.match(a.label, /trend-follower/);
  assert.equal(a.horizon, "intraday");
});

test("archetype: a counter-trend record is labelled as such, not flattered into trend", () => {
  const a = deriveArchetype({
    regimeEdges: { align: { best: { bucket: "align:AGAINST_TREND", avgR: 0.9, calls: 11 }, worst: { bucket: "align:WITH_TREND", avgR: -0.3, calls: 7 } } },
    holdHours: 100,
  });
  assert.match(a.label, /counter-trend/i);
  assert.equal(a.horizon, "position");
});

test("archetype: grinders (symmetric payoff) are distinguished from fat tails", () => {
  const a = deriveArchetype({ expectancy: { tailRatio: 0.2, avgWinR: 1, avgLossR: 1 }, holdHours: 20 });
  assert.match(a.label, /Grinder/i);
  assert.equal(a.horizon, "swing");
});

test("archetype: axes with no evidence are omitted, never guessed", () => {
  // thin alignment sample (< 5 calls) must not produce a 'trend-follower' claim
  const a = deriveArchetype({
    regimeEdges: { align: { best: { bucket: "align:WITH_TREND", avgR: 3, calls: 2 } } },
    holdHours: 10,
  });
  assert.ok(!/trend-follower/.test(a.label));
  assert.equal(deriveArchetype({}), null);
});

// ── reads + ordering ────────────────────────────────────────────────

test("profile: composes every available read", () => {
  const p = buildOperatorProfile({ process: fullProcess, edge: fullEdge, adherence: fullAdherence, leaks: fullLeaks, trades: fullTrades });
  const kinds = p.reads.map((r) => r.kind);
  for (const k of ["MONEY_LEAK", "REGIME", "PAYOFF", "DISCIPLINE", "CALIBRATION", "SYMBOL"]) {
    assert.ok(kinds.includes(k), `missing ${k}`);
  }
  assert.equal(p.tier, "ESTABLISHED");
});

test("profile: the money leak leads, and takes the COSTLIEST source", () => {
  const p = buildOperatorProfile({ process: fullProcess, edge: fullEdge, adherence: fullAdherence, leaks: fullLeaks, trades: fullTrades });
  assert.equal(p.reads[0].kind, "MONEY_LEAK");
  assert.equal(p.reads[0].key, "EXIT_EARLY"); // $1240 adherence beats $400 postmortem
  assert.equal(p.reads[0].costUsd, 1240);
});

test("profile: inverted sizing is escalated to top severity", () => {
  const p = buildOperatorProfile({
    process: { ...fullProcess, calibration: { calibrated: false, inverted: true, gap: -0.9, highN: 10, lowN: 10 } },
    trades: fullTrades,
  });
  const cal = p.reads.find((r) => r.kind === "CALIBRATION");
  assert.equal(cal.severity, 3);
  assert.match(cal.text, /wrong way/);
});

test("profile: the low-hit-rate lesson is stated explicitly", () => {
  const p = buildOperatorProfile({ process: fullProcess, trades: fullTrades });
  const payoff = p.reads.find((r) => r.kind === "PAYOFF");
  assert.match(payoff.text, /41% hit rate/);
  assert.match(payoff.text, /wins carry you/);
});

test("profile: every read is stamped with provenance, and PUBLIC_READS excludes private ones", () => {
  const p = buildOperatorProfile({ process: fullProcess, edge: fullEdge, adherence: fullAdherence, leaks: fullLeaks, trades: fullTrades });
  for (const r of p.reads) assert.ok(r.provenance === "graded" || r.provenance === "private", `${r.kind} unstamped`);
  // The private-source reads must never be in the publicly-shareable set.
  assert.equal(PUBLIC_READS.has("MONEY_LEAK"), false);
  assert.equal(PUBLIC_READS.has("SYMBOL"), false);
  assert.equal(PUBLIC_READS.has("REGIME"), true);
});

// ── honest degradation ──────────────────────────────────────────────

test("profile: an empty record claims NOTHING and says what would unlock it", () => {
  const p = buildOperatorProfile({});
  assert.equal(p.tier, "UNKNOWN");
  assert.equal(p.reads.length, 0);
  assert.equal(p.archetype, null);
  assert.equal(p.dataScore, 0);
  assert.ok(p.unlocks.length > 0);
  assert.match(profileNarrative(p), /Not enough of a record/);
});

test("profile: a thin record is FORMING and the narrative hedges explicitly", () => {
  const p = buildOperatorProfile({
    process: { calls: 6, hitRate: 50, expectancy: { expectancy: 0.3, profitFactor: 1.3, tailRatio: 0.4, avgWinR: 1.5, avgLossR: 1 } },
    trades: fullTrades.slice(0, 12),
  });
  assert.equal(p.tier, "FORMING");
  assert.match(profileNarrative(p), /small sample/);
});

test("profile: reads are gated on sample — no payoff/discipline claim under 5", () => {
  const p = buildOperatorProfile({
    process: {
      calls: 3, hitRate: 66,
      expectancy: { expectancy: 1, profitFactor: 3, tailRatio: 0.5, avgWinR: 2, avgLossR: 1 },
      discipline: { score: 90, scored: 3, topFlag: { flag: "LATE_ENTRY", count: 2, rate: 66 } },
    },
  });
  assert.equal(p.reads.find((r) => r.kind === "PAYOFF"), undefined);
  assert.equal(p.reads.find((r) => r.kind === "DISCIPLINE"), undefined);
});

test("profile: a one-symbol record makes no best-vs-worst comparison", () => {
  const p = buildOperatorProfile({
    edge: { closed_trades: 10, best_symbol: { symbol: "BTC", trades: 10, pnl: 500 }, worst_symbol: { symbol: "BTC", trades: 10, pnl: 500 } },
    trades: fullTrades.slice(0, 10),
  });
  const sym = p.reads.find((r) => r.kind === "SYMBOL");
  assert.match(sym.text, /most profitable/);
  assert.ok(!/give it back/.test(sym.text));
});

test("dataScore: rises with graded calls, fills and matched plans", () => {
  const thin = buildOperatorProfile({ process: { calls: 5 }, trades: fullTrades.slice(0, 5) });
  const rich = buildOperatorProfile({ process: fullProcess, edge: fullEdge, adherence: fullAdherence, leaks: fullLeaks, trades: fullTrades });
  assert.ok(rich.dataScore > thin.dataScore);
  assert.ok(rich.dataScore >= 95);
});

// ── headline + unlocks + narrative ──────────────────────────────────

test("headline: three numbers, leak replaces plan-quality when one is priced", () => {
  const h = buildHeadline({ process: fullProcess, expectancy: fullProcess.expectancy, adherence: fullAdherence, leaks: fullLeaks });
  assert.equal(h.length, 3);
  assert.equal(h[0].value, "+0.6R");
  assert.equal(h[2].key, "leak");
  assert.match(h[2].value, /1,240/);
  // With no priced leak it falls back to plan quality.
  assert.equal(buildHeadline({ process: fullProcess, expectancy: fullProcess.expectancy })[2].key, "plan");
});

test("headline: missing data yields null values, never invented zeroes", () => {
  const h = buildHeadline({});
  assert.equal(h[0].value, null);
  assert.equal(h[1].value, null);
});

test("unlocks: names the exact next action and caps at three", () => {
  const u = buildUnlocks({ gradedCalls: 2, closed: 0 });
  assert.match(u[0].text, /Post 3 more public call/);
  assert.equal(u[0].need, 3);
  assert.ok(buildUnlocks({ gradedCalls: 0, closed: 0 }).length <= 3);
  // A complete record has nothing left to nag about.
  assert.equal(buildUnlocks({ gradedCalls: 30, closed: 40, adherence: { matched: 10 }, leaks: { tagged: 5 }, discipline: { scored: 30 }, regimeEdges: fullProcess.regimeEdges }).length, 0);
});

test("narrative: leads with the archetype and opens on the costliest read", () => {
  const p = buildOperatorProfile({ process: fullProcess, edge: fullEdge, adherence: fullAdherence, leaks: fullLeaks, trades: fullTrades });
  const n = profileNarrative(p);
  assert.match(n, /^Fat-tail trend-follower/);
  assert.match(n, /1,240/);
});

test("narrative: publicOnly drops every private read (the shareable version)", () => {
  const p = buildOperatorProfile({ process: fullProcess, edge: fullEdge, adherence: fullAdherence, leaks: fullLeaks, trades: fullTrades });
  const pub = profileNarrative(p, { publicOnly: true });
  assert.ok(!/1,240/.test(pub), "private dollar leak must not appear in the public narrative");
  assert.ok(!/DOGE/.test(pub), "private per-symbol record must not appear either");
  assert.match(pub, /edge is real in uptrends/); // graded reads survive
});

// ── public rendering (the trader page) ──────────────────────────────

test("PUBLIC: third-person voice re-points every pronoun, including objects", () => {
  const p = buildOperatorProfile({ process: fullProcess, edge: fullEdge, adherence: fullAdherence, leaks: fullLeaks, trades: fullTrades });
  const pub = profileNarrative(p, { publicOnly: true, voice: "third" });
  assert.ok(!/\byou\b/i.test(pub), `leaked 2nd person: ${pub}`);
  assert.ok(!/\byour\b/i.test(pub), `leaked "your": ${pub}`);
  assert.match(pub, /their edge/i);
  // "the wins carry you" must become "carry them", not "carry they"
  assert.ok(!/carry they/i.test(pub), `object pronoun mangled: ${pub}`);
  // ...and the owner's own view is unchanged
  assert.match(profileNarrative(p), /\byour\b/i);
});

test("REGRESSION: a big GRADED record is ESTABLISHED without private fills", () => {
  // A public profile can never see another wallet's closed trades. Requiring them for
  // ESTABLISHED made every public profile append "still a small sample" to a 24-call
  // record — a statement that was simply false.
  const p = buildOperatorProfile({ process: { ...fullProcess, calls: 24 } });
  assert.equal(p.closedTrades, 0);
  assert.equal(p.tier, "ESTABLISHED");
  assert.ok(!/small sample/i.test(profileNarrative(p, { publicOnly: true, voice: "third" })));
  // but a genuinely thin record still hedges
  const thin = buildOperatorProfile({ process: { ...fullProcess, calls: 6 } });
  assert.equal(thin.tier, "FORMING");
  assert.match(profileNarrative(thin, { publicOnly: true, voice: "third" }), /small sample/i);
});
