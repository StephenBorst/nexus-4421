// ── Thesis grading + caller aggregation ──
// The trustless core: grade every PUBLIC call against public price (first-touch
// TP-vs-SL) and aggregate per wallet. Lifted out of index.js's fetch handler
// (migration rules in shared.mjs).
//
// NOT folded into routes-theses.mjs on purpose: these are shared infrastructure, not
// theses-exclusive. gradedStatusOf/fetchGradeHistory drive the OG card routes,
// computeCallerStats also scores Desks, and gradePublicTheses is driven by the hourly
// cron. Burying them in a route slice would force index.js to import back out of a
// module it dispatches to.
//
// ⚠️ Pure move — logic byte-identical to what shipped.
import { notifyResolution } from "./resolutions.mjs";
import {
  gradeCall, REGIME, classifyRegime, callAlignment, regimeBucketsOf, regimeBuckets,
  regimeEdge, planQuality, planSummary, expectancyStats, convictionCalibration, rankCaller,
  consensusBySymbol, stanceAtPost, classifyContrarian, aggregateSideRecord, contrarianEdgeScore,
} from "./logic.mjs";

// ── Historical stance snapshots (contrarian grading) ─────────────────────────
// Persist the merit-weighted consensus lean per symbol over time so a call can later
// be graded CONTRARIAN vs with-crowd against the lean that PRECEDED it. Mirrors the
// Tracked Record x-ray snapshot pattern. Keyed by BARE coin (BTC), matching the
// consensus board + the join in computeCallerStats. Spec: docs/historical-stance-snapshots-spec.md.
const STANCE_HIST_PREFIX = "stance:hist:";
const STANCE_SNAP_MIN_MS = 50 * 60 * 1000;  // ≥50min between stored snapshots (~hourly cron)
const STANCE_HIST_CAP = 240;
const STANCE_HIST_TTL = 400 * 86400;

