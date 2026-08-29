import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes, bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// ═══════════════════════════════════════════════════════════
// Pure, testable logic for nexus-lab-api.
// Imported by index.js so tests cover the real deployed behavior.
// ═══════════════════════════════════════════════════════════

/**
 * Grade a human "call" (thesis) against public OHLC candles, first-touch.
 * Trustless: the outcome is a fact about public price, not self-report.
 * - LONG  wins if a candle high reaches takeProfit1 before a low hits stopLoss
 * - SHORT wins if a candle low reaches takeProfit1 before a high hits stopLoss
 * - Same-candle TP+SL = LOSS (conservative, anti-gaming)
 * - WIN scores +planned R (riskReward, default 1); LOSS = -1R
 *
 * @param {object} t  thesis { direction, entryPrice, stopLoss, takeProfit1, createdAt, riskReward }
 * @param {object} cd candles { t:number[] (sec), h:number[], l:number[] } ascending by t
 * @returns {{ outcome:"WIN"|"LOSS"|"PENDING"|"INVALID", r:number }}
 */
export function gradeCall(t, cd) {
  const { direction, entryPrice, stopLoss, takeProfit1, createdAt, riskReward } = t;
  if (!entryPrice || !stopLoss || !takeProfit1 || !cd) return { outcome: "INVALID", r: 0 };
  const startSec = Math.floor((createdAt || 0) / 1000);
  const R = (typeof riskReward === "number" && riskReward > 0) ? riskReward : 1;
  for (let i = 0; i < cd.t.length; i++) {
    if (cd.t[i] < startSec) continue;
    const hi = cd.h[i], lo = cd.l[i];
    if (direction === "LONG") {
      const tp = hi >= takeProfit1, sl = lo <= stopLoss;
      if (tp && sl) return { outcome: "LOSS", r: -1 };
      if (tp) return { outcome: "WIN", r: R };
      if (sl) return { outcome: "LOSS", r: -1 };
    } else {
      const tp = lo <= takeProfit1, sl = hi >= stopLoss;
      if (tp && sl) return { outcome: "LOSS", r: -1 };
      if (tp) return { outcome: "WIN", r: R };
      if (sl) return { outcome: "LOSS", r: -1 };
    }
  }
  return { outcome: "PENDING", r: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
// REGIME ATTRIBUTION
// ═══════════════════════════════════════════════════════════════════════════
// Outcome grading answers "was the call right". Regime attribution answers the
// far more useful question: "in WHICH market does this trader's edge live". Every
// good discretionary trader knows the answer for themselves; almost no retail
// trader does, because nobody breaks their record down this way.
//
// Deliberately computed from the SAME public /tv/history OHLC that gradeCall uses:
// - trustless (anyone can recompute it from public candles, like the grade itself)
// - historical + universal (works on every symbol, any date) — unlike the brain's
//   live computeRegime, which only knows *now*, and unlike oi:hist, which only
//   covers watchlisted symbols and only since we started recording.
// So this adds ZERO new data dependency. It reads the candles BEFORE the call was
// posted — the regime the trader chose to trade into, not the one that followed
// (which would be hindsight, and would leak the outcome into the label).

// ⚠️ CALIBRATED ON REAL DATA, not chosen by feel. Measured over 60d of hourly
// candles across BTC/ETH/SOL/DOGE/HYPE (tools/calibrate-regime.mjs):
//   ER_TREND  0.35 → 6% of windows trend · 0.30 → 11% · 0.25 → 20% · 0.20 → 31%
//   vol       0.75/1.50 → 33/62/5 (CALM/NORMAL/VOLATILE) · 0.80/1.35 → 42/49/9
// The first cut used 0.35 and labelled 27 of 28 BTC windows CHOP — a dimension that
// answers the same way every time produces no comparison, so regimeEdge could never
// speak. These values put ~31% of windows in a trend (stable at 25-35% per symbol)
// and keep every bucket populated enough to actually reach the 5-call minimum.
export const REGIME = {
  LOOKBACK: 48,     // candles of context before the call (1h bars → 2 days)
  MIN_SAMPLES: 12,  // below this the window can't describe a regime → null
  ER_TREND: 0.20,   // efficiency ratio above which price is going somewhere
  MIN_MOVE_PCT: 1,  // ...and it has to have actually moved, not drifted
  VOL_CALM: 0.80,   // ATR% vs the symbol's own baseline
  VOL_HOT: 1.35,
};

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Index of the last candle at or before `atSec`, or -1. Candles ascend by t. */
function candleIndexAt(cd, atSec) {
  let idx = -1;
  for (let i = 0; i < cd.t.length; i++) {
    if (cd.t[i] <= atSec) idx = i; else break;
  }
  return idx;
}

/**
 * Classify the market a call was posted INTO, from the candles preceding it.
 *
 * trend  — TREND_UP / TREND_DOWN / CHOP via the efficiency ratio (net move ÷ total
 *          path). ER near 1 = a straight line; near 0 = the same ground covered
 *          over and over. A big move that backed and filled is still chop, which
 *          is exactly the distinction a % change can't make.
 * vol    — CALM / NORMAL / VOLATILE: window ATR% against the symbol's own longer
 *          baseline, so "volatile" means volatile *for this asset* (a 3% day is
 *          calm for a memecoin and a crisis for BTC).
 *
 * @param {{t:number[],h:number[],l:number[],c:number[]}} cd candles (needs closes)
 * @param {number} atSec  when the call was posted (seconds)
 * @returns {{trend,vol,er,movePct,atrPct,baselineAtrPct,samples}|null} null when history is too thin
 */
export function classifyRegime(cd, atSec, opts = {}) {
  const { LOOKBACK, MIN_SAMPLES, ER_TREND, MIN_MOVE_PCT, VOL_CALM, VOL_HOT } = { ...REGIME, ...opts };
  if (!cd || !Array.isArray(cd.t) || !Array.isArray(cd.c)) return null;
  const at = candleIndexAt(cd, atSec);
  if (at < MIN_SAMPLES - 1) return null; // not enough PRIOR context to describe

  const from = Math.max(0, at - LOOKBACK + 1);
  const closes = cd.c.slice(from, at + 1).map(Number).filter(Number.isFinite);
  if (closes.length < MIN_SAMPLES) return null;

  // Efficiency ratio: how much of the distance travelled was actually progress.
  let path = 0;
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1]);
  const net = closes[closes.length - 1] - closes[0];
  const er = path > 0 ? Math.abs(net) / path : 0;
  const movePct = closes[0] ? (net / closes[0]) * 100 : 0;

  const trend = (er >= ER_TREND && Math.abs(movePct) >= MIN_MOVE_PCT)
    ? (net > 0 ? "TREND_UP" : "TREND_DOWN")
    : "CHOP";

  // Volatility, relative to this symbol's own history (not an absolute threshold).
  const atrOf = (a, b) => {
    let sum = 0, n = 0;
    for (let i = a; i <= b; i++) {
      const h = Number(cd.h[i]), l = Number(cd.l[i]), c = Number(cd.c[i]);
      if (!Number.isFinite(h) || !Number.isFinite(l) || !c) continue;
      sum += ((h - l) / Math.abs(c)) * 100; n++;
    }
    return n ? sum / n : null;
  };
  const atrPct = atrOf(from, at);
  const baselineAtrPct = atrOf(0, at);
  let vol = "NORMAL";
  if (atrPct != null && baselineAtrPct) {
    const ratio = atrPct / baselineAtrPct;
    if (ratio <= VOL_CALM) vol = "CALM";
    else if (ratio >= VOL_HOT) vol = "VOLATILE";
  }

  return {
    trend, vol, er: round(er, 3), movePct: round(movePct, 2),
    atrPct: atrPct == null ? null : round(atrPct, 3),
    baselineAtrPct: baselineAtrPct == null ? null : round(baselineAtrPct, 3),
    samples: closes.length,
  };
}

/**
 * Was the call WITH the prevailing trend, AGAINST it, or in chop? This is the cut
 * that most often produces the "stop doing that" insight — a trader can be a fine
 * trend-follower and a reliable donor when they fight the tape, and a blended
 * hit-rate hides both facts.
 */
export function callAlignment(direction, regime) {
  if (!regime || regime.trend === "CHOP") return "CHOP";
  const up = regime.trend === "TREND_UP";
  const long = String(direction).toUpperCase() === "LONG";
  return up === long ? "WITH_TREND" : "AGAINST_TREND";
}

/** Bucket keys a call is attributed to. Kept flat + few so samples stay meaningful. */
export function regimeBucketsOf(direction, regime) {
  if (!regime) return [];
  return [`trend:${regime.trend}`, `vol:${regime.vol}`, `align:${callAlignment(direction, regime)}`];
}

/**
 * Aggregate graded calls into per-bucket records.
 * @param {{buckets:string[], r:number, win:boolean}[]} rows
 */
export function regimeBuckets(rows) {
  const out = {};
  for (const row of rows || []) {
    for (const b of row.buckets || []) {
      const a = out[b] || (out[b] = { bucket: b, calls: 0, wins: 0, rSum: 0 });
      a.calls++; if (row.win) a.wins++; a.rSum += Number(row.r) || 0;
    }
  }
  for (const a of Object.values(out)) {
    a.avgR = round(a.rSum / a.calls, 2);
    a.rSum = round(a.rSum, 2);
    a.hitRate = round((a.wins / a.calls) * 100, 1);
  }
  return out;
}

// A verdict is only worth showing when it's likely to be real: both sides need a
// minimum sample AND the gap has to be big enough to act on. Otherwise we say
// nothing — a confident-sounding insight drawn from 3 calls is worse than silence,
// because the trader will actually change their behavior on it.
export const REGIME_EDGE = { minSample: 5, minGapR: 0.4 };

/**
 * The single actionable sentence's worth of data: within one dimension (trend, vol
 * or alignment), which regime is this trader best and worst in?
 * @returns {{dimension,best,worst,gapR}|null}
 */
