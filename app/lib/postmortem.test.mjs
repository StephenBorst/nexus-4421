// Loss-postmortem tests. Run: node --test app/lib/postmortem.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { LOSS_REASONS, isLossReason, lossReason, needsPostmortem, leakProfile } from "./postmortem.mjs";

const loss = (over = {}) => ({ id: "t1", symbol: "BTC", gradedOutcome: "LOSS", actualPnl: -100, createdAt: 1000, ...over });

test("taxonomy: keys are the exact pinned set (drift guard vs the worker's copy)", () => {
  // ⚠️ If this fails, the client and lab-api taxonomies have diverged — the
  // community aggregation would silently split across two key sets.
  assert.deepEqual(
    LOSS_REASONS.map((r) => r.key).sort(),
    ["CHASED", "EARLY", "NO_STOP", "OVERSIZED", "REVENGE", "THESIS_WRONG"],
  );
});

test("taxonomy: every reason carries a label, hint and a concrete fix", () => {
  for (const r of LOSS_REASONS) {
    assert.ok(r.label && r.hint && r.fix, `${r.key} is missing copy`);
  }
});

test("isLossReason / lossReason: enum-guarded against stale or injected values", () => {
  assert.equal(isLossReason("OVERSIZED"), true);
  assert.equal(isLossReason("oversized"), false); // case-sensitive by design
  assert.equal(isLossReason("__proto__"), false);
  assert.equal(isLossReason(null), false);
  assert.equal(lossReason("REVENGE").label, "Revenge trade");
  assert.equal(lossReason("NOPE"), null);
});

// ── needsPostmortem ─────────────────────────────────────────────────

test("needsPostmortem: untagged losses only", () => {
  const out = needsPostmortem([
    loss({ id: "a" }),                                  // graded loss, untagged → prompt
    loss({ id: "b", lossReason: "EARLY" }),             // already tagged → skip
    loss({ id: "c", gradedOutcome: "WIN" }),            // a win → skip
    { id: "d", status: "ACTIVE" },                      // still open → skip
  ]);
  assert.deepEqual(out.map((t) => t.id), ["a"]);
});

test("needsPostmortem: a self-marked STOPPED_OUT counts before the grader runs", () => {
  // Works on private theses too, which are never graded server-side.
  const out = needsPostmortem([{ id: "x", status: "STOPPED_OUT" }]);
  assert.deepEqual(out.map((t) => t.id), ["x"]);
});

test("needsPostmortem: a stale/invalid tag still counts as untagged", () => {
  const out = needsPostmortem([loss({ id: "a", lossReason: "LEGACY_REASON" })]);
  assert.equal(out.length, 1);
});

test("needsPostmortem: junk input is safe", () => {
  assert.deepEqual(needsPostmortem(null), []);
  assert.deepEqual(needsPostmortem([null, undefined]), []);
});

// ── leakProfile ─────────────────────────────────────────────────────

test("leakProfile: ranks the leak by DOLLARS, not by frequency", () => {
  const p = leakProfile([
    // one expensive oversizing loss
    loss({ id: "a", lossReason: "OVERSIZED", actualPnl: -2000 }),
    // three cheap 'early' losses — more frequent, far less costly
    loss({ id: "b", lossReason: "EARLY", actualPnl: -100 }),
    loss({ id: "c", lossReason: "EARLY", actualPnl: -100 }),
    loss({ id: "d", lossReason: "EARLY", actualPnl: -100 }),
  ]);
  assert.equal(p.tagged, 4);
  assert.equal(p.counts.EARLY, 3);
  assert.equal(p.top.reason, "OVERSIZED");
  assert.equal(p.top.costUsd, 2000);
  assert.equal(p.costUsd.EARLY, 300);
});

test("leakProfile: falls back to frequency when no dollar data exists", () => {
  const p = leakProfile([
    loss({ id: "a", lossReason: "CHASED", actualPnl: null }),
    loss({ id: "b", lossReason: "CHASED", actualPnl: null }),
    loss({ id: "c", lossReason: "REVENGE", actualPnl: null }),
  ]);
  assert.equal(p.top.reason, "CHASED");
  assert.equal(p.top.count, 2);
  assert.equal(p.top.costUsd, null);
  assert.deepEqual(p.costUsd, {});
});

test("leakProfile: a blank or positive actualPnl is 'no data', never coerced to 0", () => {
  const p = leakProfile([
    loss({ id: "a", lossReason: "NO_STOP", actualPnl: -500 }),
    loss({ id: "b", lossReason: "NO_STOP", actualPnl: null }),
    loss({ id: "c", lossReason: "NO_STOP", actualPnl: 25 }), // nonsensical on a loss → ignored
  ]);
  assert.equal(p.counts.NO_STOP, 3);
  assert.equal(p.costUsd.NO_STOP, 500); // only the real figure counts
});

test("leakProfile: counts untagged losses separately and ignores wins/open trades", () => {
  const p = leakProfile([
    loss({ id: "a", lossReason: "EARLY" }),
    loss({ id: "b" }),                        // untagged
    loss({ id: "c", gradedOutcome: "WIN" }),  // win
    { id: "d", status: "ACTIVE" },            // open
  ]);
  assert.equal(p.tagged, 1);
  assert.equal(p.untagged, 1);
});

test("leakProfile: empty ledger is an honest empty profile", () => {
  const p = leakProfile([]);
  assert.equal(p.tagged, 0);
  assert.equal(p.top, null);
  assert.deepEqual(p.rows, []);
});

test("leakProfile: rows come back newest-first", () => {
  const p = leakProfile([
    loss({ id: "old", lossReason: "EARLY", createdAt: 1000 }),
    loss({ id: "new", lossReason: "EARLY", createdAt: 9000 }),
  ]);
  assert.equal(p.rows[0].id, "new");
});
