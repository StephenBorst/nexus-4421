// Position-lifecycle tests. Run: node --test app/lib/lifecycle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { UPDATE_KINDS, isUpdateKind, appendUpdate, lifecycleState, describeUpdate, MAX_UPDATES, MAX_NOTE_LEN } from "./lifecycle.mjs";

const T0 = 1_700_000_000_000;
const base = (over = {}) => ({ id: "t1", symbol: "BTC", direction: "LONG", entryPrice: 100, stopLoss: 95, takeProfit1: 110, createdAt: T0, ...over });

test("taxonomy: kinds are the pinned set and each carries display metadata", () => {
  assert.deepEqual(UPDATE_KINDS.map((k) => k.key).sort(),
    ["ADD", "CLOSED", "FLIP", "NOTE", "STOP_MOVED", "TARGET_MOVED", "TRIM"]);
  for (const k of UPDATE_KINDS) assert.ok(k.label && k.glyph, `${k.key} missing metadata`);
  assert.equal(isUpdateKind("TRIM"), true);
  assert.equal(isUpdateKind("trim"), false);
  assert.equal(isUpdateKind("__proto__"), false);
});

// ── appendUpdate ────────────────────────────────────────────────────

test("append: adds an entry without mutating the original thesis", () => {
  const t = base();
  const r = appendUpdate(t, { kind: "TRIM", sizePct: 50 }, T0 + 1000);
  assert.equal(r.ok, true);
  assert.equal(r.updates.length, 1);
  assert.equal(r.updates[0].kind, "TRIM");
  assert.equal(t.updates, undefined); // immutable — caller decides to persist
});

test("append: existing entries are never rewritten (append-only)", () => {
  const first = appendUpdate(base(), { kind: "ADD", sizePct: 25 }, T0 + 100).updates;
  const second = appendUpdate({ ...base(), updates: first }, { kind: "TRIM", sizePct: 10 }, T0 + 200).updates;
  assert.equal(second.length, 2);
  assert.deepEqual(second[0], first[0]); // untouched
});

test("append: a level change requires the level", () => {
  assert.equal(appendUpdate(base(), { kind: "STOP_MOVED" }).ok, false);
  assert.equal(appendUpdate(base(), { kind: "STOP_MOVED", price: 0 }).ok, false);
  assert.equal(appendUpdate(base(), { kind: "STOP_MOVED", price: -5 }).ok, false);
  const ok = appendUpdate(base(), { kind: "STOP_MOVED", price: 100 });
  assert.equal(ok.ok, true);
  assert.equal(ok.updates[0].price, 100);
});

test("append: price is optional context on non-level kinds", () => {
  assert.equal(appendUpdate(base(), { kind: "TRIM", price: 104 }).updates[0].price, 104);
  assert.equal(appendUpdate(base(), { kind: "TRIM" }).updates[0].price, undefined);
});

test("append: size % is validated and rounded", () => {
  assert.equal(appendUpdate(base(), { kind: "TRIM", sizePct: 150 }).ok, false);
  assert.equal(appendUpdate(base(), { kind: "TRIM", sizePct: 0 }).ok, false);
  assert.equal(appendUpdate(base(), { kind: "TRIM", sizePct: 33.4 }).updates[0].sizePct, 33);
  assert.equal(appendUpdate(base(), { kind: "TRIM", sizePct: "" }).updates[0].sizePct, undefined);
});

test("append: notes are trimmed, capped, and required for a bare NOTE", () => {
  assert.equal(appendUpdate(base(), { kind: "NOTE" }).ok, false);
  assert.equal(appendUpdate(base(), { kind: "NOTE", note: "   " }).ok, false);
  assert.equal(appendUpdate(base(), { kind: "NOTE", note: "  held  " }).updates[0].note, "held");
  const long = appendUpdate(base(), { kind: "NOTE", note: "x".repeat(400) });
  assert.equal(long.updates[0].note.length, MAX_NOTE_LEN);
});

test("append: an out-of-order timestamp is clamped forward, never inserted behind", () => {
  // Guards against clock skew — or slotting an update 'before' an inconvenient one.
  const first = appendUpdate(base(), { kind: "ADD", sizePct: 10 }, T0 + 5000).updates;
  const r = appendUpdate({ ...base(), updates: first }, { kind: "TRIM", sizePct: 10 }, T0 + 1000);
  assert.equal(r.updates[1].at, T0 + 5000); // clamped up to the last entry
  assert.ok(r.updates[1].at >= r.updates[0].at);
});