export function regimeEdge(buckets, dimension = "trend", cfg = REGIME_EDGE) {
  const rows = Object.values(buckets || {})
    .filter((b) => b.bucket.startsWith(`${dimension}:`) && b.calls >= cfg.minSample);
  if (rows.length < 2) return null;
  rows.sort((x, y) => y.avgR - x.avgR);
  const best = rows[0], worst = rows[rows.length - 1];
  const gapR = round(best.avgR - worst.avgR, 2);
  if (gapR < cfg.minGapR) return null; // no separation worth acting on
  return { dimension, best, worst, gapR };
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAN QUALITY  (the trustless half of process grading)
// ═══════════════════════════════════════════════════════════════════════════
// Outcome grading can't tell a disciplined operator from a lucky gunslinger — both
// book +R. Process is what separates them, but a HUMAN's actual fills are private
// (Orderly publishes only per-symbol aggregates — there is no public per-trade
// tape), so we cannot verify execution server-side and must not pretend to.
//
// What IS publicly verifiable is whether the PLAN was well-formed at the moment it
// was posted, judged against the public price at that moment:
//   LATE_ENTRY   the market had already run most of the way to target before the
//                call went up — the stated entry was never obtainable, so the R
//                being claimed is fiction (this is the main way a board gets gamed)
//   STOP_IN_NOISE  the stop sits inside a single bar's normal range → the outcome
//                is a coin flip on noise regardless of whether the idea was right
//   STOP_TOO_WIDE  "stop" so far away it isn't risk control
//   RR_MISMATCH  the claimed R:R disagrees with the trader's own levels — and the
//                claimed R is what gradeCall pays out on a win, so this matters
//   BAD_LEVELS   target on the wrong side of entry — malformed, not a real call
// Every one of these is recomputable by anyone from the same public candles, which
// is why it can legitimately sit next to the trustless grade on the leaderboard.

export const PLAN_PENALTY = { LATE_ENTRY: 30, STOP_IN_NOISE: 25, STOP_TOO_WIDE: 15, RR_MISMATCH: 20, BAD_LEVELS: 50 };
// ⚠️ stopWideAtr CALIBRATED on real hourly ATR, not guessed (tools/calibrate-regime.mjs
// prints the ATR%; measured 2026-07 across BTC/ETH/SOL/DOGE/HYPE). The first value (6)
// was badly wrong because ATR here is HOURLY, so the multiple scales with holding
// period, not with recklessness — an ordinary 1.5% swing stop is 8.1 ATR on BTC (and
// 2.2 on HYPE), so 6 flagged normal swing trading while passing a loose DOGE stop. It
// measured TIMEFRAME, not discipline. A genuinely absurd stop (8% on BTC) is ~43 ATR,
// so 25 passes every legitimate stop and still catches "this is not risk control".
// False positives are worse than silence here: they train traders to ignore the advisor.
export const PLAN = { lateEntryR: 0.5, stopNoiseAtr: 0.5, stopWideAtr: 25, rrTolerance: 0.5, rrRelTolerance: 0.25 };

/**
 * Score how well-formed a call was, from public price at post time.
 * @param {object} t   thesis { direction, entryPrice, stopLoss, takeProfit1, riskReward, createdAt }
 * @param {object} cd  candles { t,h,l,c }
 * @returns {{score:number, flags:string[], components:object}|null} null if unscoreable
 */
export function planQuality(t, cd, cfg = PLAN) {
  if (!t || !t.entryPrice || !t.stopLoss || !t.takeProfit1) return null;
  const long = String(t.direction).toUpperCase() === "LONG";
  const riskDist = Math.abs(t.entryPrice - t.stopLoss);
  if (!riskDist) return null;

  const flags = [];
  const components = { riskDist: round(riskDist, 8) };

  // Malformed geometry: stop must sit on the losing side, target on the winning side.
  const stopWrongSide = long ? t.stopLoss >= t.entryPrice : t.stopLoss <= t.entryPrice;
  const tpWrongSide = long ? t.takeProfit1 <= t.entryPrice : t.takeProfit1 >= t.entryPrice;
  if (stopWrongSide || tpWrongSide) flags.push("BAD_LEVELS");

  // Stated vs geometric R:R. gradeCall pays +riskReward on a win, so an inflated
  // claim is a direct overstatement of the record.
  const rrGeom = Math.abs(t.takeProfit1 - t.entryPrice) / riskDist;
  components.rrGeom = round(rrGeom, 2);
  if (typeof t.riskReward === "number" && t.riskReward > 0) {
    components.rrStated = t.riskReward;
    const abs = Math.abs(t.riskReward - rrGeom);
    if (abs > cfg.rrTolerance && abs / Math.max(rrGeom, 0.01) > cfg.rrRelTolerance) flags.push("RR_MISMATCH");
  }

  // Where was the market when the call was posted?
  const atSec = Math.floor((t.createdAt || 0) / 1000);
  const idx = cd ? candleIndexAt(cd, atSec) : -1;
  if (idx >= 0) {
    const mark = Number(cd.c?.[idx]);
    if (Number.isFinite(mark) && mark) {
      // Signed in the direction of the trade: positive = the move already happened.
      const favourable = long ? mark - t.entryPrice : t.entryPrice - mark;
      const driftR = favourable / riskDist;
      components.markAtPost = round(mark, 8);
      components.entryDriftR = round(driftR, 2);
      if (driftR > cfg.lateEntryR) flags.push("LATE_ENTRY");
    }
    // Stop distance vs what a single bar routinely does.
    const regime = classifyRegime(cd, atSec);
    if (regime?.atrPct != null) {
      const atrAbs = (regime.atrPct / 100) * Math.abs(Number(cd.c[idx]) || t.entryPrice);
      if (atrAbs > 0) {
        const stopAtr = riskDist / atrAbs;
        components.stopAtr = round(stopAtr, 2);
        if (stopAtr < cfg.stopNoiseAtr) flags.push("STOP_IN_NOISE");
        else if (stopAtr > cfg.stopWideAtr) flags.push("STOP_TOO_WIDE");
      }
    }
  }

  let score = 100;
  for (const f of flags) score -= PLAN_PENALTY[f] || 0;
  return { score: Math.max(0, Math.min(100, score)), flags, components };
}

// ── Expected time to resolution ──────────────────────────────────────────────
// A call is graded on FIRST TOUCH of its target or stop, so "when will I know?" is a
// real question with a real answer — and one nobody asks until they've been waiting
// three days. It also tells a trader something about the call itself: levels a few
// hours apart are a coin flip on noise; levels three weeks apart are a different trade
// than the one they think they're making.
//
// Model: driftless random walk with two absorbing barriers. For per-bar volatility σ
// and barriers a (to the stop) and b (to the target), expected first-passage time is
// a·b/σ² bars. Driftless is the honest assumption — if we could predict direction we
// wouldn't be estimating timing.
//
// ⚠️ First-passage times are heavily right-skewed: the MEAN sits well above the median,
// so this is a rough order of magnitude, not a forecast. Present the bucket, not the
// number, and never imply a deadline.
// Boundaries are deliberately generous because the number they bucket is a MEAN, and
// first-passage times are right-skewed — the typical (median) wait lands well below
// it. Labelling a 168h mean "a few days" is honest for that reason; labelling it
// "a week" would systematically overstate the wait.
export const RESOLUTION_BUCKETS = [
  { maxHours: 6, label: "hours" },
  { maxHours: 36, label: "about a day" },
  { maxHours: 168, label: "a few days" },
  { maxHours: 504, label: "a week or two" },
  { maxHours: Infinity, label: "weeks" },
];

/**
 * @param {object} t  { entryPrice, stopLoss, takeProfit1 }
 * @param {number} atrPct  per-bar (hourly) range as % of price — classifyRegime.atrPct
 * @returns {{hours:number, label:string, basis:string}|null}
 */
export function estimateResolution(t, atrPct) {
  if (!t || !Number.isFinite(atrPct) || atrPct <= 0) return null;
  const entry = Number(t.entryPrice), stop = Number(t.stopLoss), tp = Number(t.takeProfit1);
  if (!entry || !stop || !tp) return null;
  // Work in % of price so ATR% is directly comparable.
  const a = Math.abs((entry - stop) / entry) * 100;
  const b = Math.abs((tp - entry) / entry) * 100;
  if (!a || !b) return null;
  const hours = (a * b) / (atrPct * atrPct);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const bucket = RESOLUTION_BUCKETS.find((x) => hours <= x.maxHours) || RESOLUTION_BUCKETS[RESOLUTION_BUCKETS.length - 1];
  return {
    hours: Math.round(hours),
    label: bucket.label,
    basis: `${round(atrPct, 3)}%/h typical range · stop ${round(a, 2)}% away, target ${round(b, 2)}%`,
  };
}

/** Mean plan score + how often each flag fired, across a set of scored calls. */
export function planSummary(scored) {
  const rows = (scored || []).filter((s) => s && typeof s.score === "number");
  if (!rows.length) return null;
  const flagCounts = {};
  for (const r of rows) for (const f of r.flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
  const worst = Object.entries(flagCounts).sort((a, b) => b[1] - a[1])[0] || null;
  return {
    scored: rows.length,
    score: Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length),
    flagCounts,
    topFlag: worst ? { flag: worst[0], count: worst[1], rate: round((worst[1] / rows.length) * 100, 1) } : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPECTANCY  (rank on how much an average call is WORTH, not how often it wins)
// ═══════════════════════════════════════════════════════════════════════════
// The old board ranked on 0.5·hitRate + 0.5·rScore. That quietly teaches the wrong
// lesson: most genuinely great traders sit around 40% hit rate with a fat right
// tail, and would rank BELOW a scalper who books +0.2R fifteen times. Hit rate is a
// vanity number — what pays rent is expectancy (mean R per call) and whether the
// wins are big enough to carry the losses (profit factor). We keep hit rate as a
// DISPLAYED stat, but it no longer gates or dominates the ranking.
//
// rows = [{ r:number, win:boolean, conviction?:number }] — the same graded R the
// leaderboard already trusts, so this stays trustless.

export function expectancyStats(rows) {
  const list = (rows || []).filter((x) => x && Number.isFinite(x.r));
  const n = list.length;
  if (!n) return null;
  const expectancy = list.reduce((s, x) => s + x.r, 0) / n;         // mean R per call
  let grossWin = 0, grossLoss = 0;
  const winRs = [];
  for (const x of list) {
    if (x.r > 0) { grossWin += x.r; winRs.push(x.r); }
    else grossLoss += Math.abs(x.r);
  }
  // Profit factor: R won per R lost. Capped, and Infinity-guarded (no losses yet).
  const profitFactor = grossLoss > 0 ? Math.min(grossWin / grossLoss, 99) : (grossWin > 0 ? 99 : 0);
  // Tail concentration: what share of all winning-R came from the top 20% of wins.
  // High = a few fat tails carry the record (the elite-trader signature); it's a
  // description, not a demerit — but it tells a copier what they're really buying.
  winRs.sort((a, b) => b - a);
  const topN = Math.max(1, Math.ceil(winRs.length * 0.2));
  const topSum = winRs.slice(0, topN).reduce((s, r) => s + r, 0);
  const tailRatio = grossWin > 0 ? topSum / grossWin : 0;
  return {
    expectancy: round(expectancy, 3),
    profitFactor: round(profitFactor, 2),
    tailRatio: round(tailRatio, 2),
    avgWinR: winRs.length ? round(grossWin / winRs.length, 2) : 0,
    avgLossR: (n - winRs.length) ? round(grossLoss / (n - winRs.length), 2) : 0,
  };
}

// Expectancy-forward ranking score. Primary term is expectancy; a minority
// profit-factor term rewards making the wins actually pay for the losses. Hit rate
// is deliberately absent.
//
// The expectancy estimate is SHRUNK toward 0 (the null "no edge" hypothesis) by a
// prior of `priorCount` pseudo-calls: shrunk = exp · n/(n+priorCount). This is a
// Bayesian shrinkage, not a flat confidence multiply — the difference matters. A
// 5-of-5 streak of pure +2R maxes out a plain expectancy term, and a multiply-at-
// the-end can't pull it under a proven 40-call book; shrinking the ESTIMATE does,
// because 5 samples barely move it off zero while 40 samples nearly fully credit it.
// Returns 0..100.
export const CALLER_SCORE = { priorCount: 12, expCap: 1.5, pfSpan: 2 };
export function callerScore(stats, cfg = CALLER_SCORE) {
  const exp = Number(stats?.expectancy);
  const pf = Number(stats?.profitFactor);
  const calls = Number(stats?.calls) || 0;
  if (!Number.isFinite(exp)) return 0;
  const shrunkExp = exp * (calls / (calls + cfg.priorCount));                 // toward 0 by sample
  const rScore = Math.max(0, Math.min(shrunkExp, cfg.expCap)) / cfg.expCap;
  const pfScore = Math.max(0, Math.min((pf - 1) / cfg.pfSpan, 1));            // PF 1→0, PF 1+span→1
  return Math.round((0.75 * rScore + 0.25 * pfScore) * 1000) / 10;
}

// ── Conviction calibration ───────────────────────────────────────────────────
// The question no P&L number answers: when you bet BIGGER, were you actually more
// right? A trader whose largest-conviction calls are their best has an edge they
// can lean into; one whose sizing is uncorrelated (or inverted) is leaving money on
// the table — or worse, sizing up on hope. conviction = the trader's own size proxy
// (riskPercent, else planned riskReward). We split at the median and compare avg R.
// Withheld unless conviction actually VARIES and both halves have a real sample —
// a "calibrated" badge earned by luck would be exactly the noise we refuse to ship.
export const CALIBRATION = { minPerHalf: 4, minGapR: 0.25 };
export function convictionCalibration(rows, cfg = CALIBRATION) {
  const list = (rows || []).filter((x) => x && Number.isFinite(x.r) && Number.isFinite(x.conviction));
  if (list.length < cfg.minPerHalf * 2) return null;
  const convs = list.map((x) => x.conviction).sort((a, b) => a - b);
  if (convs[convs.length - 1] - convs[0] <= 0) return null; // sized everything the same → nothing to calibrate
  // TRUE median value (interpolated for even n) as the threshold — NOT a single
  // element. On a two-valued distribution (e.g. all conviction ∈ {1,3}) picking an
  // element lands the split ON a value and empties a half; the interpolated median
  // (2) cleanly separates the groups. Ties (== median) go low.
  const n = convs.length;
  const median = n % 2 ? convs[(n - 1) / 2] : (convs[n / 2 - 1] + convs[n / 2]) / 2;
  const high = list.filter((x) => x.conviction > median);
  const low = list.filter((x) => x.conviction <= median);
  if (high.length < cfg.minPerHalf || low.length < cfg.minPerHalf) return null;
  const mean = (a) => a.reduce((s, x) => s + x.r, 0) / a.length;
  const highR = mean(high), lowR = mean(low);
  const gap = highR - lowR;
  return {
    highR: round(highR, 2), lowR: round(lowR, 2), gap: round(gap, 2),
    highN: high.length, lowN: low.length,
    // Calibrated = the bigger bets genuinely did better, by a margin worth trusting.
    calibrated: gap >= cfg.minGapR,
    inverted: gap <= -cfg.minGapR, // sized up on the WORSE calls — the costly anti-signal
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DISAGREEMENT BOARD  (where the sharp callers are OPPOSED right now)
// ═══════════════════════════════════════════════════════════════════════════
// Consensus is cheap and mostly worthless — "everyone's long BTC" tells a trader
// nothing they can act on. The signal is DISAGREEMENT: the symbols where credible
// callers are taking opposite sides at this moment. That's where the interesting
// read is, where copy-decisions actually matter, and it's the most clickable thing
// on the page. Built from data we already publish — open positions (/agents/live)
// and active public calls — so it's a pure recombination, no new source.
//
// entries: [{ wallet, symbol, direction:"LONG"|"SHORT", weight?, source? }]
// weight defaults to 1; callers can pass credibility (e.g. merit-rank tier) so a
// standoff between two Apex callers outranks two anonymous wallets.

export const CONTESTED = { minPerSide: 1, minParticipants: 2 };

export function contestedBoard(entries, cfg = CONTESTED) {
  // 1) One stance per wallet per symbol. A wallet holding a position AND a call the
  //    same way counts ONCE; a wallet on both sides of the same symbol is
  //    self-contradicting → dropped for that symbol (its vote is meaningless).
  const perWalletSym = new Map(); // `${wallet}|${symbol}` → { direction, weight, wallet, symbol, sources:Set }
  for (const e of entries || []) {
    if (!e || !e.wallet || !e.symbol) continue;
    const dir = String(e.direction).toUpperCase();
    if (dir !== "LONG" && dir !== "SHORT") continue;
    const key = `${String(e.wallet).toLowerCase()}|${e.symbol}`;
    const w = Number(e.weight) > 0 ? Number(e.weight) : 1;
    const cur = perWalletSym.get(key);
    if (!cur) { perWalletSym.set(key, { wallet: e.wallet, symbol: e.symbol, direction: dir, weight: w, conflict: false, sources: new Set(e.source ? [e.source] : []) }); continue; }
    if (cur.conflict) continue;
    if (cur.direction !== dir) { cur.conflict = true; continue; } // opposite stances → void this wallet here
    cur.weight = Math.max(cur.weight, w); // same side twice → strongest weight, not double
    if (e.source) cur.sources.add(e.source);
  }

  // 2) Group the surviving stances by symbol into long/short camps.
  const bySym = {};
  for (const s of perWalletSym.values()) {
    if (s.conflict) continue;
    const g = bySym[s.symbol] || (bySym[s.symbol] = { symbol: s.symbol, longs: [], shorts: [], longWeight: 0, shortWeight: 0 });
    const camp = s.direction === "LONG" ? "longs" : "shorts";
    g[camp].push({ wallet: s.wallet, weight: s.weight, sources: [...s.sources] });
    g[s.direction === "LONG" ? "longWeight" : "shortWeight"] += s.weight;
  }

  // 3) Keep only genuinely contested symbols, and rank by TENSION = how evenly the
  //    weight is split (a true standoff) × how much total weight is on the table.
  //    A balanced 3-vs-3 of sharps beats a lopsided 5-vs-1 of unknowns.
  const out = [];
  for (const g of Object.values(bySym)) {
    const nLong = g.longs.length, nShort = g.shorts.length;
    if (nLong < cfg.minPerSide || nShort < cfg.minPerSide) continue;
    if (nLong + nShort < cfg.minParticipants) continue;
    const total = g.longWeight + g.shortWeight;
    const balance = total > 0 ? 1 - Math.abs(g.longWeight - g.shortWeight) / total : 0; // 1 = dead even
    const tension = round(balance * total, 3);
    out.push({
      symbol: g.symbol,
      longs: g.longs.sort((a, b) => b.weight - a.weight),
      shorts: g.shorts.sort((a, b) => b.weight - a.weight),
      longCount: nLong, shortCount: nShort,
      longWeight: round(g.longWeight, 2), shortWeight: round(g.shortWeight, 2),
      balance: round(balance, 2),
      tension,
    });
  }
  out.sort((a, b) => b.tension - a.tension || (b.longCount + b.shortCount) - (a.longCount + a.shortCount));
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// MISPRICED BOARD  (the funding-edge lens — price every market, surface the gap)
// ═══════════════════════════════════════════════════════════════════════════
// Borrowed framing (Quotient): don't just list calls — price every market and
// surface where the MARKET diverges from FAIR. A perp has no oracle "fair value",
// but the funding rate IS the crowd's mispricing made explicit: persistently
// positive funding = longs paying to hold = the book is lopsided long = a
// mean-revert (fade) edge to the SHORT side, and vice-versa. We annualize the
// per-8h funding rate into a comparable "edge %/yr", rank markets by |edge|, and
// mark the extreme tail MISPRICED · WATCHING and the rest PRICED FAIR — a market
// dashboard where the sort order itself is the signal.
//
// rows: Orderly /v1/public/futures rows (symbol, mark_price, last_funding_rate,
//       open_interest, 24h_open). Pure + tested — the route just feeds it live rows.
export const MISPRICED = {
  fundingPeriodsPerYear: 3 * 365, // Orderly funds every 8h → 1095 periods/yr
  minEdgePct: 12,    // |annualized funding| ≥ this ⇒ flagged MISPRICED · WATCHING. 12%/yr
                     // (~0.011%/8h) is the noise floor on this venue — below it "mispriced"
                     // means nothing; scarcity is the point (few, genuine, over many, mild).
  minOiUsd: 50_000,  // liquidity floor — a wide funding print on a dust market is noise, not edge
  maxMarkets: 40,    // board cap (returned already ranked by edge)
};

export function mispricedBoard(rows, cfg = MISPRICED) {
  const bare = (s) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
  const markets = [];
  let scanned = 0;
  for (const r of rows || []) {
    const symbol = r && r.symbol;
    if (!symbol || !String(symbol).startsWith("PERP_")) continue;
    const mark = Number(r.mark_price);
    const funding = Number(r.last_funding_rate);
    if (!Number.isFinite(mark) || mark <= 0 || !Number.isFinite(funding)) continue;
    // open_interest is in BASE units → price it in USD for a comparable liquidity floor.
    const oiUsd = (Number(r.open_interest) || 0) * mark;
    if (oiUsd < cfg.minOiUsd) continue;
    scanned++;
    const open24 = Number(r["24h_open"]);
    const change24hPct = (Number.isFinite(open24) && open24 > 0) ? round(((mark - open24) / open24) * 100, 2) : null;
    const fundingAnnualPct = round(funding * cfg.fundingPeriodsPerYear * 100, 2);
    markets.push({
      symbol, coin: bare(symbol),
      markPrice: mark,
      funding8hPct: round(funding * 100, 5),  // % per 8h period (the raw crowd cost)
      fundingAnnualPct,
      oiUsd: Math.round(oiUsd),
      change24hPct,
      // Fade the crowd: they pay to be long → the edge is SHORT, and vice-versa.
      direction: funding > 0 ? "SHORT" : funding < 0 ? "LONG" : "NONE",
      edge: Math.abs(fundingAnnualPct),
      status: "PRICED_FAIR",
    });
  }
  markets.sort((a, b) => b.edge - a.edge);
  for (const m of markets) {
    if (m.edge >= cfg.minEdgePct && m.direction !== "NONE") m.status = "MISPRICED";
  }
  return {
    scanned,
    mispricedCount: markets.filter((m) => m.status === "MISPRICED").length,
    markets: markets.slice(0, cfg.maxMarkets),
  };
}

// ── Per-symbol merit-weighted caller LEAN (the consensus companion to the board) ──
// The mispriced board reads the FUNDING crowd; this reads the graded, credible
// CALLERS. Same weighted stances as the disagreement board (open positions + active
// public calls, weighted by earned merit tier), collapsed to ONE lean per symbol
// instead of only the contested ones — so a market can show the interesting
// divergence ("funding fade = SHORT, sharp callers lean LONG") or agreement. A
// wallet on both sides of a symbol is voided there (same rule as contestedBoard).
//
// entries: [{ wallet, symbol, direction:"LONG"|"SHORT", weight? }] — symbol should be
// the BARE coin so it joins the board's coin key. Returns { [coin]: { side, lean, … } }.
export function consensusBySymbol(entries, cfg = { minLean: 0.15 }) {
  const perWalletSym = new Map();
  for (const e of entries || []) {
    if (!e || !e.wallet || !e.symbol) continue;
    const dir = String(e.direction).toUpperCase();
    if (dir !== "LONG" && dir !== "SHORT") continue;
    const key = `${String(e.wallet).toLowerCase()}|${e.symbol}`;
    const w = Number(e.weight) > 0 ? Number(e.weight) : 1;
    const cur = perWalletSym.get(key);
    if (!cur) { perWalletSym.set(key, { symbol: e.symbol, direction: dir, weight: w, conflict: false }); continue; }
    if (cur.conflict) continue;
    if (cur.direction !== dir) { cur.conflict = true; continue; } // self-contradiction → void
    cur.weight = Math.max(cur.weight, w); // same side twice → strongest weight, not double
  }
  const bySym = {};
  for (const s of perWalletSym.values()) {
    if (s.conflict) continue;
    const g = bySym[s.symbol] || (bySym[s.symbol] = { longWeight: 0, shortWeight: 0, longCount: 0, shortCount: 0 });
    if (s.direction === "LONG") { g.longWeight += s.weight; g.longCount++; }
    else { g.shortWeight += s.weight; g.shortCount++; }
  }
  const out = {};
  for (const [sym, g] of Object.entries(bySym)) {
    const total = g.longWeight + g.shortWeight;
    const lean = total > 0 ? (g.longWeight - g.shortWeight) / total : 0;
    out[sym] = {
      side: lean >= cfg.minLean ? "LONG" : lean <= -cfg.minLean ? "SHORT" : "SPLIT",
      lean: round(lean, 2),
      longWeight: round(g.longWeight, 2), shortWeight: round(g.shortWeight, 2),
      longCount: g.longCount, shortCount: g.shortCount,
      participants: g.longCount + g.shortCount,
    };
  }
  return out;
}

// ── Contrarian grading (historical stance snapshots) ─────────────────────────
// The caller-graph's sharpest signal: was a call made AGAINST the crowd's lean at the
// moment it was posted — and did fading the crowd pay? Requires a persisted history of
// the merit-weighted consensus lean per symbol (`stance:hist:{symbol}`); this pure layer
// just reads that history and classifies. ⚠️ gradeCall is NEVER touched — contrarian-ness
// is an ATTRIBUTE of the call's context, exactly like regime attribution. Pure + tested.

// The nearest consensus snapshot at/before a call's post time that carries a real lean.
// Returns { side, participants } or null (cold-start / thin / all snapshots post-date it).
export function stanceAtPost(history, createdAtMs, cfg = {}) {
  const minParticipants = cfg.minParticipants ?? 2;
  const t0 = Number(createdAtMs);
  if (!Array.isArray(history) || !Number.isFinite(t0)) return null;
  let best = null;
  for (const s of history) {
    if (!s || !Number.isFinite(Number(s.t)) || Number(s.t) > t0) continue;
    const side = s.side === "LONG" || s.side === "SHORT" ? s.side : null;
    if (!side) continue;                                   // SPLIT/ambiguous ticks aren't a lean
    if ((Number(s.participants) || 0) < minParticipants) continue;
    if (!best || Number(s.t) > Number(best.t)) best = s;   // latest qualifying snapshot ≤ post time
  }
  return best ? { side: best.side, participants: Number(best.participants) || 0 } : null;
}

// A call vs the crowd lean it was posted into. null when there's no qualifying lean.
export function classifyContrarian(direction, leanSide) {
  const d = String(direction || "").toUpperCase();
  if ((d !== "LONG" && d !== "SHORT") || (leanSide !== "LONG" && leanSide !== "SHORT")) return null;
  return d === leanSide ? "WITH_CROWD" : "CONTRARIAN";
}

// Rank a caller's contrarian record. Only when the contrarian sample clears minCalls; the
// score is the contrarian avg-R SHRUNK by sample so a couple of lucky fades can't top a
// long record, and `edge` is how much better (or worse) they do fading vs following the
// crowd. Returns null (unranked) below the sample gate. contrarian/withCrowd are the
// aggregateSideRecord shape ({ calls, winRate, avgR }).
export function contrarianEdgeScore(contrarian, withCrowd, cfg = {}) {
  const minCalls = cfg.minCalls ?? 3, K = cfg.K ?? 4;
  const cCalls = contrarian?.calls || 0;
  if (cCalls < minCalls) return null;
  const cAvg = contrarian.avgR ?? 0;
  const wAvg = (withCrowd?.calls || 0) ? (withCrowd.avgR ?? 0) : 0;
  const edge = Math.round((cAvg - wAvg) * 100) / 100;
  const score = Math.round(cAvg * (cCalls / (cCalls + K)) * 1000) / 1000; // shrunk contrarian avg-R
  return { calls: cCalls, wins: contrarian.wins ?? null, winRate: contrarian.winRate ?? null, avgR: cAvg, edge, score };
}

// ── Funding reversion — the learnable "proof" stat ────────────────────────────
// "The last N times funding ran THIS hot, what did price do?" From the brain's
// oi:hist series ({t,price,funding}), find PAST moments where funding was in the same
// extreme (same sign, ≥ band × the current rate), then measure the price move over the
// next `horizonH` hours AGAINST the crowd (crowd long → a DROP is reversion; crowd
// short → a RISE is). Samples are NON-OVERLAPPING (jump past each window) so the count
// isn't inflated by one long funding streak. Returns null below minSamples — an honest
// "not enough history" beats a confident number drawn from three correlated bars.
export const REVERSION = { horizonH: 72, band: 0.7, minSamples: 4 };

export function fundingReversion(points, cfg = REVERSION) {
  if (!Array.isArray(points) || points.length < 12) return null;
  const pts = points
    .map((p) => ({ t: Number(p.t), price: Number(p.price), funding: Number(p.funding) }))
    .filter((p) => Number.isFinite(p.t) && p.price > 0 && Number.isFinite(p.funding))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 12) return null;
  const curF = pts[pts.length - 1].funding;
  if (!curF) return null;
  const sign = curF > 0 ? 1 : -1;
  const thresh = Math.abs(curF) * cfg.band;
  const horizonMs = cfg.horizonH * 3600 * 1000;

  // First index whose timestamp is ≥ t+horizon (the price we compare against), or -1.
  const forwardIdx = (i) => {
    const target = pts[i].t + horizonMs;
    for (let j = i + 1; j < pts.length; j++) if (pts[j].t >= target) return j;
    return -1;
  };

  const against = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    if (Math.sign(p.funding) !== sign || Math.abs(p.funding) < thresh) continue;
    const j = forwardIdx(i);
    if (j < 0) break; // no full horizon remaining
    const movePct = ((pts[j].price - p.price) / p.price) * 100;
    against.push(sign > 0 ? -movePct : movePct); // + = price moved AGAINST the crowd (reverted)
    i = j; // non-overlapping — jump past this window
  }
  if (against.length < cfg.minSamples) return null;
  const avg = against.reduce((s, x) => s + x, 0) / against.length;
  const reverted = against.filter((x) => x > 0).length;
  const sorted = [...against].sort((a, b) => a - b);
  return {
    samples: against.length,
    horizonDays: Math.round(cfg.horizonH / 24),
    avgReversionPct: round(avg, 2),                 // + = price gave back (reverted) on average
    medianReversionPct: round(sorted[Math.floor((sorted.length - 1) / 2)], 2),
    revertedPct: Math.round((reverted / against.length) * 100),
    crowd: sign > 0 ? "long" : "short",
  };
}

// Merge Orderly's PUBLIC funding-rate history (rows: {funding_rate, funding_rate_
// timestamp ms}) with 1h price candles (priceData: {t:[sec], c:[close]}) into the
// {t,price,funding} series fundingReversion expects — so edge quality works for ANY
// market from public data, not just the core symbols we record oi:hist for. For each
// funding stamp, take the close of the most recent candle at/before it (two-pointer;
// both inputs sorted ascending here). Pure + tested.
export function mergeFundingPrice(fundingRows, priceData) {
  if (!Array.isArray(fundingRows) || !priceData || !Array.isArray(priceData.t) || !Array.isArray(priceData.c)) return [];
  const t = priceData.t, c = priceData.c;
  if (!t.length) return [];
  const fr = fundingRows
    .map((r) => ({ ts: Number(r.funding_rate_timestamp), f: Number(r.funding_rate) }))
    .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.f))
    .sort((a, b) => a.ts - b.ts);
  const out = [];
  let pi = 0;
  for (const { ts, f } of fr) {
    const tsSec = ts / 1000;
    while (pi + 1 < t.length && t[pi + 1] <= tsSec) pi++;
    const price = Number(c[pi]);
    if (Number.isFinite(price) && price > 0) out.push({ t: ts, price, funding: f });
  }
  return out;
}

// ── Edge quality — the board's SELF-AWARENESS about its own signal ────────────
// Funding tells you the crowd is stretched; it does NOT tell you the fade actually
// pays. This grades a flagged market by whether fading it has HISTORICALLY reverted
// (from fundingReversion). PROVEN = fades here have paid; TRAP = funding is stretched
// but fading it has LOST (price kept going the crowd's way); MIXED = coin-flip;
// UNPROVEN = not enough recorded history to say. Keeps "mispriced by funding" honest
// about whether the mean-revert actually shows up — most funding tools stop at the
// number; this pairs the number with its track record.
export const EDGE_QUALITY = { proven: 55, trap: 42 };

export function edgeQuality(reversion, cfg = EDGE_QUALITY) {
  if (!reversion || !reversion.samples) return { tier: "UNPROVEN", revertedPct: null, samples: 0 };
  const r = reversion.revertedPct;
  const tier = r >= cfg.proven ? "PROVEN" : r <= cfg.trap ? "TRAP" : "MIXED";
  return { tier, revertedPct: r, samples: reversion.samples };
}

// Rank order for the board: proven edge first, traps last (avoid fading them).
export const EDGE_QUALITY_RANK = { PROVEN: 0, MIXED: 1, UNPROVEN: 2, TRAP: 3 };

// ── HOUSE SIGNALS — the systematic track record that SEEDS the caller board ────
// Turn a mispriced-board fade into a concrete, gradeable CALL published under a house
// identity. The whole point of the trustless graph is proof; a live, honestly-graded
// house record (graded by the SAME public first-touch engine as any human call) fills
// the empty boards + demonstrates the methodology + becomes share content. Levels are
// DETERMINISTIC: entry = mark, TP toward the mean-revert, SL against, at a fixed R;
// direction = the fade side (opposite the crowd). Returns null when there's no fade.
export const HOUSE_CALL = { tpPct: 4, slPct: 3 }; // ~1.33R mean-reversion fade

export function houseCallFromSignal(m, now = Date.now(), cfg = HOUSE_CALL) {
  if (!m || m.direction === "NONE" || !(Number(m.markPrice) > 0)) return null;
  const entry = Number(m.markPrice);
  const long = m.direction === "LONG";
  const dp = entry >= 1000 ? 1 : entry >= 1 ? 3 : 6;
  const takeProfit1 = round(long ? entry * (1 + cfg.tpPct / 100) : entry * (1 - cfg.tpPct / 100), dp);
  const stopLoss = round(long ? entry * (1 - cfg.slPct / 100) : entry * (1 + cfg.slPct / 100), dp);
  const fund = Number(m.fundingAnnualPct);
  const fundTxt = `${fund >= 0 ? "+" : ""}${fund}%/yr`;
  return {
    id: `nexus-${m.coin}-${now}`,
    symbol: m.coin,
    direction: m.direction,
    entryPrice: entry,
    stopLoss,
    takeProfit1,
    takeProfit2: 0,
    riskReward: round(cfg.tpPct / cfg.slPct, 2),
    // Full thesis shape (the UI reads these) — a partial object crashed ThesisCard's
    // `leverage.toFixed`. Systematic calls have no sizing, so these are 0/neutral.
    riskPercent: 0, accountSize: 0, fundingRate: 0, positionSize: 0, leverage: 0,
    fundingCost8h: 0, fundingCost24h: 0, fundingCost72h: 0,
    createdAt: now,
    status: "ACTIVE",
    actualPnl: null,
    isPublic: true,
    source: "nexus-signal", // marks the systematic house call (vs a human thesis)
    catalyst: `Funding fade - ${fundTxt}`,
    notes: `Systematic Nexus signal - funding on ${m.coin} is stretched (${fundTxt}), fading the one-sided crowd for the mean-revert. Graded trustlessly from public price, first-touch TP vs SL. Not advice.`,
  };
}

// ── MIROSHARK WAR-GAME — turn a Lab object into a good simulation scenario ─────
// Miroshark (x402.miroshark.xyz/run) spawns hundreds of grounded agents that argue +
// trade a prediction market on a scenario. We use it as a WAR-GAME / red-team, NEVER a
// signal (it's synthetic — what agents THINK would happen). This builds the natural-
// language `query` that gets the most useful red-team out of it: always ask for the bull
// case, the bear case, the invalidation, and where consensus lands (the trader's blind
// spots). Decision-independent (no payment here) so it's stable across how we meter it.
export function wargameScenario(input) {
  const kind = input && input.kind;
  const tail = "Surface the strongest bull case, the strongest bear case, what would invalidate it, and where consensus lands.";
  if (kind === "thesis") {
    const coin = input.coin || "the asset";
    const dir = input.direction === "LONG" ? "rises" : input.direction === "SHORT" ? "falls" : "moves";
    const tgt = input.target ? ` toward ${input.target}` : "";
    const from = input.entry ? ` from ${input.entry}` : "";
    const notes = input.notes ? ` Context: ${String(input.notes).slice(0, 400)}` : "";
    return `Simulate how crypto traders, online communities, and a prediction market would react over the next 1-2 weeks if ${coin} ${dir}${tgt}${from}.${notes} ${tail}`.trim();
  }
  if (kind === "macro") {
    const q = input.question || "this event";
    const prob = Number.isFinite(input.yesProbPct) ? ` The crowd currently prices it at ${input.yesProbPct}% YES.` : "";
    const lens = input.lens ? ` It's a ${input.lens} setup for crypto.` : "";
    return `Simulate how markets and online communities would react to this event resolving both YES and NO: "${q}".${prob}${lens} Model the reaction paths and the second-order effects on crypto (BTC/ETH). ${tail}`;
  }
  const free = String((input && input.query) || "").trim();
  return free ? `Simulate reactions to: ${free}. ${tail}` : "";
}

// ═══════════════════════════════════════════════════════════════════════════
// LOSS POSTMORTEMS  (why did it lose — from a FIXED taxonomy, so it aggregates)
// ═══════════════════════════════════════════════════════════════════════════
// Grading tells a trader THAT a call lost; it can't tell them WHY, and "why" is
// where improvement lives. A free-text note doesn't aggregate; a FIXED taxonomy
// does — which turns one trader's honesty into a community artifact ("the #1 leak
// this week is oversizing"). Six mutually-exclusive reasons, each a distinct,
// fixable failure mode. Self-reported (it's introspection, not a price fact) — so
// it NEVER touches the trustless leaderboard; it's a coaching + culture surface.
//
// ⚠️ Mirrored on the client in app/lib/postmortem.mjs (LOSS_REASONS) — keep the KEY
// set identical. The pinned key-set tests on both sides catch drift.
export const LOSS_REASONS = [
  { key: "THESIS_WRONG", label: "Thesis was wrong",  hint: "The idea itself failed — the market did the opposite for real reasons." },
  { key: "EARLY",        label: "Entered too early", hint: "Right idea, wrong time — stopped out before it worked." },
  { key: "OVERSIZED",    label: "Position too big",  hint: "Sizing, not analysis — a normal loss hurt more than it should have." },
  { key: "NO_STOP",      label: "Ignored my stop",   hint: "Moved or abandoned the stop — the one unforgivable one." },
  { key: "CHASED",       label: "Chased the entry",  hint: "Bought the move instead of the level — paid up, no edge left." },
  { key: "REVENGE",      label: "Revenge trade",     hint: "Traded to win money back, not because the setup was there." },
];
const LOSS_REASON_KEYS = new Set(LOSS_REASONS.map((r) => r.key));
export function isLossReason(x) { return typeof x === "string" && LOSS_REASON_KEYS.has(x); }

/**
 * Tally a set of postmortem reasons (junk/injected values ignored via the enum).
 * @param {string[]} reasons
 * @returns {{tagged:number, counts:Record<string,number>, top:{reason,count,rate}|null}|null}
 */
export function postmortemSummary(reasons) {
  const valid = (reasons || []).filter(isLossReason);
  if (!valid.length) return null;
  const counts = {};
  for (const r of valid) counts[r] = (counts[r] || 0) + 1;
  const [topReason, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return {
    tagged: valid.length,
    counts,
    top: { reason: topReason, count: topCount, rate: round((topCount / valid.length) * 100, 1) },
  };
}

// ── PRO subscription payment verification ───────────────────────────────────
// Pure: given an eth_getTransactionReceipt result, decide whether it contains a
// qualifying ERC-20 (USDC) Transfer to the subscription receiver, and who paid.
// No network here — the caller fetches the receipt and persists the grant.
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Pure: how many SIM CREDITS an on-chain payment buys. amountUnits = the ERC-20 amount
// (bigint/string), decimals = token decimals, usdPerToken = USD value per whole token
// (1 for USDC, live price for $NEXUS), usdPerCredit = price of one sim (default $1). Floors
// to whole credits so a partial never rounds up. Exported for tests.
export function simCreditsFor(amountUnits, { decimals, usdPerToken = 1, usdPerCredit = 1 }) {
  const amt = Number(amountUnits) / Math.pow(10, Number(decimals) || 0);
  const usd = amt * (Number(usdPerToken) || 0);
  const credits = Math.floor(usd / (Number(usdPerCredit) || 1));
  return credits > 0 ? credits : 0;
}

export function verifyErc20Payment(receipt, { token, receiver, minAmount }) {
  if (!receipt || receipt.status !== "0x1") return { ok: false, reason: "tx not successful" };
  const tokenL = String(token).toLowerCase();
  const recvTopic = "0x" + String(receiver).toLowerCase().slice(2).padStart(64, "0");
  for (const log of receipt.logs || []) {
    if ((log.address || "").toLowerCase() !== tokenL) continue;
    if (!log.topics || log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if ((log.topics[2] || "").toLowerCase() !== recvTopic) continue;
    let amount;
    try { amount = BigInt(log.data); } catch { continue; }
    if (amount >= minAmount) {
      const from = "0x" + (log.topics[1] || "").slice(-40);
      return { ok: true, from: from.toLowerCase(), amount: amount.toString() };
    }
  }
  return { ok: false, reason: "no qualifying transfer to receiver" };
}

// Minimum token units we'll accept for a $NEXUS-denominated payment, given a live
// USD price, the target USD amount, and a tolerance band (low-liquidity token moves
// between quote and settlement). Pure — caller supplies the price. Returns BigInt
// (token base units) or null if unpriceable.
export function nexusMinUnits(priceUsd, discountUsd, tolerance, decimals = 18) {
  if (!(priceUsd > 0) || !(discountUsd > 0)) return null;
  const wholeTokens = Math.floor((discountUsd / priceUsd) * (1 - tolerance));
  if (!(wholeTokens > 0)) return null;
  return BigInt(wholeTokens) * (10n ** BigInt(decimals));
}

// ── Hosted NEXUS AI model tiers ─────────────────────────────────────────────
// PRO users pick which model the hosted proxy runs; each model carries its OWN
// daily cap so our LLM spend scales with model cost. Stronger model → lower cap;
// cheaper model → higher cap (the user trades model strength for volume). Rates
// per MTok (in/out): Haiku $1/$5 · Sonnet $3/$15 · Opus $5/$25. Default is Sonnet
// (the everyday tier) — Opus is the scarce "big gun". Caps are env-overridable
// (HOSTED_CAP_HAIKU/SONNET/OPUS) for tuning without a code change, and the default
// tier via HOSTED_AI_DEFAULT_MODEL (legacy HOSTED_AI_MODEL still honored as the
// default source). Mirrored on the client in app/config/assistant.ts (HOSTED_TIERS).
export const HOSTED_DEFAULT_MODEL = "claude-sonnet-4-6";

export function hostedCaps(env = {}) {
  return {
    "claude-haiku-4-5": parseInt(env.HOSTED_CAP_HAIKU || "100", 10),
    "claude-sonnet-4-6": parseInt(env.HOSTED_CAP_SONNET || "40", 10),
    "claude-opus-4-8": parseInt(env.HOSTED_CAP_OPUS || "20", 10),
  };
}

// Resolve a client-requested hosted model → an allowed model + its daily cap.
// Whitelist-gated: an unknown / stale / injected id falls back to the default
// tier, so a client can never force an off-list (or arbitrarily expensive) model.
export function resolveHostedModel(requested, env = {}) {
  const caps = hostedCaps(env);
  const wanted = env.HOSTED_AI_DEFAULT_MODEL || env.HOSTED_AI_MODEL || HOSTED_DEFAULT_MODEL;
  const fallback = caps[wanted] != null ? wanted : HOSTED_DEFAULT_MODEL;
  const model = caps[requested] != null ? requested : fallback;
  return { model, cap: caps[model] };
}

// ── Hosted-AI upstream selection (direct Anthropic vs Bankr LLM Gateway) ──────
// Default = Anthropic direct (our ANTHROPIC_API_KEY). When AI_GATEWAY="bankr" and
// BANKR_LLM_KEY is set, route /ai/chat through the Bankr LLM Gateway instead — it's
// Anthropic-compatible (/v1/messages, auth via X-API-Key bk_…), so the request body
// (incl. cache_control) carries over. One env flip A/Bs the gateway against direct
// and falls back instantly. Per-model daily caps stay keyed on the Anthropic-style
// id (resolveHostedModel), so spend accounting is provider-independent.
export const BANKR_GATEWAY_URL = "https://llm.bankr.bot/v1/messages";

// The gateway names models in dot-notation (claude-opus-4.8) vs Anthropic's hyphen
// ids (claude-opus-4-8). Map each tier; every leg is env-overridable so the exact
// gateway id can be corrected from GET https://llm.bankr.bot/v1/models without a
// code change. Unknown ids pass through untouched.
export function bankrGatewayModel(anthropicId, env = {}) {
  const map = {
    "claude-haiku-4-5":  env.BANKR_MODEL_HAIKU  || "claude-haiku-4.5",
    "claude-sonnet-4-6": env.BANKR_MODEL_SONNET || "claude-sonnet-4.6",
    "claude-opus-4-8":   env.BANKR_MODEL_OPUS   || "claude-opus-4.8",
  };
  return map[anthropicId] || anthropicId;
}

// Decide where /ai/chat forwards. `hostedModel` is the Anthropic-style id from
// resolveHostedModel. Returns null if the selected provider isn't configured
// (caller → 503). Header is "x-api-key" for both providers (HTTP headers are
// case-insensitive, so it satisfies Bankr's X-API-Key and Anthropic's x-api-key).
export function resolveAiUpstream(hostedModel, env = {}) {
  if (env.AI_GATEWAY === "bankr" && env.BANKR_LLM_KEY) {
    return {
      provider: "bankr",
      url: BANKR_GATEWAY_URL,
      apiKey: env.BANKR_LLM_KEY,
      model: bankrGatewayModel(hostedModel, env),
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      apiKey: env.ANTHROPIC_API_KEY,
      model: hostedModel,
    };
  }
  return null;
}

// ── Merit rank (identity ladder) ─────────────────────────────────────────────
// A rank EARNED purely from a caller's public-price-graded record — distinct from
// the $NEXUS holder tiers (which are bought/held). This is "proven right", not
// "paid for". Thresholds rise with both sample size and quality so it can't be
// farmed with a few lucky calls. stats = { calls, wins, rSum } from
// computeCallerStats. Returns null when unranked (emerging or net-negative).
export function rankCaller(stats) {
  const calls = stats?.calls || 0;
  if (calls < 5) return null;                 // still emerging — not yet ranked
  const hitRate = stats.wins / calls;          // 0..1
  const avgR = stats.rSum / calls;
  if (avgR <= 0) return null;                  // net-negative by R → unranked (board rule)
  if (calls >= 30 && hitRate >= 0.55 && avgR >= 1.0) return { tier: "APEX", title: "Apex", glyph: "✦" };
  if (calls >= 15 && hitRate >= 0.50 && avgR >= 0.5) return { tier: "SHARP", title: "Sharp", glyph: "◆" };
  return { tier: "SIGNAL", title: "Signal", glyph: "▪" };
}

// ── Contested-standoff edge (which SIDE has the graded record) ───────────────
// The disagreement board shows WHERE credible callers are opposed; this asks which
// side is historically RIGHT. Aggregates each side's participants' graded call
// records (from computeCallerStats' byWallet) into a combined win-rate + avg-R, then
// declares an edge only when BOTH sides have a real sample and the gap is meaningful
// — a verdict drawn from one call on a side is worse than silence (same discipline
// as the regime verdict). Pure + tested; the standoff itself stays trustless.
export function aggregateSideRecord(records) {
  let calls = 0, wins = 0, rSum = 0;
  for (const r of (records || [])) { calls += r?.calls || 0; wins += r?.wins || 0; rSum += r?.rSum || 0; }
  return {
    calls, wins, rSum,
    winRate: calls ? Math.round((wins / calls) * 1000) / 10 : null,
    avgR: calls ? Math.round((rSum / calls) * 100) / 100 : null,
  };
}

// Compare two side aggregates. Returns the side with the better avg-R, but only when
// EACH side has ≥ minCalls graded calls AND the gap clears minGapR — otherwise null
// (withheld), never a coin-flip verdict.
export function standoffVerdict(longAgg, shortAgg, { minCalls = 3, minGapR = 0.3 } = {}) {
  const lC = longAgg?.calls || 0, sC = shortAgg?.calls || 0;
  if (lC < minCalls || sC < minCalls) return { side: null, gapR: 0, reason: "not enough graded calls on both sides yet" };
  const lR = longAgg.avgR ?? 0, sR = shortAgg.avgR ?? 0;
  const gap = Math.round((lR - sR) * 100) / 100;
  if (Math.abs(gap) < minGapR) return { side: null, gapR: gap, reason: "the two sides' records are too close to call" };
  return { side: gap > 0 ? "LONG" : "SHORT", gapR: Math.round(Math.abs(gap) * 100) / 100, reason: null };
}

// ── Tracked x-ray record (persistent, self-grading wallet monitor) ────────────
// The Smart-Money x-ray is a point-in-time read of the public Orderly settlement
// indexer (cumulative realized PnL per market — NO per-trade tape). To turn a
// lookup into an ACCRUING, comparable record we snapshot that aggregate over time
// and grade the SERIES: the delta in cumulative realized PnL between two snapshots
// is the realized PnL the wallet actually earned in that window. From those windows
// we get an honest realized-PnL equity curve, a consistency rate, drawdown control,
// and a transparent score (the `operatorScore` field, shown as "Consistency Score" in
// the UI) — the same "earned, not claimed" discipline the
// caller merit ranks use, applied to any wallet on the network.
//
// ⚠️ Honesty guards baked in: (1) we grade only realized-PnL DELTAS (never the
// cumulative markets/wins/losses, which are lifetime and would double-count history
// the wallet had before we started watching); (2) the score is sample-shrunk toward
// zero so a wallet must earn a track LENGTH, not just one good window; (3) a
// net-negative record earns no tier (mirrors rankCaller's avgR<=0 rule). Pure+tested.
const DAY_MS = 86400 * 1000;
// A window counts toward the consistency score only if its two daily snapshots are
// within this span — 2.5 days absorbs the ~1/day cadence plus a missed cron tick,
// while excluding true gaps (a wallet un-watched then re-watched weeks later).
const MAX_WINDOW_DAYS = 2.5;

// Collapse to at most one snapshot per UTC day (the last wins), sorted ascending.
// The read-seeder + the cron can both write on the same day; without this a busy day
// would manufacture zero-length windows and dilute every rate.
function dedupeDaily(snaps) {
  const byDay = new Map();
  for (const s of (snaps || [])) {
    if (!s || !Number.isFinite(s.t)) continue;
    byDay.set(Math.floor(s.t / DAY_MS), s);
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

export function xrayTrack(snapshots) {
  const snaps = dedupeDaily(snapshots);
  const points = snaps.length;
  if (points < 2) {
    return { points, building: true, latest: snaps[points - 1] || null };
  }
  const first = snaps[0], last = snaps[points - 1];
  const daysTracked = round((last.t - first.t) / DAY_MS, 1);
  const netRealized = Math.round((last.realized || 0) - (first.realized || 0));

  // Per-window realized deltas → cumulative equity curve (continuous; gap-robust).
  // ⚠️ Each window is GRADED only if its two snapshots are ≤ MAX_WINDOW_DAYS apart.
  // A wallet that was watched, dropped for weeks, then watched again would otherwise
  // lump that whole span into ONE window — a month of P&L masquerading as a single
  // "green day", inflating consistency and hiding the real path. Gap windows still
  // count toward the real total (netRealized) and the equity curve, but never toward
  // the consistency read or the score. The whole point is a record you can trust.
  const deltas = [], graded = [];
  for (let i = 1; i < points; i++) {
    const d = Math.round((snaps[i].realized || 0) - (snaps[i - 1].realized || 0));
    deltas.push(d);
    if ((snaps[i].t - snaps[i - 1].t) / DAY_MS <= MAX_WINDOW_DAYS) graded.push(d);
  }
  const windows = deltas.length;
  const gradedWindows = graded.length;
  const gapWindows = windows - gradedWindows;
  let run = 0; const curve = [0];
  for (const d of deltas) { run += d; curve.push(run); }

  // Consistency reads ONLY the daily-cadence (graded) windows.
  const winWindows = graded.filter((d) => d > 0).length;
  const winWindowRate = gradedWindows ? round((winWindows / gradedWindows) * 100, 1) : null;
  const bestWindow = gradedWindows ? Math.max(...graded) : 0;
  const worstWindow = gradedWindows ? Math.min(...graded) : 0;

  // Max peak-to-trough drawdown on the FULL cumulative realized curve (real money).
  let peak = curve[0], maxDrawdown = 0; const peakPos = Math.max(0, ...curve);
  for (const v of curve) { if (v > peak) peak = v; maxDrawdown = Math.max(maxDrawdown, peak - v); }
  maxDrawdown = Math.round(maxDrawdown);

  // Score inputs are graded-window-only so gaps can't move them.
  const netGraded = graded.reduce((s, d) => s + d, 0);
  const gradedFlow = graded.reduce((s, d) => s + Math.abs(d), 0);
  // "Retention": share of gross realized flow that stuck as NET profit (a
  // profit-factor cousin honest to per-window data). Negative → clamped to 0.
  const retention = gradedFlow > 0 ? clamp01(netGraded / gradedFlow) : 0;
  const consistency = gradedWindows ? winWindows / gradedWindows : 0; // 0..1 net-green share
  // Drawdown control: how shallow the worst dip is vs the gains achieved. No gains → 0.
  const drawdownControl = peakPos > 0 ? clamp01(1 - maxDrawdown / peakPos) : 0;

  // Transparent composite, then shrink toward 0 by track length so an unproven
  // wallet can't score high off one lucky window (K=6 windows ≈ a week of daily snaps).
  const raw = 0.5 * consistency + 0.3 * retention + 0.2 * drawdownControl;
  const conf = gradedWindows / (gradedWindows + 6);
  const scored = gradedWindows >= 4;
  const operatorScore = scored ? Math.round(raw * conf * 100) : null;

  // Tier only when scored AND net-positive (negative records stay unranked but visible).
  let tier = null;
  if (scored && netRealized > 0) {
    if (operatorScore >= 65 && gradedWindows >= 14) tier = { tier: "CONSISTENT", title: "Consistent", glyph: "✦" };
    else if (operatorScore >= 40 && gradedWindows >= 7) tier = { tier: "POSITIVE", title: "Positive", glyph: "◆" };
    else tier = { tier: "TRACKED", title: "Tracked", glyph: "▪" };
  }
  const trend = netRealized > 0 ? "UP" : netRealized < 0 ? "DOWN" : "FLAT";

  return {
    points, building: false, scored, daysTracked, netRealized,
    windows, gradedWindows, gapWindows, winWindows,
    winWindowRate, maxDrawdown, bestWindow, worstWindow, curve, trend,
    operatorScore, tier, latest: last,
    currentOpen: last.open || 0,
  };
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// ── Signal-webhook ingestion (TradingView / bring-your-own-signal) ───────────
// External signals can't wallet-sign, so the per-user secret token in the URL is
// the auth (it only authorizes order placement on the order-only key, and is
// rotatable). This pure layer just normalizes + validates the alert payload; the
// route writes the result to KV for the exec cron to pick up through the normal
// pipeline (inheriting every guardrail). Tested.

// Normalize a symbol from many shapes (BTC, BTCUSDT, BTC/USDC, PERP_BTC_USDC) to
// the Orderly perp id PERP_<BASE>_USDC. Returns null if unrecognizable.
export function normalizeSymbol(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (/^PERP_[A-Z0-9]+_USDC$/.test(s)) return s;          // already canonical
  s = s.replace(/[\/\-_]/g, "").replace(/^PERP/, "");      // strip separators + PERP prefix
  s = s.replace(/(USDC|USDT|USD)$/g, "");                  // strip quote suffix
  if (!/^[A-Z0-9]{1,15}$/.test(s)) return null;
  return `PERP_${s}_USDC`;
}

// Parse + validate an inbound webhook alert into a normalized intent.
// action mapping (perp semantics): BUY/LONG → open long · SELL/SHORT → open short ·
// CLOSE/EXIT/FLAT → close the open position. Returns { ok, action, direction,
// symbol, sizeOverride } or { ok:false, error }.
export function parseWebhookAlert(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "empty body" };
  const raw = String(body.action ?? body.side ?? "").trim().toUpperCase();
  let action, direction = null;
  // TEST = builder wiring check — the hook route answers with diagnostics and
  // never queues an intent, so builders can verify token/passphrase safely.
  if (raw === "TEST" || raw === "PING") return { ok: true, action: "TEST", direction: null, symbol: null, sizeOverride: null };
  if (["CLOSE", "EXIT", "FLAT"].includes(raw)) action = "CLOSE";
  else if (["BUY", "LONG"].includes(raw)) { action = "OPEN"; direction = "LONG"; }
  else if (["SELL", "SHORT"].includes(raw)) { action = "OPEN"; direction = "SHORT"; }
  else return { ok: false, error: `unknown action "${raw}" (use BUY/SELL/CLOSE)` };

  // CLOSE doesn't strictly need a symbol (close whatever's open), but accept one.
  const symbol = normalizeSymbol(body.symbol ?? body.ticker);
  if (action === "OPEN" && !symbol) return { ok: false, error: "missing/invalid symbol" };

  const sizeOverride = Number(body.size) > 0 ? Number(body.size) : null;
  return { ok: true, action, direction, symbol, sizeOverride };
}

// ── Funding / OI percentile-vs-history ───────────────────────────────────────
// Context beats a raw number: "funding 0.02%" means little; "funding in the 95th
// percentile of the last 90 days" means the crowd is extremely long. Computed off
// the oi:hist:{symbol} series the brain records ({t,price,oi,funding}). Pure+tested.

// % of samples <= x (0..100). null on empty.
export function percentileRank(values, x) {
  if (!Array.isArray(values) || !values.length) return null;
  const below = values.reduce((n, v) => n + (v <= x ? 1 : 0), 0);
  return Math.round((below / values.length) * 100);
}

// Current funding/OI + their percentile vs the recorded history. Needs a minimum
// sample so early (thin) history doesn't lie — returns { building:true } until then.
export function oiStats(series, minSamples = 12) {
  if (!Array.isArray(series) || series.length < 2) return { building: true, samples: series?.length || 0 };
  const last = series[series.length - 1];
  const fundings = series.map((p) => p.funding).filter(Number.isFinite);
  const ois = series.map((p) => p.oi).filter(Number.isFinite);
  const stat = (arr, val) => {
    const s = [...arr].sort((a, b) => a - b);
    return { value: val, pct: percentileRank(arr, val), min: s[0], max: s[s.length - 1] };
  };
  return {
    building: series.length < minSamples,
    samples: series.length,
    funding: stat(fundings, last.funding),
    oi: stat(ois, last.oi),
  };
}

// ── SETUP MOMENTUM (persistence / decay) — is the funding-fade BUILDING or FADING? ──
// THE READ's other axes are all LEVELS (funding now, smart money now, callers now). This is
// the ONLY time-derivative: reading the brain's oi:hist:{symbol} series ({t,price,oi,funding})
// it asks whether the crowded setup is still ACCUMULATING (funding stretch + OI both rising →
// crowd piling in, you're EARLY) or UNWINDING (both falling → the squeeze already fired, you're
// LATE). A fresh, building confluence is a different trade than a stale one — and nothing else
// in the engine sees the trajectory. Direction-agnostic (the fade side is opposite the crowd);
// it grades the setup's AGE, not its side. Pure + tested; fed entirely by data we already log.
export function deriveSetupMomentum(series, { windowHours = 8, minSamples = 6 } = {}) {
  const rows = (Array.isArray(series) ? series : [])
    .filter((p) => p && Number.isFinite(p.funding) && Number.isFinite(p.oi))
    .sort((a, b) => (a.t || 0) - (b.t || 0));
  if (rows.length < minSamples) return { available: false, samples: rows.length };
  const now = rows[rows.length - 1].t || 0;
  // Window = the last `windowHours` hours if timestamps allow, else the last N samples.
  let win = now ? rows.filter((p) => (now - (p.t || 0)) <= windowHours * 3600 * 1000) : rows.slice(-(windowHours + 1));
  if (win.length < 4) win = rows.slice(-Math.max(4, Math.min(rows.length, windowHours + 1)));
  const head = win.slice(0, Math.min(3, win.length - 1)); // oldest in window (denoised)
  const tail = win.slice(-3);                             // newest (denoised)
  const avg = (arr, k) => arr.reduce((s, p) => s + p[k], 0) / arr.length;
  const fThen = avg(head, "funding"), fNow = avg(tail, "funding");
  const oiThen = avg(head, "oi"), oiNow = avg(tail, "oi");
  const absThen = Math.abs(fThen), absNow = Math.abs(fNow);
  const flipped = fThen !== 0 && fNow !== 0 && Math.sign(fThen) !== Math.sign(fNow) && absNow > 0.00002;
  const fundingChangePct = absThen > 1e-9 ? (absNow - absThen) / absThen : 0;
  const oiChangePct = oiThen > 0 ? (oiNow - oiThen) / oiThen : 0;
  const crowded = absNow >= 0.00003; // a real funding lean exists (else no setup to build/decay)
  const spanH = win.length && win[0].t ? Math.max(1, Math.round((now - win[0].t) / 3600000)) : windowHours;

  const fRising = fundingChangePct > 0.12, fFalling = fundingChangePct < -0.12;
  const oiRising = oiChangePct > 0.02, oiFalling = oiChangePct < -0.02;
  let state, headline;
  if (!crowded) { state = "FLAT"; headline = "no crowded funding lean — no fade setup to build or decay here."; }
  else if (flipped) { state = "RESET"; headline = "funding just flipped side — the prior crowd already unwound; this is a fresh setup, not a mature one."; }
  else if (fRising && oiRising) { state = "BUILDING"; headline = "funding stretch and open interest are BOTH rising — the crowd is still piling in. The fade is building; you're early."; }
  else if (fFalling && oiFalling) { state = "UNWINDING"; headline = "funding and open interest are BOTH falling — the crowded side is being closed. The squeeze may have already fired; you're late."; }
  else if (fRising && oiFalling) { state = "PEAKING"; headline = "funding is stretching but leverage is leaving — extended without new positioning. Near exhaustion."; }
  else { state = "STABLE"; headline = "the setup is holding steady — no clear build or decay this window."; }

  return {
    available: true, samples: rows.length, windowHours: spanH, state, crowded, flipped,
    fundingChangePct: Math.round(fundingChangePct * 100),
    oiChangePct: Math.round(oiChangePct * 100),
    headline,
  };
}

// ── BTC BETA (idiosyncratic vs market-driven) ────────────────────────────────
// A meta-read, not a directional vote: is this alt's move its OWN, or just BTC beta?
// A lone SHORT on a high-beta alt while BTC rips is really a bet against BTC — so a
// single-name read means less the more the coin is BTC-driven. We regress the coin's
// hourly returns on BTC's (from the recorded oi:hist price series) → beta + r² (the
// share of the move BTC explains). It MODULATES trust in the other axes; it never
// votes a side. Pure + tested; fed by data we already log. (For BTC itself: skip.)
export function computeBeta(coinSeries, btcSeries, { minSamples = 12 } = {}) {
  const hour = (t) => Math.round(Number(t) / 3600000);
  const cm = new Map(), bm = new Map();
  for (const p of coinSeries || []) if (p && Number.isFinite(p.price)) cm.set(hour(p.t), p.price);
  for (const p of btcSeries || []) if (p && Number.isFinite(p.price)) bm.set(hour(p.t), p.price);
  const hours = [...cm.keys()].filter((h) => bm.has(h)).sort((a, b) => a - b);
  if (hours.length < minSamples + 1) return { available: false, samples: hours.length };
  const cr = [], br = [];
  for (let i = 1; i < hours.length; i++) {
    const c0 = cm.get(hours[i - 1]), c1 = cm.get(hours[i]);
    const b0 = bm.get(hours[i - 1]), b1 = bm.get(hours[i]);
    if (c0 > 0 && b0 > 0) { cr.push((c1 - c0) / c0); br.push((b1 - b0) / b0); }
  }
  if (cr.length < minSamples) return { available: false, samples: cr.length };
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const mc = mean(cr), mb = mean(br);
  let cov = 0, vb = 0, vc = 0;
  for (let i = 0; i < cr.length; i++) { cov += (cr[i] - mc) * (br[i] - mb); vb += (br[i] - mb) ** 2; vc += (cr[i] - mc) ** 2; }
  cov /= cr.length; vb /= cr.length; vc /= cr.length;
  const beta = vb > 0 ? cov / vb : 0;
  const corr = vb > 0 && vc > 0 ? cov / Math.sqrt(vb * vc) : 0;
  const r2 = corr * corr;
  const verdict = r2 >= 0.5 ? "BTC_DRIVEN" : r2 <= 0.2 ? "IDIOSYNCRATIC" : "MIXED";
  return {
    available: true, samples: cr.length,
    beta: Math.round(beta * 100) / 100,
    correlation: Math.round(corr * 100) / 100,
    drivenPct: Math.round(r2 * 100),
    verdict,
  };
}

// ── Agent leaderboard eligibility + score ────────────────────────────────────
// Shared by /agents/leaderboard (the public ranking) and /agents/standing/:addr
// (a single agent's "why am I / am I not ranked" readout) so the two can never
// drift. The gate is anti-gaming: a meaningful sample, spread over time, and
// actually net-positive (we won't surface a losing agent as "top").
export const AGENT_BOARD = { minTrades: 10, minDays: 3, fullConfTrades: 30 };

// Aggregate a wallet's closed trades into raw counters. rows = [{ pnl, closed_at }].
export function aggregateAgentTrades(rows) {
  let trades = 0, wins = 0, net = 0, grossWin = 0, grossLoss = 0, first = Infinity, last = 0;
  for (const r of rows || []) {
    const pnl = parseFloat(r.pnl) || 0;
    const closed = new Date(r.closed_at).getTime() || 0;
    trades++; net += pnl;
    if (pnl > 0) { wins++; grossWin += pnl; } else { grossLoss += Math.abs(pnl); }
    if (closed) { first = Math.min(first, closed); last = Math.max(last, closed); }
  }
  const daysActive = first === Infinity ? 0 : Math.max(1, Math.round((last - first) / 86400000));
  return { trades, wins, net, grossWin, grossLoss, daysActive, firstTradeAt: first === Infinity ? 0 : first };
}

// ── CREATOR FEE-SHARE (#2) — what a caller earned from being copied ───────────
// The per-thesis rebate: when a copier trades a call attributed to a leader
// (source_leader), a slice of the BROKER FEE that trade generated accrues to the
// leader. Computed from the SAME on-chain-auditable agent_trades rows the copy-record
// uses — notional = entry_price × qty, round-trip taker fee, × the creator share.
// Pure + recomputable from public order data (fee = notional × bps), same trustless
// standard as grading. A fee-share, NOT a P&L-share (a losing copy still paid a fee) —
// which is the honest, legally-clean design (creator commission, not revenue share).
export const CREATOR_FEE = { feeBps: 2.5, roundTrip: 2, share: 0.20, minPayoutUsd: 5 };

export function creatorEarnings(rows, cfg = CREATOR_FEE) {
  let feesUsd = 0, volumeUsd = 0; const copiers = new Set(); const lines = [];
  for (const r of rows || []) {
    const entry = Math.abs(parseFloat(r.entry_price) || 0);
    const qty = Math.abs(parseFloat(r.qty) || 0);
    const notional = entry * qty;
    if (!(notional > 0)) continue;
    const fee = notional * (cfg.feeBps / 10000) * cfg.roundTrip; // entry + exit taker
    const earned = fee * cfg.share;
    feesUsd += fee; volumeUsd += notional;
    if (r.wallet_address) copiers.add(String(r.wallet_address).toLowerCase());
    lines.push({
      symbol: String(r.symbol || "").replace("PERP_", "").replace("_USDC", ""),
      notional: round(notional, 2), fee: round(fee, 4), earned: round(earned, 4),
    });
  }
  return {
    trades: lines.length, copiers: copiers.size,
    volumeUsd: round(volumeUsd, 2), feesUsd: round(feesUsd, 2),
    earnedUsd: round(feesUsd * cfg.share, 2), sharePct: Math.round(cfg.share * 100),
    lines: lines.slice(-50),
  };
}

// Risk-adjusted 0–100 score: win rate + capped profit factor, shrunk by sample
// size so a lucky 3-trade run can't outrank a proven record.
export function agentScore(a, cfg = AGENT_BOARD) {
  const winRate = a.trades ? a.wins / a.trades : 0;
  const profitFactor = a.grossLoss > 0 ? a.grossWin / a.grossLoss : (a.grossWin > 0 ? 99 : 0);
  const pfScore = Math.min(profitFactor, 5) / 5;
  const sampleConf = Math.min(1, a.trades / cfg.fullConfTrades);
  const score = Math.round((0.5 * winRate + 0.5 * pfScore) * sampleConf * 1000) / 10;
  return { winRate, profitFactor, score };
}

// Per-agent eligibility breakdown for the UI readout: each criterion with its
// met/unmet flag + current value, plus the derived stats. `eligible` is the AND
// of all criteria — identical to the leaderboard's inclusion test.
export function agentStanding(a, cfg = AGENT_BOARD) {
  const { winRate, profitFactor, score } = agentScore(a, cfg);
  const criteria = [
    { key: "trades", label: `${cfg.minTrades}+ closed trades`, met: a.trades >= cfg.minTrades, value: a.trades, target: cfg.minTrades },
    { key: "days", label: `active ${cfg.minDays}+ days`, met: a.daysActive >= cfg.minDays, value: a.daysActive, target: cfg.minDays },
    { key: "profitable", label: "net-positive P&L", met: a.net > 0, value: Math.round(a.net * 100) / 100, target: 0 },
  ];
  const eligible = criteria.every((c) => c.met);
  return {
    eligible,
    metCount: criteria.filter((c) => c.met).length,
    total: criteria.length,
    criteria,
    stats: {
      trades: a.trades, daysActive: a.daysActive,
      winRate: Math.round(winRate * 1000) / 10,
      netPnl: Math.round(a.net * 100) / 100,
      profitFactor: Math.round(Math.min(profitFactor, 99) * 100) / 100,
      score,
      // Full-lifetime averages so the LIVE track-record card reads the TRUE record
      // (the /agent GET only ships the last 50 rows — computing avgWin/avgLoss from
      // that truncated set undercounts once an agent passes 50 trades).
      avgWin: a.wins ? Math.round((a.grossWin / a.wins) * 100) / 100 : 0,
      avgLoss: (a.trades - a.wins) ? Math.round((a.grossLoss / (a.trades - a.wins)) * 100) / 100 : 0,
      firstTradeAt: a.firstTradeAt || 0,
    },
  };
}

// ── Funding + OI-divergence + confluence classification ──────────────────────
// Mirrors the agent brain's deriveSignal rules (funding extreme FADES the crowd;
// OI-divergence; confluence = both agree) so the public /signals API and the
// autonomous agent can't drift in spirit. Pure + tested. raw = { fundingRate,
// priceChange, oiChange, hasPrev } as DECIMALS (e.g. 0.0001 = 0.01%).
export function confluenceSignal(raw, opts = {}) {
  const fundingThreshold = (opts.fundingThreshold ?? 0.01) / 100;
  const oiChangeThreshold = (opts.oiChangeThreshold ?? 0) / 100;
  const f = raw.fundingRate || 0, p = raw.priceChange || 0, oi = raw.oiChange || 0;
  const fundingSignal = f >= fundingThreshold ? "SHORT" : f <= -fundingThreshold ? "LONG" : "NONE";
  let oiSignal = "NONE";
  if (raw.hasPrev && Math.abs(oi) >= oiChangeThreshold && oi !== 0) {
    if (p > 0 && oi < 0) oiSignal = "SHORT";       // price up, OI down → fade
    else if (p < 0 && oi > 0) oiSignal = "LONG";   // price down, OI up → fade
    else if (p > 0 && oi > 0) oiSignal = "LONG";   // strong up → follow
    else if (p < 0 && oi < 0) oiSignal = "SHORT";  // strong down → follow
  }
  const confluence = fundingSignal !== "NONE" && fundingSignal === oiSignal ? fundingSignal : "NONE";
  return { fundingSignal, oiSignal, confluence };
}

// ── Request-bound (v2) signing ───────────────────────────────────────────────
// The legacy auth signs a STATIC message ("nexus-trading-key-v1"), so its
// signature is deterministic — a single captured walletSig is a permanent bearer
// token good for trade/withdraw/agent-control until the key rotates. v2 binds each
// high-risk action to a single request: the client signs a server-issued challenge
// carrying a single-use nonce + the exact action + amount + domain + a short expiry.
// A leaked signature then can't be replayed for a different action/amount, can't be
// reused after it expires, and can't be reused at all (the nonce is burned on first
// verify by the caller). Pure here — ecrecover is injected as `recover` so this
// stays crypto/network-free and unit-testable; index.js passes recoverEthAddress.
export const AUTH_V2_DOMAIN = "og.nexustradinglabs.com";
export const AUTH_V2_ACTIONS = new Set([
  "trade", "withdraw",
  "agent.activate", "agent.mode", "agent.config", "agent.deactivate", "agent.kill",
]);

// Canonical challenge string — the ONE format both client and server build, so the
// recovered signature is meaningful only for these exact fields. amount is "-" when
// not applicable (reads/control with no value at risk). wallet lower-cased so the
// hash never depends on checksum casing.
export function buildChallenge({ action, wallet, nonce, amount, expires, domain = AUTH_V2_DOMAIN }) {
  const amt = (amount === undefined || amount === null || amount === "") ? "-" : String(amount);
  return [
    "nexus:v2",
    `action:${action}`,
    `wallet:${String(wallet).toLowerCase()}`,
    `nonce:${nonce}`,
    `amount:${amt}`,
    `domain:${domain}`,
    `expires:${expires}`,
  ].join("\n");
}

// Verify a v2 signature against the TRUSTED challenge record the server minted +
// stored (never client-supplied fields), binding it to what the request actually
// does. Steps: action allowed → not expired → the request's action/amount/wallet
// match the signed record → ecrecover(challenge) === record.wallet. Returns
// { ok:true, wallet } or { ok:false, reason }. The caller is responsible for the
// nonce lifecycle (exists/unconsumed in KV, then burn on success) — replay defense
// lives at the KV layer; this function is the pure binding+expiry+signer check.
export function verifyV2({ record, sig, expected, now, recover, domain = AUTH_V2_DOMAIN }) {
  if (!record || typeof record !== "object") return { ok: false, reason: "no challenge record" };
  const { action, wallet, nonce, amount, expires } = record;
  if (!AUTH_V2_ACTIONS.has(action)) return { ok: false, reason: "action not allowed" };
  if (typeof sig !== "string" || !sig) return { ok: false, reason: "missing signature" };
  if (!Number.isFinite(now) || !Number.isFinite(expires)) return { ok: false, reason: "bad timestamps" };
  if (now > expires) return { ok: false, reason: "challenge expired" };

  const walletL = String(wallet).toLowerCase();
  const norm = (v) => (v === undefined || v === null || v === "" ? "-" : String(v));
  if (expected) {
    if (expected.action !== action) return { ok: false, reason: "action mismatch" };
    if (norm(expected.amount) !== norm(amount)) return { ok: false, reason: "amount mismatch" };
    if (expected.wallet !== undefined && String(expected.wallet).toLowerCase() !== walletL)
      return { ok: false, reason: "wallet mismatch" };
  }

  const challenge = buildChallenge({ action, wallet: walletL, nonce, amount, expires, domain });
  let recovered;
  try { recovered = recover(challenge, sig); } catch { return { ok: false, reason: "recover threw" }; }
  if (!recovered || String(recovered).toLowerCase() !== walletL)
    return { ok: false, reason: "signature does not match wallet" };

  return { ok: true, wallet: walletL };
}

// ── Orderly account_id derivation ────────────────────────────────────────────
// Orderly derives a DETERMINISTIC account id from (wallet, brokerId):
//   accountId = keccak256(abi.encode(address, keccak256(bytes(brokerId))))
// abi.encode of (address,bytes32) == 12 zero bytes + 20-byte address + 32-byte hash.
//
// This is the whole unlock for a public wallet x-ray on Orderly: the dashboard
// indexer is keyed by account_id (not address), so without this we could only
// x-ray wallets that happen to appear in the top-200 PnL ranking. With it, any
// address can be resolved for any broker — no auth, no ranking dependency.
// Verified against live indexer rows (see logic.test.mjs vectors).
export function orderlyAccountId(address, brokerId) {
  const clean = String(address || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error("invalid address");
  if (!brokerId) throw new Error("brokerId required");
  const buf = new Uint8Array(64);
  buf.set(hexToBytes(clean), 12);                       // left-pad address to 32B
  buf.set(keccak_256(utf8ToBytes(String(brokerId))), 32); // brokerHash
  return "0x" + bytesToHex(keccak_256(buf));
}

// ── Catalyst search mapping ("why is X moving") ──────────────────────────────
// A perp ticker is a poor news query: "CL" pulls nothing about crude oil, "BZ"
// nothing about Brent, and a bare "SOL" mixes Solana with unrelated noise. This
// maps a bare ticker → a human search query + a display name + an asset class, so
// the /intel/catalysts route can pull RELEVANT headlines for commodities, equities,
// and majors, and bias the query with "crypto" only when the asset actually is.
// Not exhaustive across 100+ markets by design — the ambiguous TradFi/commodity/
// meme tickers are named explicitly; everything else falls back to crypto (the vast
// majority of the book). Pure + tested.
const ASSET_MAP = {
  // majors (crypto)
  BTC: ["Bitcoin", "crypto"], ETH: ["Ethereum", "crypto"], SOL: ["Solana", "crypto"],
  BNB: ["BNB Binance", "crypto"], XRP: ["XRP Ripple", "crypto"], DOGE: ["Dogecoin", "crypto"],
  ADA: ["Cardano", "crypto"], AVAX: ["Avalanche", "crypto"], LINK: ["Chainlink", "crypto"],
  ARB: ["Arbitrum", "crypto"], OP: ["Optimism crypto", "crypto"], SUI: ["Sui crypto", "crypto"],
  TON: ["Toncoin", "crypto"], TRX: ["Tron crypto", "crypto"], LTC: ["Litecoin", "crypto"],
  // memes (crypto) — bare tickers are hopeless queries
  WIF: ["dogwifhat", "crypto"], PEPE: ["Pepe coin", "crypto"], BONK: ["Bonk crypto", "crypto"],
  TRUMP: ["Official Trump coin", "crypto"], FARTCOIN: ["Fartcoin", "crypto"],
  // commodities (TradFi)
  CL: ["WTI crude oil", "commodity"], BZ: ["Brent crude oil", "commodity"],
  NG: ["natural gas price", "commodity"], GC: ["gold price", "commodity"],
  SI: ["silver price", "commodity"], HG: ["copper price", "commodity"],
  // equities / equity-linked
  MSTR: ["MicroStrategy Strategy stock", "equity"], COIN: ["Coinbase stock", "equity"],
  HOOD: ["Robinhood stock", "equity"], NVDA: ["Nvidia stock", "equity"],
  TSLA: ["Tesla stock", "equity"], AAPL: ["Apple stock", "equity"],
  SPX: ["S&P 500", "equity"], NDX: ["Nasdaq 100", "equity"], WLFI: ["World Liberty Financial", "crypto"],
};

export function symbolToQuery(ticker) {
  const t = String(ticker || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "").replace(/[^A-Z0-9]/g, "");
  if (!t) return null;
  const hit = ASSET_MAP[t];
  if (hit) return { ticker: t, name: hit[0], query: hit[0], assetClass: hit[1] };
  // Fallback: unknown ticker → assume crypto (the book is overwhelmingly crypto).
  // The "crypto" qualifier keeps a short/ambiguous ticker from pulling equity noise.
  return { ticker: t, name: t, query: `${t} crypto`, assetClass: "crypto" };
}

// ── Chart image URL gate (SSRF guard) ────────────────────────────────────────
// The OG card embeds a thesis's chartUrl, which means the WORKER fetches a URL that
// came from user data. That is a server-side request forgery vector — the frontend's
// allowlist protects browsers, not us. Everything below runs BEFORE any fetch.
//
// Mirrors app/pages/lab/helpers.ts#chartImageSrc. Host match is exact-or-dot-suffix so
// "s3.tradingview.com.evil.com" cannot pass, which a naive includes() would allow.
export const CHART_HOSTS = [
  "s3.tradingview.com",
  "www.tradingview.com",
  "tradingview.com",
  "i.imgur.com",
  "imgur.com",
  "pbs.twimg.com",
];

/** Returns a safe https chart URL, or null. Never throws. */
export function safeChartUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const ok = CHART_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return ok ? u.toString() : null;
}

// ── Nexus Arena — the open proving ground for external AI agents ─────────────
// Any AI agent registers with a wallet, drives trades through the webhook rail
// (PAPER first — zero capital, simulated fills at public mark price), and builds
// a track record graded by OUR engine, never self-reported. Pure + tested.
export const ARENA = { nameMin: 3, nameMax: 40, descMax: 240, builderMax: 60, rosterCap: 500 };

export function validateArenaRegistration(body = {}) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < ARENA.nameMin || name.length > ARENA.nameMax) {
    return { ok: false, error: `name required (${ARENA.nameMin}-${ARENA.nameMax} chars)` };
  }
  if (!/^[\w .\-\[\]()]+$/.test(name)) {
    return { ok: false, error: "name: letters, numbers, spaces, . - _ [ ] ( ) only" };
  }
  const description = typeof body.description === "string" ? body.description.trim().slice(0, ARENA.descMax) : "";
  const builder = typeof body.builder === "string" ? body.builder.trim().slice(0, ARENA.builderMax) : "";
  return { ok: true, name, description, builder };
}

// Paper-tier agent config: EXTERNAL brain (house signals silent), risk fields
// clamped to sane paper ranges so a hostile registration can't set absurd values.
const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
export function arenaAgentConfig(overrides = {}) {
  return {
    mode: "PAPER",
    signalMode: "EXTERNAL",
    arena: true,
    symbols: [],
    leverage: clamp(overrides.leverage, 1, 10, 2),
    capitalPerTrade: clamp(overrides.capitalPerTrade, 10, 10000, 100),
    tpPercent: clamp(overrides.tpPercent, 0.2, 50, 2),
    slPercent: clamp(overrides.slPercent, 0.2, 25, 1.5),
    maxHoldHours: clamp(overrides.maxHoldHours, 1, 336, 24),
    maxTradesPerDay: clamp(overrides.maxTradesPerDay, 1, 50, 10),
    maxDailyLossUsdc: clamp(overrides.maxDailyLossUsdc, 10, 10000, 200),
  };
}

// ── Autocopy copiers reverse-index diff ──────────────────────────────────────
// Autocopy follows live in each follower's config.autocopy.leaders. To show a
// public "N copiers" per leader we keep a reverse index (copy:copiers:{leader})
// updated at config-write time. Given a follower's OLD vs NEW leader list, this
// returns which leaders they started/stopped following — normalized lowercase,
// deduped, with self excluded (you can't copy yourself). Pure + tested.
export function diffCopyLeaders(oldLeaders, newLeaders, self) {
  const me = String(self || "").toLowerCase();
  const norm = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => String(x).toLowerCase()).filter((x) => x && x !== me))];
  const o = new Set(norm(oldLeaders));
  const n = new Set(norm(newLeaders));
  return {
    added: [...n].filter((x) => !o.has(x)),
    removed: [...o].filter((x) => !n.has(x)),
  };
}

// ── Forecast Divergence (the prediction-market lens) ─────────────────────────
// Quotient-informed, same spirit as the mispriced board: don't only read the
// FUNDING crowd — read the FORECASTING crowd. Polymarket prices a probability on
// asset-linked questions ("Will BTC reach $X by DATE"). We surface that forecast
// beside the tape and, on price-target markets, flag when the forecasting crowd's
// DIRECTION disagrees with current funding/positioning — the on-brand analog to
// Quotient's fair-price "edge", using OUR funding data as the counter-model.
//
// Deliberate honesty: we do NOT invent a fair probability (Q's 6,000-source model
// is their moat, not ours). We surface the crowd forecast + a funding-alignment
// read + a target window, and the product's job is to turn a divergence into a
// GRADED thesis — the thing Quotient's "do not recommend a trade" stops short of.
export const FORECAST = {
  minVolumeUsd: 5_000,   // a thin prediction market isn't a crowd — ignore dust
  minConvictionPct: 15,  // |prob − 50| gate: a coin-flip forecast isn't a divergence
  nearBandPct: 20,       // only a strike within ±this% of mark carries a DIRECTIONAL read;
                         // a far tail strike ("dip to $5k") is priced as tail risk, not a lean
  maxMarkets: 30,
};

// Asset name/ticker → bare coin. Matched case-insensitively against the question
// with word boundaries (so "eth" won't hit "together"). Extend as deeper
// prediction markets appear for more of our listings; this base set covers the
// liquid ones. Order matters only for display, not correctness (first match wins).
export const FORECAST_ASSETS = [
  { coin: "BTC", rx: /\b(bitcoin|btc)\b/i },
  { coin: "ETH", rx: /\b(ethereum|ether|eth)\b/i },
  { coin: "SOL", rx: /\b(solana|sol)\b/i },
  { coin: "XRP", rx: /\b(xrp|ripple)\b/i },
  { coin: "DOGE", rx: /\b(dogecoin|doge)\b/i },
  { coin: "BNB", rx: /\b(bnb|binance\s*coin)\b/i },
  { coin: "ADA", rx: /\b(cardano|ada)\b/i },
  { coin: "AVAX", rx: /\b(avalanche|avax)\b/i },
  { coin: "LINK", rx: /\b(chainlink|link)\b/i },
  { coin: "SUI", rx: /\bsui\b/i },
];

// Polymarket gamma returns `outcomes` / `outcomePrices` as JSON-encoded STRINGS
// (occasionally already arrays). Parse defensively either way.
function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
}

