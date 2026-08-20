// ═══════════════════════════════════════════════════════════════════════════
// OPERATOR PROFILE — the Lab's one point of view about you
// ═══════════════════════════════════════════════════════════════════════════
// Nexus computes eight separate reads of a trader — symbol/direction edge, regime
// edge, expectancy shape, plan quality, execution adherence, tagged leaks, sizing
// calibration, merit rank. Shown as eight cards, that isn't depth: it's eight
// dashboards and an implicit request that the user be their own analyst.
//
// This composes them into ONE identity: an archetype, three numbers that matter, and
// a severity-ordered narrative. Intelligence isn't more readouts — it's a point of
// view. Pure composition: every input is already computed elsewhere, so this adds no
// new data source and cannot disagree with the cards it summarizes.
//
// TWO RULES, both load-bearing:
//  1. NEVER claim more than the sample supports. Each read carries its own gate; a
//     thin record yields fewer sentences, not vaguer ones. `unlocks` states exactly
//     what would earn the next claim — at cold start that IS the product's job.
//  2. Mixed provenance is tracked, not blurred. Public-price-graded facts (regime,
//     expectancy, plan quality) and private/self-reported ones (fills, tagged leaks)
//     both inform coaching, but only the graded half may ever be shown publicly.
//     Every read is stamped `provenance` so callers can filter. See PUBLIC_READS.
//
// Pure + dependency-free: `node --test app/lib/operatorProfile.test.mjs`.

const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const money = (n) => `$${Math.abs(Math.round(n)).toLocaleString()}`;

// ── archetype ────────────────────────────────────────────────────────
// A label a trader would actually use about themselves, assembled from three
// independent axes so it says something real instead of flattering.
export const HOLD_STYLE = { intraday: 6, swing: 72 }; // median hold hours → style

/** Median hold time in hours across closed trades, or null. */
export function medianHoldHours(trades) {
  const hrs = (trades || [])
    .map((t) => {
      const open = Number(t?.openTimestamp) || 0, close = Number(t?.timestamp) || 0;
      return open && close && close > open ? (close - open) / 3600000 : null;
    })
    .filter((h) => h != null)
    .sort((a, b) => a - b);
  if (!hrs.length) return null;
  return round(hrs[Math.floor(hrs.length / 2)], 1);
}

/**
 * Compose the archetype from what the record actually shows.
 *   market fit  — does the edge live with the trend or against it (graded calls)
 *   payoff      — a few fat tails, or many small grinds (expectancy shape)
 *   horizon     — median hold time (realized fills)
 * Any axis with too little evidence is simply omitted rather than guessed.
 */
export const ARCHETYPE_MIN_CALLS = 5; // payoff shape needs a real sample, like every other claim

export function deriveArchetype({ regimeEdges, expectancy, holdHours, gradedCalls = 0 } = {}) {
  const parts = [];
  const why = [];

  // Payoff shape — the most characterful axis, so it leads.
  // ⚠️ Sample-gated. Without this a SINGLE losing call yields avgWinR 0 / avgLossR 1,
  // a payoff ratio of 0, and the confident label "Grinder" — which is exactly the
  // overclaim the rest of this module exists to prevent. Caught on a live 1-call
  // wallet, where the archetype headlined a profile that had no reads at all.
  if (gradedCalls >= ARCHETYPE_MIN_CALLS && expectancy && Number.isFinite(expectancy.tailRatio)) {
    const { tailRatio, avgWinR, avgLossR } = expectancy;
    const payoff = avgLossR > 0 ? avgWinR / avgLossR : null;
    if (tailRatio >= 0.5 && payoff != null && payoff >= 1.8) {
      parts.push("fat-tail"); why.push(`${Math.round(tailRatio * 100)}% of your winning R comes from your top fifth of wins`);
    } else if (payoff != null && payoff <= 1.1) {
      parts.push("grinder"); why.push("your wins and losses are close to the same size, so hit rate has to carry you");
    }
  }

  // Market fit — from the alignment buckets (needs a real sample on both sides).
  const align = regimeEdges?.align;
  if (align?.best?.bucket && align.best.calls >= 5) {
    if (align.best.bucket === "align:WITH_TREND") { parts.push("trend-follower"); why.push("your graded record is strongest trading with the trend"); }
    else if (align.best.bucket === "align:AGAINST_TREND") { parts.push("counter-trend trader"); why.push("your graded record is strongest fading moves"); }
  }

  // Horizon — from realized hold time.
  let horizon = null;
  if (holdHours != null) {
    horizon = holdHours <= HOLD_STYLE.intraday ? "intraday" : holdHours <= HOLD_STYLE.swing ? "swing" : "position";
    why.push(`median hold ${holdHours < 24 ? `${holdHours}h` : `${round(holdHours / 24, 1)}d`}`);
  }

  if (!parts.length && !horizon) return null;
  const label = [parts.join(" "), horizon ? `(${horizon})` : ""].filter(Boolean).join(" ").trim();
  return { label: label.charAt(0).toUpperCase() + label.slice(1), horizon, why };
}