test("append: rejects unknown kinds and a full timeline", () => {
  assert.equal(appendUpdate(base(), { kind: "DELETE_EVERYTHING" }).ok, false);
  assert.equal(appendUpdate(base(), {}).ok, false);
  const full = { ...base(), updates: Array.from({ length: MAX_UPDATES }, (_, i) => ({ at: T0 + i, kind: "NOTE", note: "n" })) };
  const r = appendUpdate(full, { kind: "NOTE", note: "one more" });
  assert.equal(r.ok, false);
  assert.match(r.error, /full/);
});

// ── lifecycleState ──────────────────────────────────────────────────

test("state: a thesis with no updates is 100% on at its original levels", () => {
  const s = lifecycleState(base());
  assert.equal(s.count, 0);
  assert.equal(s.size, 100);
  assert.equal(s.stop, 95);
  assert.equal(s.target, 110);
  assert.equal(s.closed, false);
  assert.equal(s.last, null);
});

test("state: trims and adds move the remaining size", () => {
  const s = lifecycleState(base({ updates: [
    { at: T0 + 1, kind: "TRIM", sizePct: 50 },
    { at: T0 + 2, kind: "ADD", sizePct: 25 },
  ] }));
  assert.equal(s.size, 75);
  assert.equal(s.count, 2);
});

test("state: size can never go negative, and CLOSED forces it to zero", () => {
  assert.equal(lifecycleState(base({ updates: [
    { at: T0 + 1, kind: "TRIM", sizePct: 80 }, { at: T0 + 2, kind: "TRIM", sizePct: 80 },
  ] })).size, 0);
  const closed = lifecycleState(base({ updates: [
    { at: T0 + 1, kind: "ADD", sizePct: 50 }, { at: T0 + 2, kind: "CLOSED" },
  ] }));
  assert.equal(closed.size, 0);
  assert.equal(closed.closed, true);
});

test("state: latest stated stop/target win (display only, never re-grades)", () => {
  const s = lifecycleState(base({ updates: [
    { at: T0 + 1, kind: "STOP_MOVED", price: 100 },
    { at: T0 + 2, kind: "STOP_MOVED", price: 103 },
    { at: T0 + 3, kind: "TARGET_MOVED", price: 130 },
  ] }));
  assert.equal(s.stop, 103);
  assert.equal(s.target, 130);
  // ⚠️ invariant: the ORIGINAL levels on the thesis are untouched, so gradeCall —
  // which reads the thesis, not this state — still grades the call as posted.
  const t = base({ updates: [{ at: T0 + 1, kind: "STOP_MOVED", price: 103 }] });
  assert.equal(t.stopLoss, 95);
  assert.equal(t.takeProfit1, 110);
});

test("state: entries are read in chronological order regardless of stored order", () => {
  const s = lifecycleState(base({ updates: [
    { at: T0 + 900, kind: "STOP_MOVED", price: 108 },
    { at: T0 + 100, kind: "STOP_MOVED", price: 101 },
  ] }));
  assert.equal(s.stop, 108);          // the later one wins
  assert.equal(s.timeline[0].price, 101); // sorted ascending for display
});

test("state: junk entries are ignored, not crashed on", () => {
  const s = lifecycleState(base({ updates: [
    null, { kind: "BOGUS" }, { at: T0 + 1, kind: "TRIM", sizePct: 20 },
  ] }));
  assert.equal(s.count, 1);
  assert.equal(s.size, 80);
});

test("state: FLIP is surfaced as a distinct fact", () => {
  assert.equal(lifecycleState(base({ updates: [{ at: T0 + 1, kind: "FLIP" }] })).flipped, true);
});

test("state: handles a missing/blank thesis safely", () => {
  assert.equal(lifecycleState(null).count, 0);
  assert.equal(lifecycleState({}).size, 100);
});

test("describeUpdate: readable one-liners", () => {
  assert.equal(describeUpdate({ kind: "TRIM", sizePct: 50, price: 104 }), "Trimmed 50% @ 104");
  assert.equal(describeUpdate({ kind: "STOP_MOVED", price: 103 }), "Stop moved @ 103");
  assert.equal(describeUpdate({ kind: "CLOSED" }), "Closed");
  assert.equal(describeUpdate({ kind: "NOPE" }), "");
});