// Extract a directional price target from a question. Requires an explicit `$`
// anchor so we never mistake a year ("by 2026") for a strike. k/K → ×1e3,
// m/M → ×1e6. direction: UP = the YES bet is that price reaches a HIGHER strike;
// DOWN = YES bet is price falls below it. null when it isn't a price-target market.
export function parsePriceTarget(question) {
  const q = String(question || "");
  const m = q.match(/\$\s*([0-9][0-9,]*\.?[0-9]*)\s*([kKmM])?/);
  if (!m) return null;
  let val = parseFloat(m[1].replace(/,/g, ""));
  const suffix = (m[2] || "").toLowerCase();
  if (suffix === "k") val *= 1e3;
  else if (suffix === "m") val *= 1e6;
  if (!Number.isFinite(val) || val <= 0) return null;
  const up = /\b(reach|reaches|hit|hits|above|exceed|exceeds|surpass|surpasses|over|cross|crosses|top|tops|higher|≥|>=)\b/i.test(q);
  const down = /\b(below|under|dip|dips|drop|drops|fall|falls|lower|beneath|≤|<=)\b/i.test(q);
  const direction = (up && !down) ? "UP" : (down && !up) ? "DOWN" : (up ? "UP" : null);
  if (!direction) return null;
  return { target: val, direction };
}

