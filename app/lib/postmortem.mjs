// ═══════════════════════════════════════════════════════════════════════════
// LOSS POSTMORTEMS — why the losers lost, from a fixed taxonomy
// ═══════════════════════════════════════════════════════════════════════════
// Grading says a call LOST. It can't say why, and "why" is the only part a trader
// can act on. Free text doesn't aggregate, so this is a closed set of six
// mutually-exclusive, individually-fixable failure modes.
//
// ⚠️ The KEY set MUST match LOSS_REASONS in workers/nexus-lab-api/logic.mjs (the
// server aggregates the same keys for the community artifact). Both sides have a
// pinned key-set test so drift fails loudly instead of silently splitting the data.
//
// Self-reported by design — it's introspection, not a fact about price. So it never
// touches the trustless leaderboard, and the UI must not imply otherwise.
//
// Pure + dependency-free: `node --test app/lib/postmortem.test.mjs` covers the real
// shipped code (same convention as adherence.mjs / the workers' logic.mjs).

export const LOSS_REASONS = [
  { key: "THESIS_WRONG", label: "Thesis was wrong",  hint: "The idea itself failed — the market did the opposite for real reasons.", fix: "Nothing to fix in execution. This is the cost of doing business; the goal is to keep these small." },
  { key: "EARLY",        label: "Entered too early", hint: "Right idea, wrong time — stopped out before it worked.",                fix: "Wait for confirmation, or widen the stop and cut the size to keep the same risk." },
  { key: "OVERSIZED",    label: "Position too big",  hint: "Sizing, not analysis — a normal loss hurt more than it should have.",   fix: "Fix sizing before anything else: it's the cheapest edge you have and it's fully in your control." },
  { key: "NO_STOP",      label: "Ignored my stop",   hint: "Moved or abandoned the stop — the one unforgivable one.",               fix: "Place the stop at entry as a resting order so the decision is already made." },
  { key: "CHASED",       label: "Chased the entry",  hint: "Bought the move instead of the level — paid up, no edge left.",         fix: "If price is already past your level, the trade is gone. Let it go; there's another one." },
  { key: "REVENGE",      label: "Revenge trade",     hint: "Traded to win money back, not because the setup was there.",            fix: "Hard rule: after two losses, stop for the session. This one is emotional, not analytical." },
];

const BY_KEY = new Map(LOSS_REASONS.map((r) => [r.key, r]));

/** Valid taxonomy key? Guards against stale/injected values from storage. */
export function isLossReason(x) { return typeof x === "string" && BY_KEY.has(x); }

/** Full descriptor for a key, or null. */
export function lossReason(key) { return BY_KEY.get(key) ?? null; }

/**
 * Which theses are losses still awaiting a postmortem — what the UI prompts on.
 * A loss is objective (server-stamped gradedOutcome) OR self-marked STOPPED_OUT,
 * so it works before the grader has run and on private (never-graded) theses.
 */
export function needsPostmortem(theses) {
  return (theses || []).filter((t) => {
    if (!t) return false;
    const lost = t.gradedOutcome === "LOSS" || t.status === "STOPPED_OUT";
    return lost && !isLossReason(t.lossReason);
  });
}

/**
 * The user's leak profile across their tagged losses.
 *
 * Ranks by DOLLARS where actualPnl was recorded, falling back to frequency —
 * because "oversizing cost you $2,100" changes behavior and "you tagged oversizing
 * 4 times" does not. Dollar totals only count theses that actually carry a figure,
 * so a partially-filled ledger under-reports rather than inventing numbers.
 *
 * @returns {{tagged,untagged,counts,costUsd,top,rows}}
 */
export function leakProfile(theses) {
  const rows = [];
  let untagged = 0;
  for (const t of theses || []) {
    const lost = t?.gradedOutcome === "LOSS" || t?.status === "STOPPED_OUT";
    if (!lost) continue;
    if (!isLossReason(t.lossReason)) { untagged++; continue; }
    const pnl = Number(t.actualPnl);
    rows.push({
      id: t.id,
      symbol: t.symbol,
      reason: t.lossReason,
      // Only real, negative figures count as cost. A blank or positive value is
      // simply "no dollar data" — never coerced to 0 and averaged in.
      costUsd: Number.isFinite(pnl) && pnl < 0 ? Math.abs(pnl) : null,
      createdAt: t.createdAt || 0,
    });
  }
  if (!rows.length) return { tagged: 0, untagged, counts: {}, costUsd: {}, top: null, rows: [] };

  const counts = {}, costUsd = {};
  for (const r of rows) {
    counts[r.reason] = (counts[r.reason] || 0) + 1;
    if (r.costUsd != null) costUsd[r.reason] = round((costUsd[r.reason] || 0) + r.costUsd, 2);
  }
  const byCost = Object.entries(costUsd).sort((a, b) => b[1] - a[1])[0];
  const byCount = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const top = byCost
    ? { reason: byCost[0], costUsd: byCost[1], count: counts[byCost[0]] || 0 }
    : { reason: byCount[0], costUsd: null, count: byCount[1] };

  return { tagged: rows.length, untagged, counts, costUsd, top, rows: rows.sort((a, b) => b.createdAt - a.createdAt) };
}

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;
