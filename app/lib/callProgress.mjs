// ── In-flight call progress ──
// A call is graded the moment price first touches TP or SL. Everything before that was
// dead air: the card said "ACTIVE" and nothing else moved. At cold start that silence
// is the whole experience — post a thesis, then wait days for anything to happen.
//
// This makes the gap legible. Same public price the grader will use, expressed in R so
// it speaks the language the rest of the product ranks on (expectancy, avg-R, regime
// edge). "+0.6R, 62% of the way to target" beats "ACTIVE".
//
// ⚠️ This is a LIVE READ, never a grade. gradeCall (lab-api logic.mjs) decides outcomes
// from first-touch on the candle series, and only it may write gradedOutcome. A call
// currently showing +0.9R can still finish -1R, and a call that already wicked through
// TP is a WIN even if it's since retraced — which is exactly why this must not be
// mistaken for a result. Callers should label it as unresolved.

/**
 * @param {object} t   thesis { direction, entryPrice, stopLoss, takeProfit1 }
 * @param {number} mark current mark price
 * @returns {{r:number, pctToTarget:number, barPos:number, state:string,
 *            toTpPct:number, toSlPct:number, rewardR:number}|null}
 */
export function callProgress(t, mark) {
  if (!t || !Number.isFinite(mark) || mark <= 0) return null;
  const entry = Number(t.entryPrice), stop = Number(t.stopLoss), tp = Number(t.takeProfit1);
  if (!entry || !stop || !tp) return null;
  const risk = Math.abs(entry - stop);
  if (!risk) return null;

  const long = String(t.direction).toUpperCase() === "LONG";
  // Signed in the direction of the trade: positive means the call is working.
  const moved = long ? mark - entry : entry - mark;
  const r = round(moved / risk, 2);
  const rewardR = round(Math.abs(tp - entry) / risk, 2);

  // How far along the journey from entry to target (0 = entry, 1 = target hit).
  const pctToTarget = rewardR > 0 ? clamp(r / rewardR, -1, 1) : 0;

  // Position on an SL→TP bar. 0 = stop, 0.5-ish = entry, 1 = target.
  const span = Math.abs(tp - stop);
  const barPos = span > 0 ? clamp(long ? (mark - stop) / span : (stop - mark) / span, 0, 1) : 0.5;

  // Distance still to travel, as % of current price — what a trader actually watches.
  const toTpPct = round(Math.abs((tp - mark) / mark) * 100, 2);
  const toSlPct = round(Math.abs((mark - stop) / mark) * 100, 2);

  // "AT_TARGET"/"AT_STOP" describe where price is NOW. They are not outcomes: the
  // grader works off first-touch across the full candle history, which this never sees.
  const state = r >= rewardR ? "AT_TARGET" : r <= -1 ? "AT_STOP" : r > 0.05 ? "WINNING" : r < -0.05 ? "LOSING" : "FLAT";

  return { r, rewardR, pctToTarget: round(pctToTarget, 3), barPos: round(barPos, 3), state, toTpPct, toSlPct };
}

/** Aggregate live R across a set of open calls — the "what's cooking" number. */
export function openCallsSummary(rows) {
  const live = (rows || []).filter((x) => x && x.progress);
  if (!live.length) return null;
  const rSum = live.reduce((s, x) => s + x.progress.r, 0);
  const winning = live.filter((x) => x.progress.r > 0).length;
  return {
    open: live.length,
    winning,
    losing: live.length - winning,
    rSum: round(rSum, 2),
    avgR: round(rSum / live.length, 2),
  };
}

export const PROGRESS_LABEL = {
  AT_TARGET: "at target",
  AT_STOP: "at stop",
  WINNING: "in profit",
  LOSING: "underwater",
  FLAT: "at entry",
};

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