// polyMarkets: raw gamma /markets rows. futuresRows: Orderly /v1/public/futures
// rows (same shape mispricedBoard reads). opts.coin filters to one asset.
export function forecastDivergence(polyMarkets, futuresRows, cfg = FORECAST, opts = {}) {
  const wantCoin = opts.coin ? String(opts.coin).toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "") : null;
  // Build coin → tape snapshot (mark + funding) from Orderly's public futures.
  const tape = {};
  for (const r of futuresRows || []) {
    const sym = r && r.symbol;
    if (!sym || !String(sym).startsWith("PERP_")) continue;
    const coin = String(sym).toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
    const mark = Number(r.mark_price);
    if (!Number.isFinite(mark) || mark <= 0) continue;
    const funding = Number(r.last_funding_rate);
    tape[coin] = { symbol: sym, mark, funding: Number.isFinite(funding) ? funding : null };
  }
  const out = [];
  for (const pm of polyMarkets || []) {
    if (pm && (pm.closed === true || pm.active === false)) continue;
    const q = pm && pm.question;
    if (!q) continue;
    const asset = FORECAST_ASSETS.find((a) => a.rx.test(q));
    if (!asset) continue;
    if (wantCoin && asset.coin !== wantCoin) continue;
    const volume = Number(pm.volumeNum ?? pm.volume ?? 0) || 0;
    if (volume < cfg.minVolumeUsd) continue;

    // YES probability from the outcome book.
    const outcomes = parseJsonArray(pm.outcomes).map((x) => String(x).toLowerCase());
    const prices = parseJsonArray(pm.outcomePrices).map(Number);
    let yesProb = null;
    const yi = outcomes.indexOf("yes");
    if (yi >= 0 && Number.isFinite(prices[yi])) yesProb = prices[yi];
    else if (prices.length && Number.isFinite(prices[0])) yesProb = prices[0];
    if (yesProb == null || !Number.isFinite(yesProb)) continue;
    yesProb = round(yesProb * 100, 1);

    const t = tape[asset.coin] || null;
    const entry = {
      id: pm.id ?? pm.conditionId ?? null,
      coin: asset.coin,
      symbol: t ? t.symbol : null,
      question: q,
      slug: pm.slug ?? null,
      forecastProbPct: yesProb,               // the crowd's probability of YES
      clobTokenId: (() => { const ids = parseJsonArray(pm.clobTokenIds).map(String); return (yi >= 0 && ids[yi]) ? ids[yi] : (ids[0] || null); })(), // YES-token id → /intel/events/history
      volumeUsd: Math.round(volume),
      liquidityUsd: Math.round(Number(pm.liquidity ?? 0) || 0),
      endDate: pm.endDate ?? null,
      markPrice: t ? t.mark : null,
      funding8hPct: (t && t.funding != null) ? round(t.funding * 100, 5) : null,
      target: null, targetDirection: null, distancePct: null,
      forecastLean: null, nearMoney: null,
      fundingLean: null, alignment: null, divergence: false,
    };

    const pt = parsePriceTarget(q);
    if (pt && t) {
      entry.target = pt.target;
      entry.targetDirection = pt.direction;   // the direction the YES outcome bets on
      entry.distancePct = round(((pt.target - t.mark) / t.mark) * 100, 2);
      // Effective forecast lean FOLDS the probability: a LOW YES on an "up" bet means the
      // crowd is betting price WON'T get there (a down/flat lean), and vice-versa. Without
      // this fold, "2% chance BTC dips to $15k" (a bullish crowd) would read as bearish.
      entry.forecastLean = yesProb >= 50 ? pt.direction : (pt.direction === "UP" ? "DOWN" : "UP");
      // Only a NEAR-money strike carries a directional read vs positioning; a far tail
      // strike ("dip to $5k", 90% away) is priced as tail risk, so we surface the forecast
      // but never flag it as a divergence.
      entry.nearMoney = Math.abs(entry.distancePct) <= cfg.nearBandPct;
      if (t.funding != null && t.funding !== 0) {
        // Funding lean: positive funding ⇒ book net LONG ⇒ leveraged tape leans UP;
        // negative ⇒ leans DOWN. (The mispriced board FADES this; here we only read its
        // direction to compare against the forecast.)
        entry.fundingLean = t.funding > 0 ? "UP" : "DOWN";
        if (entry.nearMoney) {
          entry.alignment = entry.forecastLean === entry.fundingLean ? "ALIGNED" : "DIVERGENT";
          // Flag only a CONVICTION divergence: forecasters lean one way, the tape the
          // other, and the forecast isn't a coin-flip. That gap = worth investigating.
          entry.divergence = entry.alignment === "DIVERGENT" && Math.abs(yesProb - 50) >= cfg.minConvictionPct;
        }
      }
    }
    out.push(entry);
  }
  // Flagged divergences first, then by crowd depth (volume = forecast quality).
  out.sort((a, b) => (Number(b.divergence) - Number(a.divergence)) || (b.volumeUsd - a.volumeUsd));
  return {
    scanned: out.length,
    divergentCount: out.filter((m) => m.divergence).length,
    markets: out.slice(0, cfg.maxMarkets),
  };
}