// ── the reads ────────────────────────────────────────────────────────
// Severity-ordered so the narrative opens with the thing that costs the most money.
// `provenance: "graded"` = derived from public price and safe to show publicly;
// "private" = the user's own fills or self-reported tags — coaching only.
export const READ_ORDER = ["MONEY_LEAK", "TILT", "OVERTRADING", "SIZING", "REGIME", "PAYOFF", "DISCIPLINE", "CALIBRATION", "SESSION", "SYMBOL"];
export const PUBLIC_READS = new Set(["REGIME", "PAYOFF", "DISCIPLINE", "CALIBRATION"]);

const BUCKET_WORD = {
  "trend:TREND_UP": "uptrends", "trend:TREND_DOWN": "downtrends", "trend:CHOP": "chop",
  "align:WITH_TREND": "trading with the trend", "align:AGAINST_TREND": "fading moves", "align:CHOP": "trendless tape",
  "vol:CALM": "calm tape", "vol:NORMAL": "normal volatility", "vol:VOLATILE": "volatile tape",
};
const word = (b) => BUCKET_WORD[b] ?? b;

/**
 * Build the profile.
 *
 * Every input is optional and nullable — a caller with no wallet, no fills or an
 * unreachable API still gets a valid (thinner) profile rather than an exception.
 *
 * @param {object} [i]
 * @param {object|null} [i.process]    /theses/process payload (graded: expectancy, regimeEdges, discipline, calibration)
 * @param {object|null} [i.edge]       computeEdge(trades) readout (private: realized symbol/side edge)
 * @param {object|null} [i.adherence]  adherenceReport(theses, trades) (private)
 * @param {object|null} [i.leaks]      leakProfile(theses) (private, self-reported)
 * @param {object[]|null} [i.trades]   closed positions (private, for hold time)
 * @param {object|null} [i.behavioral] { tilt, session } from behavioral.mjs (private, sequenced fills)
 */