async function readStanceHist(env, coin) {
  const raw = await env.LAB_STORE.get(STANCE_HIST_PREFIX + coin);
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Cron pass: snapshot the CURRENT merit-weighted lean per symbol. Only symbols with a
// real lean (a dominant side + ≥2 participants) are stored — SPLIT/thin ticks would make
// everything read "contrarian" against noise. Throttled per symbol. Best-effort.
export async function snapshotStances(env) {
  let stored = 0;
  try {
    const { entries } = await gatherStanceEntries(env);
    const consensus = consensusBySymbol(entries);
    const now = Date.now();
    for (const [coin, c] of Object.entries(consensus)) {
      if ((c.side !== "LONG" && c.side !== "SHORT") || (c.participants || 0) < 2) continue;
      const hist = await readStanceHist(env, coin);
      const last = hist[hist.length - 1];
      if (last && Number.isFinite(last.t) && now - last.t < STANCE_SNAP_MIN_MS) continue;
      hist.push({ t: now, side: c.side, lean: c.lean, longWeight: c.longWeight, shortWeight: c.shortWeight, participants: c.participants });
      await env.LAB_STORE.put(STANCE_HIST_PREFIX + coin, JSON.stringify(hist.slice(-STANCE_HIST_CAP)), { expirationTtl: STANCE_HIST_TTL });
      stored++;
    }
  } catch (e) { console.error("[stances] snapshot", e.message); }
  return stored;
}

// Grade every PUBLIC thesis call against public price (first-touch TP-vs-SL via
// gradeCall in logic.mjs) and aggregate per wallet → { wallet: {calls,wins,rSum} }.
// Shared by the human-caller leaderboard AND Desk scoring so the two never drift.
// PENDING/INVALID are excluded from the record (same rule as the board).
// gradeCall outcome → the objective card status. Kept trivial + pure so the mapping
// is obvious: a WIN is first-touch of TP, a LOSS is first-touch of SL (or same-candle,
// conservatively). PENDING means neither level has been touched yet → still ACTIVE.
export function gradedStatusOf(outcome) {
  return outcome === "WIN" ? "HIT_TP" : outcome === "LOSS" ? "STOPPED_OUT" : "ACTIVE";
}

// Fetch 1h OHLC from the thesis's createdAt to now, for gradeCall. Shared by the cron
// stamper and the on-read permalink grade so both use identical inputs.
// ⚠️ The window starts REGIME_PAD_S *before* the call, not at the call. Grading only
// needs candles from the call forward, but regime attribution + plan quality describe
// the market the call was posted INTO, which lives entirely in the bars before it.
// Without the pad, classifyRegime returns null for every call (nothing precedes it).
// Closes (`c`) are kept for the same reason — gradeCall only reads highs/lows.
export const REGIME_PAD_S = (REGIME.LOOKBACK + 2) * 3600;

// Plan-quality flags, phrased for a trader looking at a DRAFT (POST /theses/advice)
// rather than a graded record — present tense, and each one names the fix.
export const ADVICE_FLAG_TEXT = {
  LATE_ENTRY: "Price has already run past your entry — the R you're claiming isn't obtainable from here.",
  STOP_IN_NOISE: "Your stop sits inside a single bar's normal range — this is a coin flip on noise, not on the idea.",
  STOP_TOO_WIDE: "That stop is too wide to be risk control. Cut the size instead.",
  RR_MISMATCH: "Your stated R:R doesn't match these levels — the record will be graded on the levels.",
  BAD_LEVELS: "Your target or stop is on the wrong side of entry.",
};

export async function fetchGradeHistory(symbol, createdAt) {
  const now = Math.floor(Date.now() / 1000);
  const from = Math.max(Math.floor((createdAt || Date.now()) / 1000) - REGIME_PAD_S, now - 60 * 86400 - REGIME_PAD_S);
  try {
    const r = await fetch(`https://api-evm.orderly.org/tv/history?symbol=${symbol}&resolution=60&from=${from}&to=${now}`);
    const d = await r.json();
    if (d && d.s === "ok" && Array.isArray(d.t)) return { t: d.t, h: d.h, l: d.l, c: d.c };
  } catch (e) { console.error("[grade] history", symbol, e.message); }
  return null;
}

// Cron pass: objectively resolve every PUBLIC thesis from public price and STAMP the
// result onto the stored record — gradedOutcome (WIN/LOSS), gradedR, gradedAt. This is
// what makes "it grades itself" true on the CARD, not just the leaderboard: the badge
// reads the stamp, never a self-report. Single writer (cron) = no race with the user's
// own edits, and we only write a wallet back when something actually changed.
export async function gradePublicTheses(env) {
  const listed = await env.LAB_STORE.list({ prefix: "lab:" });
  let graded = 0, walletsWritten = 0;
  // Cache OHLC per symbol across the whole pass so 50 BTC calls fetch history once.
  const histCache = new Map();
  for (const key of listed.keys) {
    const raw = await env.LAB_STORE.get(key.name);
    if (!raw) continue;
    let data; try { data = JSON.parse(raw); } catch { continue; }
    let changed = false;
    // Collected, not dispatched inline: a resolution must only be announced once the
    // stamp is actually persisted (see resolutions.mjs).
    const justResolved = [];
    for (const t of (data.theses || [])) {
      if (!t.isPublic || !t.symbol || !t.createdAt) continue;
      const resolved = t.gradedOutcome === "WIN" || t.gradedOutcome === "LOSS"; // resolved = final
      // Plan quality + regime are properties of the MOMENT THE CALL WAS POSTED, so
      // they're stamped once and never revisited — including on already-resolved
      // calls that predate this feature (backfill). Skipped beyond the history
      // horizon, where the candles we'd need no longer come back.
      const stampable = t.planScore === undefined && t.createdAt > Date.now() - 60 * 86400 * 1000;
      if (resolved && !stampable) continue;

      const cacheKey = `${t.symbol}|${t.createdAt}`;
      if (!histCache.has(cacheKey)) histCache.set(cacheKey, await fetchGradeHistory(t.symbol, t.createdAt));
      const cd = histCache.get(cacheKey);

      if (stampable) {
        const pq = planQuality(t, cd);
        if (pq) { t.planScore = pq.score; t.planFlags = pq.flags; }
        const reg = classifyRegime(cd, Math.floor(t.createdAt / 1000));
        if (reg) {
          t.regimeTrend = reg.trend;
          t.regimeVol = reg.vol;
          t.regimeAlign = callAlignment(t.direction, reg);
        }
        // Stamp even when unscoreable, so a malformed call isn't re-fetched forever.
        if (t.planScore === undefined) t.planScore = null;
        changed = true;
      }

      if (!resolved) {
        const g = gradeCall(t, cd);
        if (g.outcome === "WIN" || g.outcome === "LOSS") {
          t.gradedOutcome = g.outcome;
          t.gradedR = g.r;
          t.gradedAt = Date.now();
          changed = true; graded++;
          justResolved.push({ t, outcome: g.outcome, r: g.r });
        }
      }
    }
    if (changed) {
      await env.LAB_STORE.put(key.name, JSON.stringify(data)); walletsWritten++;
      // Only now that the grade is durable. If the put throws we skip the fan-out and
      // the next pass re-resolves cleanly — better a late notification than a phantom
      // one for a grade that was never saved.
      const wallet = key.name.replace("lab:", "");
      for (const rz of justResolved) {
        await notifyResolution(env, wallet, rz.t, rz.outcome, rz.r);
      }
    }
  }
  console.log(`[grade] resolved ${graded} calls across ${walletsWritten} wallets`);
  return graded;
}

export async function computeCallerStats(env, maxHorizonS = 30 * 86400, opts = {}) {
  const onlyWallet = opts.onlyWallet ? String(opts.onlyWallet).toLowerCase() : null;
  const listed = await env.LAB_STORE.list({ prefix: "lab:" });
  const calls = [];
  for (const key of listed.keys) {
    const wallet = key.name.replace("lab:", "");
    // Single-wallet readouts (the process x-ray) skip every other wallet's KV read.
    if (onlyWallet && wallet.toLowerCase() !== onlyWallet) continue;
    const raw = await env.LAB_STORE.get(key.name);
    if (!raw) continue;
    let data; try { data = JSON.parse(raw); } catch { continue; }
    for (const t of (data.theses || [])) {
      if (t.isPublic && t.symbol && t.createdAt) calls.push({ wallet, t });
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const symFrom = {};
  for (const { t } of calls) {
    const start = Math.floor((t.createdAt || Date.now()) / 1000);
    symFrom[t.symbol] = Math.min(symFrom[t.symbol] ?? start, start);
  }
  const history = {};
  await Promise.all(Object.entries(symFrom).map(async ([sym, fromS]) => {
    try {
      // Pad the window backwards so each call has prior bars to classify (see REGIME_PAD_S).
      const from = Math.max(fromS - REGIME_PAD_S, now - maxHorizonS - REGIME_PAD_S);
      const r = await fetch(`https://api-evm.orderly.org/tv/history?symbol=${sym}&resolution=60&from=${from}&to=${now}`);
      const d = await r.json();
      if (d && d.s === "ok" && Array.isArray(d.t)) history[sym] = { t: d.t, h: d.h, l: d.l, c: d.c };
    } catch (e) { console.error("[caller-stats] history fetch", sym, e.message); }
  }));
  // Contrarian grading is OPT-IN (opts.contrarian) so the hot stance path — gatherStanceEntries
  // → computeCallerStats for merit weights — doesn't pay for the extra KV reads. Only the
  // leaderboard + the contrarians board ask for it. Stance history is keyed by BARE coin.
  const wantContrarian = !!opts.contrarian;
  const stanceHist = {};
  if (wantContrarian) {
    const coins = [...new Set(calls.map(({ t }) => bareCoin(t.symbol)))];
    await Promise.all(coins.map(async (coin) => { stanceHist[coin] = await readStanceHist(env, coin); }));
  }
  const byWallet = {};
  for (const { wallet, t } of calls) {
    const cd = history[t.symbol];
    const g = gradeCall(t, cd);
    if (g.outcome === "PENDING" || g.outcome === "INVALID") continue;
    const a = byWallet[wallet] || (byWallet[wallet] = { calls: 0, wins: 0, rSum: 0, resolved: [], regimeRows: [], planScored: [], expRows: [], _contra: { calls: 0, wins: 0, rSum: 0 }, _crowd: { calls: 0, wins: 0, rSum: 0 } });
    a.calls += 1; if (g.outcome === "WIN") a.wins += 1; a.rSum += g.r;
    // Track (time, R) so the leaderboard can emit a cumulative-R equity curve —
    // the same trustless grade, just as a series instead of an aggregate.
    a.resolved.push({ at: t.createdAt || 0, r: g.r });
    // Expectancy + conviction-calibration input. conviction = the trader's own size
    // proxy: how much of the account they put at risk (riskPercent), falling back to
    // the planned asymmetry (riskReward). Lets us ask "did the bigger bets win?".
    const conviction = Number(t.riskPercent) > 0 ? Number(t.riskPercent)
      : (Number(t.riskReward) > 0 ? Number(t.riskReward) : NaN);
    a.expRows.push({ r: g.r, win: g.outcome === "WIN", conviction });

    // Attribute the SAME graded R to the regime the call was posted into. Same
    // candles, same first-touch outcome — this only asks "in which market?".
    const reg = classifyRegime(cd, Math.floor((t.createdAt || 0) / 1000));
    if (reg) a.regimeRows.push({ buckets: regimeBucketsOf(t.direction, reg), r: g.r, win: g.outcome === "WIN" });
    // Process grade: was the call well-formed at post time (public-verifiable half).
    const pq = planQuality(t, cd);
    if (pq) a.planScored.push(pq);

    // Contrarian attribution: was this call made AGAINST the crowd lean that PRECEDED
    // it, and did it pay? Same graded R, joined to the stance snapshot nearest-before
    // the post. Withheld (neither bucket) when there's no qualifying lean.
    if (wantContrarian) {
      const lean = stanceAtPost(stanceHist[bareCoin(t.symbol)], t.createdAt);
      const cls = classifyContrarian(t.direction, lean?.side);
      const bucket = cls === "CONTRARIAN" ? a._contra : cls === "WITH_CROWD" ? a._crowd : null;
      if (bucket) { bucket.calls += 1; if (g.outcome === "WIN") bucket.wins += 1; bucket.rSum += g.r; }
    }
  }
  for (const a of Object.values(byWallet)) {
    // Build the chronological cumulative-R series per wallet (a.rSeries).
    a.resolved.sort((x, y) => x.at - y.at);
    let run = 0;
    a.rSeries = a.resolved.map((c) => (run += c.r, Math.round(run * 100) / 100));
    a.regime = regimeBuckets(a.regimeRows);
    a.regimeEdges = {
      trend: regimeEdge(a.regime, "trend"),
      vol: regimeEdge(a.regime, "vol"),
      align: regimeEdge(a.regime, "align"),
    };
    a.plan = planSummary(a.planScored);
    a.regimeAttributed = a.regimeRows.length;
    // Expectancy-forward ranking + the conviction-calibration read.
    a.expectancy = expectancyStats(a.expRows);
    a.calibration = convictionCalibration(a.expRows);
    if (wantContrarian) {
      a.contrarianRecord = aggregateSideRecord([a._contra]);
      a.withCrowdRecord = aggregateSideRecord([a._crowd]);
      a.contrarian = contrarianEdgeScore(a.contrarianRecord, a.withCrowdRecord); // ranked score or null
    }
    delete a.resolved; delete a.regimeRows; delete a.planScored; delete a.expRows; delete a._contra; delete a._crowd; // internal only
  }
  return byWallet;
}

// Bare coin (BTC) from any thesis symbol shape — the join key for stance history.
const bareCoin = (s) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");

// Merit weight per earned tier — a standoff between two Apex callers should outrank
// two anonymous wallets. Shared by every surface that weights live stances.
const MERIT_WEIGHT = { APEX: 3, SHARP: 2, SIGNAL: 1 };

// Gather every current directional STANCE across the platform — open positions
// (agents + opted-in humans) and active (unresolved, fresh) public calls — each
// weighted by the wallet's EARNED merit tier. Extracted so the disagreement board
// (/theses/contested) and the per-symbol consensus lean (/theses/consensus) read
// the SAME universe of stances and can never drift. Symbols are returned BARE
// (BTC, not PERP_BTC_USDC) so they join the mispriced board's coin key.
// Returns { entries, byWallet } — byWallet is the graded record (reused for merit
// enrichment by the caller).
export async function gatherStanceEntries(env, { freshMs = 14 * 86400 * 1000, contrarian = false } = {}) {
  const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
  const bare = (s) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
  // contrarian is opt-in (only the contested board wants it) so the consensus poll path
  // doesn't pay the extra stance-history reads.
  const byWallet = await computeCallerStats(env, 30 * 86400, { contrarian });
  const weightOf = (w) => {
    const r = rankCaller(byWallet[w?.toLowerCase?.()] || byWallet[w] || null);
    return r ? (MERIT_WEIGHT[r.tier] || 1) : 1;
  };
  const entries = [];
  const now = Date.now();

  // 1) Open positions (agents + opted-in humans) → directional stances.
  try {
    const usersRaw = await AGENT_KV.get("agent:users");
    const users = usersRaw ? JSON.parse(usersRaw) : [];
    const states = await Promise.all(users.map(async (w) => {
      const s = await AGENT_KV.get(`agent:state:${w}`);
      return { w, p: s ? (JSON.parse(s).current_position || null) : null };
    }));
    for (const { w, p } of states) {
      if (p && !p.paper && p.symbol && p.direction) entries.push({ wallet: w, symbol: bare(p.symbol), direction: p.direction, weight: weightOf(w), source: "position" });
    }
    const humanList = await AGENT_KV.list({ prefix: "live:human:", limit: 1000 });
    const snaps = await Promise.all(humanList.keys.map(async (k) => {
      const raw = await AGENT_KV.get(k.name);
      return raw ? { wallet: k.name.slice("live:human:".length), ...JSON.parse(raw) } : null;
    }));
    for (const sn of snaps) {
      for (const p of (sn?.positions || [])) {
        if (p.symbol && p.direction) entries.push({ wallet: sn.wallet, symbol: bare(p.symbol), direction: p.direction, weight: weightOf(sn.wallet), source: "position" });
      }
    }
  } catch (e) { console.error("[stances] live positions", e.message); }

  // 2) Active (unresolved, fresh) public calls → directional stances.
  try {
    const listed = await env.LAB_STORE.list({ prefix: "lab:" });
    for (const key of listed.keys) {
      const raw = await env.LAB_STORE.get(key.name);
      if (!raw) continue;
      let data; try { data = JSON.parse(raw); } catch { continue; }
      const wallet = key.name.replace("lab:", "");
      for (const t of (data.theses || [])) {
        if (!t.isPublic || !t.symbol || !t.direction) continue;
        if (t.gradedOutcome === "WIN" || t.gradedOutcome === "LOSS") continue; // resolved → no longer a live stance
        if (t.status === "HIT_TP" || t.status === "STOPPED_OUT" || t.status === "INVALIDATED") continue;
        if ((now - (t.createdAt || 0)) > freshMs) continue; // stale
        entries.push({ wallet, symbol: bare(t.symbol), direction: t.direction, weight: weightOf(wallet), source: "thesis" });
      }
    }
  } catch (e) { console.error("[stances] active theses", e.message); }

  return { entries, byWallet };
}