// ── MACRO EVENTS — the intelligence corner for event traders ──────────────────
// Sibling of forecastDivergence, but for MACRO/geopolitical events (Fed, recession,
// war, elections, crypto policy) rather than asset price-target markets. Classifies a
// liquid Polymarket market into a macro category and, ONLY where the relationship is
// textbook, attaches a directional RISK LENS (rate cut → risk-on, war → risk-off). We
// never invent a fair probability or a crypto target — the lens is a starting point for
// a GRADED thesis the trader stakes and executes on Nexus, not advice. This is the
// execution-layer seam an intelligence partner (macro/event discovery) plugs into.
export const MACRO = { minVolumeUsd: 25000, limit: 40 };
// The macro categories that map to a CRYPTO trade you can take on Nexus (risk-on/off via
// BTC/ETH). GEOPOLITICS + ELECTION are excluded — non-tradeable prediction markets.
export const MACRO_TRADEABLE = new Set(["RATES", "ECONOMY", "CRYPTO_POLICY"]);

// ⚠️ REGEX HARDENING: stems that take suffixes use `\w*` (or explicit suffix groups) INSIDE
// the `\b…\b` wrapper — a bare `\b(cut)\b` fails to match "cuts"/"cutting" because the char
// after "cut" is still a word char (the trailing \b can't fire). `\b(cut\w*)\b` consumes the
// whole word and matches all forms. Short ambiguous words (war, ban) use explicit suffix
// groups so they don't match "warm"/"bank". Every form below is covered by a test.
const MACRO_CATEGORIES = [
  { cat: "RATES", rx: /\b(fed|fomc|interest rate\w*|rate (cut|hike|decision|change)\w*|powell|basis points|bps|jerome|monetary policy)\b/i,
    lens: (q) => /\b(cut\w*|lower\w*|dovish|reduc\w*|pause\w*|eas(e|es|ed|ing))\b/i.test(q) ? "RISK_ON"
      : /\b(hik\w*|raise\w*|hawkish|increase\w*|higher)\b/i.test(q) ? "RISK_OFF" : null },
  { cat: "ECONOMY", rx: /\b(recession\w*|inflation|cpi|gdp|unemployment|jobs report|debt ceiling|shutdown\w*|soft landing|hard landing|stagflation)\b/i,
    lens: (q) => /\b(recession\w*|shutdown\w*|default\w*|stagflation|crash\w*|hard landing)\b/i.test(q) ? "RISK_OFF"
      : /\b(soft landing|cool\w*|fall\w*|eas(e|es|ed|ing))\b/i.test(q) ? "RISK_ON" : null },
  { cat: "GEOPOLITICS", rx: /\b(war(s|fare)?|invad\w*|invasion|missile\w*|ceasefire|nuclear|iran|russia|ukraine|israel|gaza|taiwan|north korea|venezuela|conflict\w*|troops|airstrike\w*|military)\b/i,
    lens: (q) => /\b(ceasefire|peace\w*|deal\w*|truce|withdraw\w*)\b/i.test(q) ? "RISK_ON"
      : /\b(war(s|fare)?|invad\w*|invasion|missile\w*|nuclear|airstrike\w*|attack\w*|escalat\w*|strike\w*)\b/i.test(q) ? "RISK_OFF" : null },
  // Requires a POLICY/regulatory context, not a bare "crypto"/"etf" mention — otherwise a
  // normal call whose catalyst says "ETF flows" would be miscounted as a macro/event call.
  { cat: "CRYPTO_POLICY", rx: /\b((bitcoin|crypto) reserve|(sec|etf) (approv\w*|decision|reject\w*|lawsuit|ruling|case)|stablecoin (bill|law|act|regulat\w*)|crypto (regulat\w*|ban|bill|law|policy|executive order)|ban\w* (crypto|bitcoin|stablecoin)|cbdc|regulat\w* (crypto|bitcoin|stablecoin))/i,
    lens: (q) => /\b(reserve|approv\w*|legal|adopt\w*|pass(es|ed|ing)?)\b/i.test(q) ? "RISK_ON"
      : /\b(ban(s|ned|ning)?|reject\w*|crackdown|lawsuit\w*)\b/i.test(q) ? "RISK_OFF" : null },
  { cat: "ELECTION", rx: /\b(election|president|senate|congress|governor|primary|nominee|vote|ballot|prime minister|parliament)\b/i, lens: () => null },
];