export function buildOperatorProfile({ process, edge, adherence, leaks, trades, behavioral } = {}) {
  const gradedCalls = Number(process?.calls) || 0;
  const expectancy = process?.expectancy || null;
  const regimeEdges = process?.regimeEdges || null;
  const discipline = process?.discipline || null;
  const calibration = process?.calibration || null;
  const closed = Number(edge?.closed_trades) || (trades?.length ?? 0);

  const holdHours = medianHoldHours(trades);
  const archetype = deriveArchetype({ regimeEdges, expectancy, holdHours, gradedCalls });
  const reads = [];

  // 1. MONEY LEAK — the costliest fixable habit, whichever source priced it highest.
  // Adherence (broke your own plan) and tagged leaks (why it lost) can both carry a
  // dollar figure; take the bigger one so the headline is the real headline.
  const candidates = [];
  if (adherence?.topLeak?.costUsd) candidates.push({ kind: "adherence", label: adherence.topLeak.flag, cost: adherence.topLeak.costUsd, count: adherence.topLeak.count });
  if (leaks?.top?.costUsd) candidates.push({ kind: "postmortem", label: leaks.top.reason, cost: leaks.top.costUsd, count: leaks.top.count });
  candidates.sort((a, b) => b.cost - a.cost);
  if (candidates[0]) {
    const c = candidates[0];
    reads.push({
      kind: "MONEY_LEAK", provenance: "private", severity: 3,
      key: c.label, costUsd: c.cost, count: c.count,
      text: `costing you ${money(c.cost)} across ${c.count} ${c.count === 1 ? "trade" : "trades"}`,
    });
  }

  // 1b. TILT — the behavioral money-leak the ledger can't tag: do the trades you take
  // right after a loss underperform? Only your sequenced fills reveal it; ranks with the
  // money leaks because pressing to get even is exactly where records bleed.
  if (behavioral?.tilt) {
    const t = behavioral.tilt;
    reads.push({
      kind: "TILT", provenance: "private", severity: 3,
      afterLossWr: t.afterLossWr, baselineWr: t.baselineWr, gapPts: t.gapPts, count: t.n, netUsd: t.netUsd,
      text: `you trade worse right after a loss — ${t.afterLossWr}% win on the ${t.n} trades after a red close vs ${t.baselineWr}% overall, so step back before pressing`,
    });
  }

  // 1c. OVERTRADING — the behavioral leak the tape can't tag either: after your first
  // couple of trades each day, discipline breaks and the extra clicks bleed. Ranks with
  // the money leaks because that's what it is — the cost of not walking away.
  if (behavioral?.overtrading) {
    const o = behavioral.overtrading;
    reads.push({
      kind: "OVERTRADING", provenance: "private", severity: 3,
      firstWr: o.firstWr, excessWr: o.excessWr, gapPts: o.gapPts, count: o.excessN, netUsd: o.excessNet, cutoff: o.cutoff,
      text: `you overtrade — after your first ${o.cutoff} trades each day the extra ${o.excessN} win just ${o.excessWr}% (vs ${o.firstWr}%)${o.excessNet < 0 ? `, ${money(o.excessNet)} of leak` : ""}, so cap the day once your plan is done`,
    });
  }

  // 1d. SIZING — does your bet SIZE react to your last result? Revenge (bigger after a
  // loss) is a money-leak-grade tell and ranks with them; pressing (bigger after a win)
  // is a lower-severity heads-up. Distinct from CALIBRATION (conviction vs outcome) — this
  // is the emotional reaction the graded calls can't see.
  if (behavioral?.sizing) {
    const z = behavioral.sizing;
    reads.push(z.mode === "revenge"
      ? {
          kind: "SIZING", provenance: "private", severity: 3, mode: "revenge",
          ratio: z.ratio, afterLossSize: z.afterLossSize, afterWinSize: z.afterWinSize, count: z.afterLossN, netUsd: z.cohortNet,
          text: `you size up when you're losing — bets after a loss average ${money(z.afterLossSize)} vs ${money(z.afterWinSize)} after a win (${z.ratio}× bigger)${z.cohortNet < 0 ? `, ${money(z.cohortNet)} on those trades` : ""}; that's revenge, not conviction — keep your size flat`,
        }
      : {
          kind: "SIZING", provenance: "private", severity: 1, mode: "pressing",
          ratio: z.ratio, afterLossSize: z.afterLossSize, afterWinSize: z.afterWinSize, count: z.afterWinN,
          text: `you press your size after a win — ${money(z.afterWinSize)} vs ${money(z.afterLossSize)} after a loss (${z.ratio}× bigger); riding a hot hand works until the give-back`,
        });
  }

  // 2. REGIME — where the edge lives and dies. The most actionable filter available.
  const re = regimeEdges?.trend || regimeEdges?.align || regimeEdges?.vol || null;
  if (re) {
    reads.push({
      kind: "REGIME", provenance: "graded", severity: 3,
      best: re.best.bucket, worst: re.worst.bucket, gapR: re.gapR,
      text: `your edge is real in ${word(re.best.bucket)} (${re.best.avgR > 0 ? "+" : ""}${re.best.avgR}R over ${re.best.calls}) and gone in ${word(re.worst.bucket)} (${re.worst.avgR > 0 ? "+" : ""}${re.worst.avgR}R over ${re.worst.calls})`,
    });
  }

  // 3. PAYOFF — the expectancy lesson, and the trap that goes with each shape.
  if (expectancy && gradedCalls >= 5) {
    const hit = Number(process?.hitRate);
    const asym = expectancy.avgLossR > 0 ? round(expectancy.avgWinR / expectancy.avgLossR, 1) : null;
    const lowHit = Number.isFinite(hit) && hit < 50;
    reads.push({
      kind: "PAYOFF", provenance: "graded", severity: 2,
      expectancy: expectancy.expectancy, profitFactor: expectancy.profitFactor, hitRate: hit,
      text: lowHit && asym
        ? `${Math.round(hit)}% hit rate with ${asym}:1 payoff — the wins carry you, so cutting them short is the expensive mistake`
        : asym
          ? `${Math.round(hit)}% hit rate at ${asym}:1 payoff, ${expectancy.expectancy > 0 ? "+" : ""}${expectancy.expectancy}R per call`
          : `${expectancy.expectancy > 0 ? "+" : ""}${expectancy.expectancy}R per call`,
    });
  }

  // 4. DISCIPLINE — recurring defect in how the calls are FORMED (public-verifiable).
  if (discipline?.topFlag && discipline.scored >= 5) {
    const f = discipline.topFlag;
    reads.push({
      kind: "DISCIPLINE", provenance: "graded", severity: f.rate >= 40 ? 3 : 1,
      score: discipline.score, flag: f.flag, rate: f.rate,
      text: `plan quality ${discipline.score}/100 — ${f.rate}% of your calls show ${DISCIPLINE_WORD[f.flag] ?? f.flag}`,
    });
  }

  // 5. CALIBRATION — the sizing read. Inversion is expensive and worth flagging loudly.
  if (calibration && (calibration.calibrated || calibration.inverted)) {
    reads.push({
      kind: "CALIBRATION", provenance: "graded", severity: calibration.inverted ? 3 : 1,
      calibrated: calibration.calibrated, inverted: calibration.inverted, gap: calibration.gap,
      text: calibration.calibrated
        ? `you size up on the right ideas (+${calibration.gap}R on your higher-conviction calls)`
        : `your bigger bets do WORSE (${calibration.gap}R) — conviction is pointing the wrong way`,
    });
  }

  // 6. SYMBOL — realized best/worst market, only on a real per-symbol sample.
  if (edge?.best_symbol && edge.best_symbol.trades >= 3) {
    const b = edge.best_symbol, w = edge.worst_symbol;
    reads.push({
      kind: "SYMBOL", provenance: "private", severity: 1,
      best: b.symbol, worst: w?.symbol ?? null,
      text: w && w.symbol !== b.symbol && w.trades >= 3
        ? `you make money on ${b.symbol} (${money(b.pnl)}) and give it back on ${w.symbol} (${money(w.pnl)})`
        : `${b.symbol} is your most profitable market (${money(b.pnl)})`,
    });
  }

  // 7. SESSION — WHEN you trade well. A private "trade your hours" read; low severity
  // (it's a filter, not a leak) but a genuinely useful lever the graded record can't see.
  if (behavioral?.session) {
    const s = behavioral.session;
    reads.push({
      kind: "SESSION", provenance: "private", severity: 1,
      best: s.best.name, worst: s.worst.name,
      text: `your edge is in the ${s.best.name} session (+${money(s.best.net)} over ${s.best.n}) and it bleeds in the ${s.worst.name} (−${money(s.worst.net)}) — trade when you're sharp`,
    });
  }

  reads.sort((a, b) => b.severity - a.severity || READ_ORDER.indexOf(a.kind) - READ_ORDER.indexOf(b.kind));

  // How much do we actually know? Drives the tier and the honest hedging.
  const dataScore = Math.min(100, Math.round(
    Math.min(gradedCalls / 20, 1) * 60 +      // graded calls are the load-bearing evidence
    Math.min(closed / 30, 1) * 25 +           // realized fills add the private half
    Math.min((adherence?.matched || 0) / 8, 1) * 15,
  ));
  // ⚠️ A large GRADED sample alone is enough to stop hedging. The first cut required
  // `closed >= 20` too, which a PUBLIC profile can never satisfy — another wallet's
  // fills are private by construction — so every public profile stayed FORMING and
  // appended "still a small sample" to a 24-call record. That hedge was simply false.
  // Graded calls are the load-bearing evidence (60% of dataScore); private fills
  // deepen a profile but are not required to trust it.
  const tier = (gradedCalls >= 20 || (gradedCalls >= 10 && closed >= 20)) ? "ESTABLISHED"
    : (gradedCalls >= 5 || closed >= 10) ? "FORMING"
    : "UNKNOWN";

  return {
    tier, dataScore, gradedCalls, closedTrades: closed, holdHours,
    archetype, reads,
    headline: buildHeadline({ process, expectancy, adherence, leaks, gradedCalls }),
    unlocks: buildUnlocks({ gradedCalls, closed, adherence, leaks, discipline, regimeEdges }),
    meritRank: process?.meritRank || null,
  };
}

