// ═══════════════════════════════════════════════════════════════════════════
// POSITION LIFECYCLE — a call is a story, not a frozen post
// ═══════════════════════════════════════════════════════════════════════════
// Real traders add, trim, move stops and flip. A thesis that's a single immutable
// snapshot can't represent any of that, so the most interesting content — "trimmed
// half here and why" — has nowhere to live. This makes a thesis an append-only
// TIMELINE of updates on top of the original call.
//
// It's also the cheapest cold-start fix available: one call becomes many posts
// without needing more users.
//
// ⚠️ THE TRUSTLESS INVARIANT — read before touching grading.
// Grading (gradeCall, lab-api) reads ONLY the original entryPrice / stopLoss /
// takeProfit1 / createdAt, and the anchored call ledger hashes ONLY those same
// fields. Updates are therefore:
//   • ADDITIVE — they cannot change a graded outcome or the on-chain ledger hash;
//   • SELF-REPORTED NARRATIVE — timestamps and notes are client-written, so they are
//     NOT evidence and must never feed the leaderboard or merit ranks.
// Never make grading read `updates`. If a trader could move a stop after the fact
// and have it re-graded, the entire trustless claim collapses — that is exactly the
// self-reported-PnL failure mode Nexus exists to not be. The UI must present the
// timeline as commentary and the grade as the fact.
//
// Pure + dependency-free: `node --test app/lib/lifecycle.test.mjs`.

export const UPDATE_KINDS = [
  { key: "ADD",      label: "Added",        glyph: "+", needs: [] },
  { key: "TRIM",     label: "Trimmed",      glyph: "−", needs: [] },
  { key: "STOP_MOVED", label: "Stop moved", glyph: "⇱", needs: ["price"] },
  { key: "TARGET_MOVED", label: "Target moved", glyph: "⇲", needs: ["price"] },
  { key: "FLIP",     label: "Flipped",      glyph: "⇄", needs: [] },
  { key: "CLOSED",   label: "Closed",       glyph: "×", needs: [] },
  { key: "NOTE",     label: "Note",         glyph: "·", needs: [] },
];

const BY_KEY = new Map(UPDATE_KINDS.map((k) => [k.key, k]));
export function isUpdateKind(x) { return typeof x === "string" && BY_KEY.has(x); }
export function updateKind(key) { return BY_KEY.get(key) ?? null; }

export const MAX_UPDATES = 50;      // a thesis is a story, not a chat log
export const MAX_NOTE_LEN = 280;    // one cast's worth — forces the point

/**
 * Append one update to a thesis's timeline, immutably.
 *
 * APPEND-ONLY by construction: existing entries are never rewritten, and a new
 * entry's timestamp is clamped to be >= the last one so the timeline can't be made
 * to read out of order (a client clock skew, or an attempt to slot an update
 * "before" an inconvenient one, would otherwise reorder the narrative).
 *
 * @returns {{ok:true, updates:object[]}|{ok:false, error:string}}
 */
export function appendUpdate(thesis, input, now = Date.now()) {
  const existing = Array.isArray(thesis?.updates) ? thesis.updates : [];
  if (!isUpdateKind(input?.kind)) return { ok: false, error: "unknown update kind" };
  if (existing.length >= MAX_UPDATES) return { ok: false, error: `timeline is full (${MAX_UPDATES} updates)` };

  const spec = BY_KEY.get(input.kind);
  const entry = { at: now, kind: input.kind };

  // A level change is meaningless without the level.
  if (spec.needs.includes("price")) {
    const p = Number(input.price);
    if (!Number.isFinite(p) || p <= 0) return { ok: false, error: "a new level is required" };
    entry.price = p;
  } else if (Number.isFinite(Number(input.price)) && Number(input.price) > 0) {
    entry.price = Number(input.price); // optional context ("trimmed here")
  }

  // Size fraction, for ADD / TRIM. Clamped to a sane 1-100%.
  if (input.sizePct != null && input.sizePct !== "") {
    const s = Number(input.sizePct);
    if (!Number.isFinite(s) || s <= 0 || s > 100) return { ok: false, error: "size % must be 1-100" };
    entry.sizePct = Math.round(s);
  }

  const note = String(input.note ?? "").trim();
  if (note) entry.note = note.slice(0, MAX_NOTE_LEN);
  // A bare NOTE with nothing in it is not an update.
  if (input.kind === "NOTE" && !entry.note) return { ok: false, error: "add a note" };

  // Monotonic: never allow an entry that predates the last one.
  const lastAt = existing.length ? Number(existing[existing.length - 1].at) || 0 : 0;
  if (entry.at < lastAt) entry.at = lastAt;

  return { ok: true, updates: [...existing, entry] };
}

/**
 * Read the timeline into current state + a display summary.
 *
 * `stop`/`target` reflect the trader's LATEST stated levels — for display only.
 * Grading still uses the original levels (see the invariant above), so a moved stop
 * changes the story shown, never the score.
 *
 * @returns {{count,size,stop,target,closed,flipped,last,timeline}}
 */
export function lifecycleState(thesis) {
  const updates = (Array.isArray(thesis?.updates) ? thesis.updates : [])
    .filter((u) => u && isUpdateKind(u.kind))
    .slice()
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));

  let size = 100;                 // % of the original position still on
  let stop = Number(thesis?.stopLoss) || null;
  let target = Number(thesis?.takeProfit1) || null;
  let closed = false, flipped = false;

  for (const u of updates) {
    switch (u.kind) {
      case "ADD":  size += Number(u.sizePct) || 0; break;
      case "TRIM": size -= Number(u.sizePct) || 0; break;
      case "STOP_MOVED":   if (u.price) stop = u.price; break;
      case "TARGET_MOVED": if (u.price) target = u.price; break;
      case "FLIP":   flipped = true; break;
      case "CLOSED": closed = true; size = 0; break;
      default: break;
    }
  }
  // A trim can't take off more than is on; an add can't imply infinite size.
  size = Math.max(0, Math.min(size, 1000));
  if (closed) size = 0;

  return {
    count: updates.length,
    size: Math.round(size),
    stop, target, closed, flipped,
    last: updates.length ? updates[updates.length - 1] : null,
    timeline: updates,
  };
}

/** One-line human summary of an update — shared by every surface that renders one. */
export function describeUpdate(u) {
  const spec = updateKind(u?.kind);
  if (!spec) return "";
  const bits = [spec.label];
  if (u.sizePct && (u.kind === "ADD" || u.kind === "TRIM")) bits.push(`${u.sizePct}%`);
  if (u.price) bits.push(`@ ${u.price}`);
  return bits.join(" ");
}