export function classifyMacro(question) {
  const c = MACRO_CATEGORIES.find((x) => x.rx.test(String(question || "")));
  return c ? { category: c.cat, riskLens: c.lens(String(question)) || null } : null;
}

export function macroEvents(polyMarkets, cfg = MACRO) {
  const out = [];
  for (const pm of polyMarkets || []) {
    if (pm && (pm.closed === true || pm.active === false)) continue;
    const q = pm && pm.question;
    if (!q) continue;
    const klass = classifyMacro(q);
    if (!klass) continue;
    // Only CRYPTO-MAPPED macro forces — the ones that translate to a trade you can take
    // here (Fed/rates, macro economy, crypto policy → BTC/ETH risk-on/off). Purely
    // GEOPOLITICS + ELECTION prediction markets are pulled: we can't trade them, so they
    // don't belong on a DEX intelligence surface. (Everything in house.)
    if (!MACRO_TRADEABLE.has(klass.category)) continue;
    const volume = Number(pm.volumeNum ?? pm.volume ?? 0) || 0;
    if (volume < cfg.minVolumeUsd) continue;
    const outcomes = parseJsonArray(pm.outcomes).map((x) => String(x).toLowerCase());
    const prices = parseJsonArray(pm.outcomePrices).map(Number);
    let yesProb = null;
    const yi = outcomes.indexOf("yes");
    if (yi >= 0 && Number.isFinite(prices[yi])) yesProb = prices[yi];
    else if (prices.length && Number.isFinite(prices[0])) yesProb = prices[0];
    if (yesProb == null || !Number.isFinite(yesProb)) continue;
    const yesProbPct = round(yesProb * 100, 1);
    // Drop long-shot individual-candidate election markets ("Will <person> win 2028", 0.2%)
    // — huge lifetime volume, zero intelligence. Keep only competitive election markets.
    if (klass.category === "ELECTION" && yesProbPct < 20) continue;
    // Actionable = a textbook lens AND a LIVE probability (not a near-resolved 0.4% longshot
    // or a 99% foregone conclusion) — i.e. a directional read a trader can actually express.
    const actionable = !!klass.riskLens && yesProbPct >= 3 && yesProbPct <= 97;
    // The CLOB token id for the YES outcome — the key to fetch the probability-over-time
    // series (Polymarket prices-history is keyed by token). Same index as "yes" in outcomes.
    const clobIds = parseJsonArray(pm.clobTokenIds).map(String);
    const clobTokenId = (yi >= 0 && clobIds[yi]) ? clobIds[yi] : (clobIds[0] || null);
    out.push({
      id: pm.id ?? pm.conditionId ?? null,
      question: q,
      category: klass.category,
      riskLens: klass.riskLens,               // RISK_ON | RISK_OFF | null (only where textbook)
      actionable,
      yesProbPct,                             // the crowd's probability of YES
      clobTokenId,                            // YES-token id → /intel/events/history
      volumeUsd: Math.round(volume),
      liquidityUsd: Math.round(Number(pm.liquidity ?? 0) || 0),
      endDate: pm.endDate ?? null,
      slug: pm.slug ?? null,
    });
  }
  // Dedupe by id (pagination can overlap), then rank: ACTIONABLE (lensed + live-probability)
  // events first, then by volume. Non-actionable macro stays as context below.
  const seen = new Set();
  const uniq = out.filter((e) => (e.id == null ? true : (seen.has(e.id) ? false : seen.add(e.id))));
  uniq.sort((a, b) => (b.actionable ? 1 : 0) - (a.actionable ? 1 : 0) || b.volumeUsd - a.volumeUsd);
  return {
    scanned: (polyMarkets || []).length,
    count: uniq.length,
    actionableCount: uniq.filter((e) => e.actionable).length,
    events: uniq.slice(0, cfg.limit),
  };
}