const DISCIPLINE_WORD = {
  LATE_ENTRY: "an entry the market had already passed",
  STOP_IN_NOISE: "a stop inside the noise",
  STOP_TOO_WIDE: "a stop too wide to be risk control",
  RR_MISMATCH: "an R:R that doesn't match the levels",
  BAD_LEVELS: "malformed levels",
};

/** The three numbers worth putting at the top. Nulls are rendered as em-dashes. */
export function buildHeadline({ process, expectancy, adherence, leaks, gradedCalls = 0 } = {}) {
  const leakCost = Math.max(adherence?.topLeak?.costUsd || 0, leaks?.top?.costUsd || 0);
  // ⚠️ Sample-gated on the SAME threshold as the PAYOFF read. Without this the module
  // refuses to *say* the payoff sentence under 5 calls but happily *displays* the same
  // number as a headline stat — seen live on a 1-call profile reading "Not enough of a
  // graded record yet to say who this trader is" directly above "Expectancy -1R,
  // Profit factor 0". One losing call is not an expectancy. Plan quality is exempt: it
  // scores how a call was FORMED, which is meaningful from the very first one.
  const enough = gradedCalls >= ARCHETYPE_MIN_CALLS;
  const exp = enough ? expectancy : null;
  return [
    { key: "expectancy", label: "Expectancy", value: exp ? `${exp.expectancy > 0 ? "+" : ""}${exp.expectancy}R` : null, tone: exp ? (exp.expectancy > 0 ? "pos" : "neg") : null, sub: enough ? "per graded call" : `needs ${ARCHETYPE_MIN_CALLS} graded calls` },
    { key: "profitFactor", label: "Profit factor", value: exp ? (exp.profitFactor >= 99 ? "∞" : String(exp.profitFactor)) : null, tone: exp ? (exp.profitFactor >= 1 ? "pos" : "neg") : null, sub: enough ? "R won ÷ R lost" : `needs ${ARCHETYPE_MIN_CALLS} graded calls` },
    leakCost > 0
      ? { key: "leak", label: "Top leak", value: `−${money(leakCost)}`, tone: "neg", sub: "fixable, this ledger" }
      : { key: "plan", label: "Plan quality", value: process?.discipline ? `${process.discipline.score}` : null, tone: null, sub: "how well-formed your calls are" },
  ];
}

