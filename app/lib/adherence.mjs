// ═══════════════════════════════════════════════════════════════════════════
// EXECUTION ADHERENCE — did you trade the plan you wrote?
// ═══════════════════════════════════════════════════════════════════════════
// The other half of process grading. Outcome grading says whether a call was
// right; plan quality (lab-api logic.mjs) says whether it was well-formed. Neither
// asks the question every trading coach asks first: you wrote a plan — did you
// follow it? A win off a broken plan is a bad trade that got paid, and a loss that
// respected its stop is a good trade. That distinction is invisible in P&L.
//
// ⚠️ WHY THIS IS CLIENT-SIDE, AND WHY IT IS NEVER RANKED
// This needs the user's ACTUAL fills. Orderly's public dashboard indexer exposes
// only per-symbol aggregates — there is no public per-trade tape — so a wallet's
// fills are readable only by the wallet itself, via the auth'd trading API
// (/v1/position_history). A server therefore cannot verify any of it.
// Consequences, both deliberate:
//   1. It runs in the browser on data the user already has. Nothing is uploaded.
//   2. It must NEVER feed the leaderboard, merit ranks, or any public board. Those
//      rank only on trustless, recomputable evidence. Self-side numbers on a public
//      board is exactly the self-reported-PnL failure mode we exist to not be.
// So: this is a private coaching surface. Say so in the UI, and keep it there.
//
// Pure + dependency-free so `node --test app/lib/adherence.test.mjs` covers the
// real shipped code (same convention as the workers' logic.mjs).

/** "PERP_BTC_USDC" | "btc" → "BTC". Thesis symbols are bare tickers; fills aren't. */
export function baseTicker(sym) {
  return String(sym || "").toUpperCase().replace(/^PERP[_-]?/, "").replace(/[_-]?(USDC|USDT|USD)$/, "").replace(/[^A-Z0-9]/g, "");
}

export const MATCH = {
  windowH: 72,   // a fill this long after the call is still plausibly that call
  graceMin: 30,  // ...and one shortly BEFORE it counts too (people size in, then write it up)
};

/**
 * Find the fill that most plausibly belongs to a thesis: same market, same
 * direction, opened inside the window, earliest first.
 *
 * Deliberately conservative — no match is a fine answer. A wrong pairing produces
 * a confident, false "you broke your plan", which is worse than no readout at all.
 *
 * @param {object} t thesis
 * @param {object[]} trades closed positions ({symbol,direction,entryPrice,price,qty,pnl,timestamp,openTimestamp})
 * @returns {object|null}
 */