// ── CATALYST READ — world events → the Nexus markets you can actually trade ───
// The unlock: with CL (crude), SPX500 + NAS100 (indices) listed, geopolitics/macro
// events map to a REAL tradeable impact here (e.g. Hormuz de-escalation → crude risk
// premium unwinds → short oil). Pure rules (transparent, not a black box); the crowd
// probability says how PRICED it already is. A setup to stake a graded thesis, never a
// signal. Every impact names a listed Nexus market so borst's "trade it here" rule holds.
export const CATALYST_MARKETS = {
  BTC: "PERP_BTC_USDC", ETH: "PERP_ETH_USDC",
  SPX: "PERP_SPX500_USDC", NAS: "PERP_NAS100_USDC", OIL: "PERP_CL_USDC",
};
const OIL_REGION_RX = /\b(iran|hormuz|strait|opec|saudi|russia|ukraine|middle east|israel|gaza|red sea|oil|crude|petrol|pipeline|refinery|venezuela|sanction\w*)\b/i;

// Map a classified event (category + risk lens) to tradeable directional impacts.
export function catalystImpact(category, riskLens, question) {
  const q = String(question || "");
  const on = riskLens === "RISK_ON", off = riskLens === "RISK_OFF";
  const out = [];
  if (on) {
    out.push({ coin: "BTC", market: CATALYST_MARKETS.BTC, direction: "LONG", rationale: "risk-on backdrop" });
    out.push({ coin: "SPX500", market: CATALYST_MARKETS.SPX, direction: "LONG", rationale: "equities bid on risk-on" });
  } else if (off) {
    out.push({ coin: "BTC", market: CATALYST_MARKETS.BTC, direction: "SHORT", rationale: "risk-off backdrop" });
    out.push({ coin: "SPX500", market: CATALYST_MARKETS.SPX, direction: "SHORT", rationale: "equities offered on risk-off" });
  }
  if (category === "RATES") {
    if (on) out.push({ coin: "NAS100", market: CATALYST_MARKETS.NAS, direction: "LONG", rationale: "lower rates lift tech" });
    if (off) out.push({ coin: "NAS100", market: CATALYST_MARKETS.NAS, direction: "SHORT", rationale: "higher rates weigh on tech" });
  }
  if (category === "GEOPOLITICS" && OIL_REGION_RX.test(q)) {
    if (off) out.push({ coin: "CL", market: CATALYST_MARKETS.OIL, direction: "LONG", rationale: "supply-risk premium — crude bid" });
    if (on) out.push({ coin: "CL", market: CATALYST_MARKETS.OIL, direction: "SHORT", rationale: "de-escalation unwinds the crude risk premium" });
  }
  return out;
}