/**
 * What would earn the next claim. This is the cold-start product: the honest version
 * of "we don't know you yet" is a specific, small, next action — not a shrug.
 */
export function buildUnlocks({ gradedCalls, closed, adherence, leaks, discipline, regimeEdges } = {}) {
  const out = [];
  if (gradedCalls < 5) out.push({ need: 5 - gradedCalls, text: `Post ${5 - gradedCalls} more public call${5 - gradedCalls === 1 ? "" : "s"} to unlock your graded expectancy and merit rank` });
  else if (!regimeEdges?.trend && !regimeEdges?.align) out.push({ need: null, text: "A few more graded calls across different markets will reveal which regime your edge lives in" });
  // ⚠️ Reads correctly whether or not a wallet is attached. The first version said
  // "Connect your wallet…", which was shown to a user whose wallet WAS connected and
  // simply had no closed trades yet — the unlock told them to do something they had
  // already done.
  if (!closed) out.push({ need: null, text: "No closed trades read yet — once you trade the wallet you're connected with, execution adherence and your per-symbol edge unlock" });
  else if (!adherence?.matched) out.push({ need: null, text: "Write a thesis BEFORE you take the trade and adherence scoring will tell you whether you followed your own plan" });
  if (!leaks?.tagged) out.push({ need: null, text: "Tag why your losers lost (one tap) to build your leak profile" });
  if (discipline && discipline.scored < 5) out.push({ need: null, text: "Plan quality sharpens after 5 scored calls" });
  return out.slice(0, 3);
}