export function matchThesisToTrade(t, trades, cfg = MATCH) {
  if (!t || !Array.isArray(trades)) return null;
  const want = baseTicker(t.symbol);
  if (!want || !t.createdAt) return null;
  const from = t.createdAt - cfg.graceMin * 60 * 1000;
  const to = t.createdAt + cfg.windowH * 3600 * 1000;

  const candidates = trades.filter((x) => {
    if (baseTicker(x.symbol) !== want) return false;
    if (String(x.direction).toUpperCase() !== String(t.direction).toUpperCase()) return false;
    const opened = Number(x.openTimestamp) || Number(x.timestamp) || 0;
    return opened >= from && opened <= to;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => (Number(a.openTimestamp) || a.timestamp) - (Number(b.openTimestamp) || b.timestamp));
  return candidates[0];
}

// Penalties are ordered by how much each defect actually costs a career.
// Overrunning the stop is the one that ends accounts, so it dominates.
export const ADHERENCE_PENALTY = { STOP_BLOWN: 40, OVERSIZED: 25, EXIT_EARLY: 15, ENTRY_DRIFT: 10, UNDERSIZED: 5 };
export const ADHERENCE = {
  stopTolerance: 1.25,  // realized loss beyond 1.25x planned risk = the stop wasn't respected
  sizeTolerance: 0.35,  // ±35% off planned notional before it counts as a size deviation
  entryDriftR: 0.5,     // actual entry off by >0.5R of planned risk
  earlyExitFrac: 0.4,   // banked a winner short of 40% of the way to target
};

/**
 * Score one thesis against the fill that executed it.
 *
 * @returns {{score,flags,components,costUsd}|null} null when the plan lacks the
 *          fields to compare against (never guesses).
 */
export function scoreAdherence(t, trade, cfg = ADHERENCE) {
  if (!t || !trade) return null;
  const entry = Number(t.entryPrice), stop = Number(t.stopLoss), tp = Number(t.takeProfit1);
  const actualEntry = Number(trade.entryPrice), actualExit = Number(trade.price);
  if (!entry || !stop || !actualEntry) return null;
  const riskDist = Math.abs(entry - stop);
  if (!riskDist) return null;

  const long = String(t.direction).toUpperCase() === "LONG";
  const flags = [];
  const components = {};
  // costUsd: what each defect actually cost, in dollars. A score is abstract; "your
  // stop overruns cost $1,240 this month" is the thing that changes behavior.
  const costUsd = {};

  // ── 1. Was the stop respected? Compared in DOLLARS (planned risk vs realized
  // loss), which sidesteps any per-unit reconciliation and is what the trader feels.
  const plannedRiskUsd = (Number(t.accountSize) || 0) * ((Number(t.riskPercent) || 0) / 100);
  const pnl = Number(trade.pnl) || 0;
  if (plannedRiskUsd > 0) {
    components.plannedRiskUsd = round(plannedRiskUsd, 2);
    components.realizedUsd = round(pnl, 2);
    if (pnl < -plannedRiskUsd * cfg.stopTolerance) {
      flags.push("STOP_BLOWN");
      costUsd.STOP_BLOWN = round(Math.abs(pnl) - plannedRiskUsd, 2); // the excess beyond the plan
    }
  }

  // ── 2. Did the size match the plan? positionSize is notional USD (see ThesisView).
  const plannedNotional = Number(t.positionSize) || 0;
  const actualNotional = Math.abs(Number(trade.qty) || 0) * actualEntry;
  if (plannedNotional > 0 && actualNotional > 0) {
    const ratio = actualNotional / plannedNotional;
    components.sizeRatio = round(ratio, 2);
    components.plannedNotional = round(plannedNotional, 2);
    components.actualNotional = round(actualNotional, 2);
    // Oversizing is a risk failure; undersizing is a conviction failure. Both are
    // deviations, but they are not the same sin, so they score differently.
    if (ratio > 1 + cfg.sizeTolerance) flags.push("OVERSIZED");
    else if (ratio < 1 - cfg.sizeTolerance) flags.push("UNDERSIZED");
  }

  // ── 3. Did you get the entry you planned?
  const entryOffR = Math.abs(actualEntry - entry) / riskDist;
  components.entryOffR = round(entryOffR, 2);
  if (entryOffR > cfg.entryDriftR) flags.push("ENTRY_DRIFT");

  // ── 4. Winners cut short. Only meaningful on a profitable close with a target set.
  if (tp && actualExit && pnl > 0) {
    const rewardDist = Math.abs(tp - actualEntry);
    const captured = long ? actualExit - actualEntry : actualEntry - actualExit;
    if (rewardDist > 0 && captured > 0) {
      const frac = captured / rewardDist;
      components.targetCaptured = round(frac, 2);
      if (frac < cfg.earlyExitFrac) {
        flags.push("EXIT_EARLY");
        // Money left on the table if the stated target had been reached.
        costUsd.EXIT_EARLY = round((rewardDist - captured) * Math.abs(Number(trade.qty) || 0), 2);
      }
    }
  }

  let score = 100;
  for (const f of flags) score -= ADHERENCE_PENALTY[f] || 0;
  return { score: Math.max(0, Math.min(100, score)), flags, components, costUsd };
}

/**
 * Roll a wallet's theses + fills into the coaching readout.
 *
 * @returns {{matched,unmatched,score,flagCounts,costUsd,topLeak,rows}}
 */
export function adherenceReport(theses, trades, cfg = ADHERENCE, matchCfg = MATCH) {
  const rows = [];
  let unmatched = 0;
  for (const t of theses || []) {
    const trade = matchThesisToTrade(t, trades, matchCfg);
    if (!trade) { unmatched++; continue; }
    const s = scoreAdherence(t, trade, cfg);
    if (!s) { unmatched++; continue; }
    rows.push({ id: t.id, symbol: baseTicker(t.symbol), direction: t.direction, createdAt: t.createdAt, ...s });
  }
  if (!rows.length) return { matched: 0, unmatched, score: null, flagCounts: {}, costUsd: {}, topLeak: null, rows: [] };

  const flagCounts = {}, costUsd = {};
  for (const r of rows) {
    for (const f of r.flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
    for (const [f, c] of Object.entries(r.costUsd)) costUsd[f] = round((costUsd[f] || 0) + c, 2);
  }
  // The leak worth naming is the one that cost the most money — falling back to
  // frequency only when nothing has a dollar figure attached (e.g. sizing drift).
  const byCost = Object.entries(costUsd).sort((a, b) => b[1] - a[1])[0];
  const byCount = Object.entries(flagCounts).sort((a, b) => b[1] - a[1])[0];
  const topLeak = byCost
    ? { flag: byCost[0], costUsd: byCost[1], count: flagCounts[byCost[0]] || 0 }
    : byCount ? { flag: byCount[0], costUsd: null, count: byCount[1] } : null;

  return {
    matched: rows.length,
    unmatched,
    score: Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length),
    flagCounts,
    costUsd,
    topLeak,
    rows: rows.sort((a, b) => b.createdAt - a.createdAt),
  };
}

/** Plain-language label + why it matters. Single source for every UI surface. */
export const ADHERENCE_LABELS = {
  STOP_BLOWN: { label: "Stop not respected", why: "Realized loss exceeded the risk you planned — the stop moved or wasn't there." },
  OVERSIZED: { label: "Oversized vs plan", why: "You risked more than the plan called for, so one loss hits harder than modeled." },
  UNDERSIZED: { label: "Undersized vs plan", why: "You took less than the plan called for — right ideas paying you less than they should." },
  EXIT_EARLY: { label: "Winner cut short", why: "Banked well before your own target, which caps the fat tail that pays for the losers." },
  ENTRY_DRIFT: { label: "Entry off plan", why: "Filled meaningfully away from your level, changing the R the plan was built on." },
};

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;