// A NEGATED question flips the lens: "will NO rate cuts happen" resolving YES is hawkish
// (risk-off), even though the string contains "cut". Narrow + safe — only flips when a
// negation word sits before the move keyword. Pure; exported for tests.
export function resolveLens(riskLens, question) {
  if (!riskLens) return riskLens;
  const negated = /\b(no|not|won'?t|without|zero|fail\w*|never)\b[^?]{0,40}\b(cut\w*|hike\w*|rais\w*|lower\w*|reduc\w*|increas\w*|recession\w*|approv\w*|pass\w*|deal\w*|ceasefire|peace\w*)/i.test(String(question || ""));
  return negated ? (riskLens === "RISK_ON" ? "RISK_OFF" : "RISK_ON") : riskLens;
}

// Build the catalyst board from Polymarket markets: classify → keep events with a lens
// + a LIVE probability that map to a tradeable impact → the strongest by volume first.
export function catalystBoard(polyMarkets, { minVolumeUsd = 20000, limit = 24 } = {}) {
  const rows = [];
  for (const pm of polyMarkets || []) {
    if (pm && (pm.closed === true || pm.active === false)) continue;
    const q = pm && pm.question; if (!q) continue;
    const klass = classifyMacro(q); if (!klass || !klass.riskLens) continue;
    const lens = resolveLens(klass.riskLens, q);
    const impacts = catalystImpact(klass.category, lens, q);
    if (!impacts.length) continue;
    const volume = Number(pm.volumeNum ?? pm.volume ?? 0) || 0;
    if (volume < minVolumeUsd) continue;
    const outcomes = parseJsonArray(pm.outcomes).map((x) => String(x).toLowerCase());
    const prices = parseJsonArray(pm.outcomePrices).map(Number);
    let yesProb = null; const yi = outcomes.indexOf("yes");
    if (yi >= 0 && Number.isFinite(prices[yi])) yesProb = prices[yi];
    else if (prices.length && Number.isFinite(prices[0])) yesProb = prices[0];
    if (yesProb == null || !Number.isFinite(yesProb)) continue;
    const yesProbPct = round(yesProb * 100, 1);
    if (yesProbPct < 3 || yesProbPct > 97) continue; // a live, expressible probability
    const clobIds = parseJsonArray(pm.clobTokenIds).map(String);
    rows.push({
      question: String(q), category: klass.category, riskLens: lens,
      yesProbPct, volumeUsd: volume, endDate: pm.endDate || pm.end_date_iso || null,
      clobTokenId: (yi >= 0 && clobIds[yi]) ? clobIds[yi] : (clobIds[0] || null),
      impacts,
    });
  }
  rows.sort((a, b) => b.volumeUsd - a.volumeUsd);
  const seen = new Set(), uniq = [];
  for (const r of rows) { const k = r.question.toLowerCase(); if (seen.has(k)) continue; seen.add(k); uniq.push(r); }
  return { scanned: (polyMarkets || []).length, count: uniq.length, catalysts: uniq.slice(0, limit) };
}

// ── Roadmap #3: Catalyst → the ONE gradeable thesis schema ────────────────────
// Convert a catalyst IMPACT ({coin, market, direction, rationale}) into the exact shape
// gradeCall() consumes, so the Catalyst producer and hand-authored theses are graded by
// ONE grader, in R. Levels come from a symmetric risk leg (stopPct of entry) and the
// target asymmetry (riskReward): first-touch of TP prints +riskReward R, first-touch of
// SL prints −1R — identical to a manual call. `catalyst` carries the "why now" so the
// macro classifier / regime attribution pick it up for free. entry defaults to the live
// mark (the moment it's staked); pass createdAt to pin the grade window. null if unpriced.
export function catalystToThesis(impact, { markPrice, createdAt = Date.now(), stopPct = 2, riskReward = 2, question = "", category = null } = {}) {
  const dir = impact && impact.direction;
  const px = Number(markPrice);
  if ((dir !== "LONG" && dir !== "SHORT") || !(px > 0) || !impact.market) return null;
  const rr = Number(riskReward) > 0 ? Number(riskReward) : 2;
  const risk = px * (Math.max(0.1, Number(stopPct) || 2) / 100);
  const stopLoss = dir === "LONG" ? px - risk : px + risk;
  const takeProfit1 = dir === "LONG" ? px + risk * rr : px - risk * rr;
  return {
    source: "catalyst",
    symbol: impact.market,          // canonical PERP id (CATALYST_MARKETS) → normalizeSymbol no-ops
    coin: impact.coin,
    direction: dir,
    entryPrice: round(px, 4),
    stopLoss: round(stopLoss, 4),
    takeProfit1: round(takeProfit1, 4),
    riskReward: rr,
    createdAt,
    catalyst: question,             // the "why now" → isMacroCall + macro-caller attribution
    category,
    rationale: impact.rationale || "",
    isPublic: true,
  };
}

// Full thesis RECORD for a PERSISTED, auto-graded HOUSE catalyst call (vs the lean stake
// template catalystToThesis returns for the board). Same deterministic levels + the record
// fields the grader and ThesisCard read (id, status, UI zeros, notes). source:"catalyst"
// keeps it on its own track, distinct from the funding-fade "nexus-signal" house calls.
export function catalystHouseCall(impact, opts = {}) {
  const { markPrice, question = "", category = null, now = Date.now(), stopPct = 2, riskReward = 2 } = opts;
  const base = catalystToThesis(impact, { markPrice, createdAt: now, stopPct, riskReward, question, category });
  if (!base) return null;
  return {
    ...base,
    id: `catalyst-${impact.coin}-${impact.direction}-${now}`,
    takeProfit2: 0,
    riskPercent: 0, accountSize: 0, fundingRate: 0, positionSize: 0, leverage: 0,
    fundingCost8h: 0, fundingCost24h: 0, fundingCost72h: 0,
    status: "ACTIVE",
    actualPnl: null,
    notes: `Catalyst Read - ${question || "world event"} → ${impact.rationale || `${impact.direction} ${impact.coin}`}. Deterministic levels (${stopPct}% risk leg, ${riskReward}R). Graded trustlessly from public price, first-touch TP vs SL. A setup, not advice, not a signal.`,
  };
}

// ── FUNDING-TICKET verdict — server twin of MispricedBoard's honest edge test ─
// Grok: a FADE requires funding to be STRETCHED vs its OWN p25–p75 range (pierces the
// band), not merely high in absolute terms. ≥8 points needed; null = can't confirm → WATCH.
// Kept in lockstep with the client fundingStretched (MispricedBoard.tsx) so the share card
// can never drift from the ticket the user is looking at.
export function fundingStretched(fundingValues) {
  const fs = (fundingValues || []).filter((f) => Number.isFinite(f));
  if (fs.length < 8) return null;
  const srt = [...fs].sort((a, b) => a - b);
  const q = (p) => srt[Math.min(srt.length - 1, Math.max(0, Math.round(p * (srt.length - 1))))];
  const lf = fs[fs.length - 1];
  return lf > q(0.75) || lf < q(0.25);
}
export function readVerdict(direction, stretched) {
  if (direction !== "LONG" && direction !== "SHORT") return "NONE";
  return stretched === true ? "FADE" : "WATCH";
}

// ── THE BOARD share card — the top confluence reads, server-side ──────────────
// Mirrors DecisionBoard's mechanical PLAY + 4-lens agreement so the shareable OG card
// shows the SAME read as the live Board (no drift on the thresholds). Pure; the OG route
// supplies the fetched inputs (signals + the four lens maps). Honesty by construction:
// every input is a public fact, the play is the mechanical read, agreement is independent.
const CB_CROWDED = 0.0004, CB_LEAN_MIN = 0.00003;
export function boardCardPlay(s) {
  const f = Number(s.funding_rate_8h) || 0;
  if (s.confluence === "LONG" || s.confluence === "SHORT") return { dir: s.confluence, label: `Confluence ${s.confluence === "LONG" ? "long" : "short"}`, klass: "CONFLUENCE", strong: true };
  if (Math.abs(f) >= CB_CROWDED) { const dir = f > 0 ? "SHORT" : "LONG"; return { dir, label: `Fade ${dir === "LONG" ? "long" : "short"}`, klass: "FADE", strong: true }; }
  if ((s.trend === "TREND_UP" || s.trend === "TREND_DOWN") && (Number(s.trend_oi_pct) || 0) >= 1) { const dir = s.trend === "TREND_UP" ? "LONG" : "SHORT"; return { dir, label: `Ride ${dir === "LONG" ? "up" : "down"}`, klass: "TREND", strong: true }; }
  if (Math.abs(f) >= CB_LEAN_MIN) { const dir = f > 0 ? "SHORT" : "LONG"; return { dir, label: `leans ${dir === "LONG" ? "long" : "short"}`, klass: "LEAN", strong: false }; }
  return { dir: null, label: "—", klass: null, strong: false };
}
const cbBare = (x) => String(x || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
export function boardCardRows({ signals = [], consensus = {}, smart = {}, catalyst = {}, forecast = {} }, limit = 6) {
  const rows = [];
  for (const s of signals || []) {
    const coin = cbBare(s.symbol);
    const play = boardCardPlay(s);
    const c = consensus[s.symbol] || consensus[coin];
    const lens = {
      callers: c && c.side !== "SPLIT" ? c.side : null,
      smart: smart[coin] || null,
      catalyst: catalyst[coin] || null,
      forecast: forecast[coin] || null,
    };
    const agree = play.dir ? Object.values(lens).filter((v) => v === play.dir).length : 0;
    const base = play.klass === "CONFLUENCE" ? 300 : play.klass === "FADE" ? 200 : play.klass === "TREND" ? 100 : play.klass === "LEAN" ? 10 : 0;
    const score = base + (play.strong ? agree * 25 : 0);
    rows.push({ coin, play, lens, agree, score, funding: Number(s.funding_rate_8h) || 0 });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}

// Attach a gradeable thesis draft to every impact on every catalyst, using a coin→mark
// price map (bare coin, e.g. BTC/SPX500/CL). Impacts without a live price get thesis:null
// (ungradeable, surfaced honestly). Pure — the price fetch happens in the route.
export function attachCatalystTheses(board, markByCoin, opts = {}) {
  const catalysts = (board.catalysts || []).map((c) => ({
    ...c,
    impacts: (c.impacts || []).map((im) => ({
      ...im,
      thesis: catalystToThesis(im, { ...opts, markPrice: markByCoin[im.coin], question: c.question, category: c.category }),
    })),
  }));
  return { ...board, catalysts, gradeableCount: catalysts.reduce((n, c) => n + c.impacts.filter((i) => i.thesis).length, 0) };
}