/**
 * Compose the reads into the paragraph. Kept here rather than in the component so
 * every surface (Lab card, share image, the AI copilot's context) says the same
 * thing about a trader.
 * @param {object} profile
 * @param {{publicOnly?:boolean, max?:number, voice?:"second"|"third"}} [opts]
 *   publicOnly drops private reads (the shareable version); voice:"third" re-points
 *   the pronouns for a stranger reading someone else's profile.
 */
export function profileNarrative(profile, { publicOnly = false, max = 4, voice = "second" } = {}) {
  if (!profile) return "";
  const third = voice === "third";
  const reads = (profile.reads || []).filter((r) => !publicOnly || PUBLIC_READS.has(r.kind)).slice(0, max);
  if (!reads.length) {
    if (profile.tier === "UNKNOWN") {
      return third
        ? "Not enough of a graded record yet to say who this trader is."
        : "Not enough of a record yet to say who you are as a trader — that's what the unlocks below are for.";
    }
    return third
      ? "This record is still forming; the reads below will sharpen as more calls resolve."
      : "Your record is still forming; the reads below will sharpen as more calls resolve.";
  }
  const head = profile.archetype ? `${profile.archetype.label}. ` : "";
  const body = reads.map((r) => (third ? toThirdPerson(r.text) : r.text)).join(". ");
  const tail = profile.tier === "FORMING"
    ? (third ? " (Small sample so far — leaning, not settled.)" : " (Still a small sample — treat these as leaning, not settled.)")
    : "";
  return `${head}${body.charAt(0).toUpperCase()}${body.slice(1)}.${tail}`;
}

// Read texts are authored in second person for the owner's own Lab. A public profile
// is a stranger reading ABOUT someone, where "your edge" is plainly wrong — so the
// same sentences are re-pointed rather than duplicated in two voices (which would
// inevitably drift apart).
function toThirdPerson(text) {
  return text
    // Object pronouns FIRST: these read "...carry you", where a blanket you->they
    // would produce "carry they". Word-boundaried so "yourself" cannot be mangled.
    .replace(/\b(carry|costing|paying|pays|cost)\s+you\b/gi, "$1 them")
    .replace(/\byou're\b/gi, "they're")
    .replace(/\byour\b/gi, "their")
    .replace(/\byou\b/gi, "they");
}
