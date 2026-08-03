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
  minEdgePct: 8,     // |annualized funding| ≥ this ⇒ flagged MISPRICED · WATCHING
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
