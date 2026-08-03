// ── Theses routes (the trustless human-call surface) ──
// The public caller leaderboard, the per-wallet PROCESS x-ray (regime edge, plan
// quality, expectancy, calibration), the CONTESTED disagreement board, the live
// pre-post advisor, the community postmortem leak report, and the verifiable call
// ledger.
//
// Second family out of index.js (migration rules in shared.mjs). Read-only public
// data throughout — every number here is recomputable by anyone from public price,
// which is the whole point of the surface — so nothing here can move funds.
//
// Grading helpers live in grading.mjs rather than here: they're shared with the OG
// card routes, Desks scoring and the hourly cron.
//
// ⚠️ Pure move — logic byte-identical to what shipped.
//
// Contract: returns a Response when it owns the path, else null so index.js's
// remaining routes get their turn.
import { json } from "./shared.mjs";
import {
  rankCaller, callerScore, contestedBoard, consensusBySymbol, classifyRegime, callAlignment,
  planQuality, normalizeSymbol, REGIME, postmortemSummary, isLossReason, LOSS_REASONS,
  estimateResolution,
} from "./logic.mjs";
import { computeCallerStats, gatherStanceEntries, REGIME_PAD_S, ADVICE_FLAG_TEXT } from "./grading.mjs";

export async function handleTheses(parts, request, env) {
  if (parts[0] !== "theses") return null;

  // ── /theses/leaderboard — TRUSTLESS human call ranking ──
  // A thesis is a *call*. Whether it hit TP1 or SL first is a fact about PUBLIC
  // price (Orderly /tv/history), NOT the trader's self-report. We grade every
  // public call against that public data and rank traders on objective call
  // accuracy + R-multiple. No personal-account access, no "trust me".
  if (parts[0] === "theses" && parts[1] === "leaderboard") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);

    const MIN_CALLS = 5, TOP_N = 25, MAX_HORIZON_S = 30 * 86400;

    // First-touch grade per wallet (shared helper — same source as Desk scoring).
    const byWallet = await computeCallerStats(env, MAX_HORIZON_S);

    const eligible = [];
    for (const [wallet, a] of Object.entries(byWallet)) {
      if (a.calls < MIN_CALLS) continue;
      const hitRate = a.wins / a.calls;
      const avgR = a.rSum / a.calls;
      if (avgR <= 0) continue; // top board = traders net-positive by R
      // ⭐ Ranked on EXPECTANCY, not hit rate. The old score was 0.5·hitRate +
      // 0.5·rScore, which ranked a scalper booking +0.2R fifteen times above a
      // trader who's 40% hit-rate with a fat right tail — i.e. it ranked the wrong
      // thing. callerScore weights shrunk expectancy + profit factor and drops hit
      // rate from the formula entirely (it stays a DISPLAYED stat below). avgR ==
      // expectancy, so the net-positive gate above is unchanged.
      const score = callerScore({ ...a.expectancy, calls: a.calls });
      eligible.push({
        wallet, calls: a.calls,
        hitRate: Math.round(hitRate * 1000) / 10,
        avgR: Math.round(avgR * 100) / 100,
        totalR: Math.round(a.rSum * 100) / 100,
        score,
        expectancy: a.expectancy,   // { expectancy, profitFactor, tailRatio, avgWinR, avgLossR }
        calibration: a.calibration, // { calibrated, inverted, gap, ... } or null
        meritRank: rankCaller(a), // earned identity rank (SIGNAL/SHARP/APEX) or null
        rSeries: a.rSeries || [],  // cumulative-R equity curve (chronological)
        // PROCESS, alongside the outcome — the publicly-verifiable half of "was this
        // a disciplined operator or a lucky gunslinger": were the calls well-formed
        // when posted? Reported next to the score, not folded into it.
        discipline: a.plan ? { score: a.plan.score, scored: a.plan.scored, topFlag: a.plan.topFlag } : null,
        // "Where does this trader's edge live" — the single strongest cut.
        regimeEdge: a.regimeEdges?.trend || a.regimeEdges?.align || null,
      });
    }
    // Tie-break on profit factor then sample — reward the sturdier record, not the
    // luckier one, when scores round equal.
    eligible.sort((x, y) => y.score - x.score || (y.expectancy?.profitFactor ?? 0) - (x.expectancy?.profitFactor ?? 0) || y.calls - x.calls);
    const top = eligible.slice(0, TOP_N);

    const enriched = await Promise.all(top.map(async (e, i) => {
      const profileRaw = await env.LAB_STORE.get(`profile:${e.wallet}`);
      const p = profileRaw ? JSON.parse(profileRaw) : {};
      return { rank: i + 1, displayName: p.displayName || null, pfp: p.pfp || null, ...e };
    }));

    // Emerging callers — 1..MIN_CALLS-1 resolved calls (not yet ranked). Surfaced
    // so contribution is visible immediately at cold-start instead of an empty
    // board, and shows each author how many more resolved calls to qualify.
    const emerging = [];
    for (const [wallet, a] of Object.entries(byWallet)) {
      if (a.calls >= MIN_CALLS || a.calls < 1) continue;
      emerging.push({
        wallet, calls: a.calls,
        hitRate: Math.round((a.wins / a.calls) * 1000) / 10,
        avgR: Math.round((a.rSum / a.calls) * 100) / 100,
        totalR: Math.round(a.rSum * 100) / 100,
        callsToQualify: MIN_CALLS - a.calls,
      });
    }
    emerging.sort((x, y) => y.calls - x.calls || y.avgR - x.avgR);
    const emergingEnriched = await Promise.all(emerging.slice(0, 15).map(async (e) => {
      const profileRaw = await env.LAB_STORE.get(`profile:${e.wallet}`);
      const p = profileRaw ? JSON.parse(profileRaw) : {};
      return { displayName: p.displayName || null, pfp: p.pfp || null, ...e };
    }));

    return json({
      leaderboard: enriched,
      emerging: emergingEnriched,
      criteria: {
        minCalls: MIN_CALLS,
        grading: "Objective first-touch vs public Orderly OHLC (/tv/history, 1h). TP1-first = WIN (+planned R), SL-first = LOSS (-1R), same-candle = LOSS (conservative). PENDING excluded. Anyone can recompute.",
        discipline: "Plan quality at post time, from the same public candles: LATE_ENTRY (the move had already run >0.5R before the call went up, so the stated entry was never obtainable), STOP_IN_NOISE (<0.5 ATR), STOP_TOO_WIDE (>6 ATR), RR_MISMATCH (claimed R disagrees with the posted levels), BAD_LEVELS. Reported, not ranked on.",
        regime: "Each graded call is attributed to the market it was posted INTO, classified from the 48 candles BEFORE it (efficiency ratio → TREND_UP/TREND_DOWN/CHOP; ATR vs the symbol's own baseline → CALM/NORMAL/VOLATILE). Never reads post-call bars, so no outcome leaks into the label.",
      },
    }, request);
  }

  // ── /theses/process/:wallet — the PROCESS x-ray for one caller ──
  // The leaderboard says whether someone was right. This says HOW, and it's the
  // one readout that can change behavior: which regime their edge actually lives
  // in, and which recurring plan defect is costing them. Public + recomputable
  // (same candles as the grade), so no auth — it exposes nothing private.
  if (parts[0] === "theses" && parts[1] === "process" && parts[2]) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    const wallet = parts[2].toLowerCase();
    const byWallet = await computeCallerStats(env, 30 * 86400, { onlyWallet: wallet });
    const a = Object.values(byWallet)[0];
    if (!a || !a.calls) {
      return json({ wallet, calls: 0, regime: {}, regimeEdges: {}, discipline: null, note: "no resolved public calls yet" }, request);
    }
    return json({
      wallet,
      calls: a.calls,
      hitRate: Math.round((a.wins / a.calls) * 1000) / 10,
      avgR: Math.round((a.rSum / a.calls) * 100) / 100,
      totalR: Math.round(a.rSum * 100) / 100,
      meritRank: rankCaller(a),
      // Expectancy view: what an average call is WORTH + whether the wins carry
      // the losses + how concentrated the record is in a few fat tails.
      expectancy: a.expectancy,
      // Conviction calibration: when they bet bigger, were they more right?
      calibration: a.calibration,
      // How many calls had enough prior history to classify (< calls near the
      // horizon edge). Stated so a thin breakdown reads as thin, not as fact.
      attributed: a.regimeAttributed,
      regime: a.regime,
      regimeEdges: a.regimeEdges,
      discipline: a.plan,
      criteria: {
        lookbackCandles: REGIME.LOOKBACK,
        minBucketSample: 5,
        note: "Regime is read from the candles BEFORE each call (no hindsight). A best/worst verdict is withheld until both regimes have 5+ calls and the avg-R gap is ≥0.4R — a confident insight drawn from 3 calls is worse than silence.",
      },
    }, request);
  }

  // ── /theses/contested — the DISAGREEMENT board ──
  // Consensus is worthless; the signal is where credible callers are OPPOSED right
  // now. Combines two things we already publish — currently-open positions and
  // active (unresolved) public calls — into per-symbol standoffs, weighted by each
  // participant's EARNED merit tier so a sharp-vs-sharp fight outranks noise. Pure
  // public read; the weighting is the same graded record the leaderboard uses.
  if (parts[0] === "theses" && parts[1] === "contested") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    // Shared stance universe (open positions + active calls, merit-weighted) — the
    // SAME source the consensus lean reads, so the two boards can never disagree.
    const { entries, byWallet } = await gatherStanceEntries(env);

    const board = contestedBoard(entries).slice(0, 12);

    // Enrich participants with profile identity (bounded — only the returned board).
    const profileCache = new Map();
    const profile = async (w) => {
      const k = w.toLowerCase();
      if (profileCache.has(k)) return profileCache.get(k);
      const raw = await env.LAB_STORE.get(`profile:${w}`);
      const p = raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};
      const merit = rankCaller(byWallet[k] || byWallet[w] || null);
      const out = { wallet: w, displayName: p.displayName || null, pfp: p.pfp || null, meritRank: merit };
      profileCache.set(k, out);
      return out;
    };
    const enriched = await Promise.all(board.map(async (row) => ({
      ...row,
      longs: await Promise.all(row.longs.map(async (l) => ({ ...await profile(l.wallet), weight: l.weight, sources: l.sources }))),
      shorts: await Promise.all(row.shorts.map(async (s) => ({ ...await profile(s.wallet), weight: s.weight, sources: s.sources }))),
    })));

    return json({
      count: enriched.length,
      contested: enriched,
      criteria: {
        note: "Symbols where credible callers hold OPPOSING directions right now, from open positions + active (unresolved, <14d) public calls. Ranked by tension = weight balance × total weight; participants weighted by earned merit tier (Apex 3 / Sharp 2 / Signal 1). A wallet on both sides of a symbol is voided there.",
      },
    }, request);
  }

  // ── /theses/consensus — merit-weighted caller LEAN per symbol ──
  // The companion to the mispriced board: where do the graded, credible callers lean
  // right now? Same weighted stance universe as /theses/contested, collapsed to ONE
  // lean per symbol (not only the contested ones) so the Lab can show the funding-edge
  // direction beside the human read — agreement, or the interesting divergence.
  // Pure public read, recomputable from public price.
  if (parts[0] === "theses" && parts[1] === "consensus") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    const { entries } = await gatherStanceEntries(env);
    return json({
      consensus: consensusBySymbol(entries),
      participants: entries.length,
      criteria: {
        note: "Per-symbol lean from open positions + active (unresolved, <14d) public calls, each weighted by the wallet's earned merit tier (Apex 3 / Sharp 2 / Signal 1). lean = (longWeight − shortWeight) / total, in [−1,1]; |lean| < 0.15 = SPLIT. A wallet on both sides of a symbol is voided there.",
      },
    }, request);
  }

  // ── /theses/proof-of-edge — resolved calls as case studies ──
  // Borrowed framing (Quotient's "Proof of Edge"): trace RESOLVED public calls through
  // the thesis → the levels → the first-touch outcome, all in the public record. Ranked
  // by graded R so the strongest calls lead, but sat on the honest aggregate (total
  // resolved / hit-rate / avg-R) so it reads as a track record, not a highlight reel.
  if (parts[0] === "theses" && parts[1] === "proof-of-edge") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    const TOP_N = 15;
    const listed = await env.LAB_STORE.list({ prefix: "lab:" });
    const resolved = [];
    let wins = 0, rSum = 0;
    for (const key of listed.keys) {
      const raw = await env.LAB_STORE.get(key.name);
      if (!raw) continue;
      let data; try { data = JSON.parse(raw); } catch { continue; }
      const wallet = key.name.replace("lab:", "");
      for (const t of (data.theses || [])) {
        if (!t.isPublic || !t.symbol) continue;
        if (t.gradedOutcome !== "WIN" && t.gradedOutcome !== "LOSS") continue;
        if (t.holdersOnly) continue; // holders-only calls stay out of the public record
        if (t.gradedOutcome === "WIN") wins++;
        rSum += Number(t.gradedR) || 0;
        resolved.push({ wallet, t });
      }
    }
    // Best calls lead (graded R), ties broken by recency.
    resolved.sort((a, b) => (Number(b.t.gradedR) || 0) - (Number(a.t.gradedR) || 0) || (b.t.gradedAt || 0) - (a.t.gradedAt || 0));
    const cards = await Promise.all(resolved.slice(0, TOP_N).map(async ({ wallet, t }) => {
      const profileRaw = await env.LAB_STORE.get(`profile:${wallet}`);
      const p = profileRaw ? (() => { try { return JSON.parse(profileRaw); } catch { return {}; } })() : {};
      const coin = String(t.symbol).toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
      return {
        wallet, displayName: p.displayName || null, pfp: p.pfp || null,
        id: t.id, symbol: t.symbol, coin, direction: t.direction,
        entryPrice: t.entryPrice, stopLoss: t.stopLoss, takeProfit1: t.takeProfit1,
        outcome: t.gradedOutcome, r: Math.round((Number(t.gradedR) || 0) * 100) / 100,
        createdAt: t.createdAt || null, gradedAt: t.gradedAt || null,
        thesis: t.notes || null, catalyst: t.catalyst || null, targetWindow: t.targetWindow || null,
        regimeTrend: t.regimeTrend || null, planScore: t.planScore ?? null,
      };
    }));
    const total = resolved.length;
    return json({
      cards,
      summary: {
        resolved: total, wins,
        hitRate: total ? Math.round((wins / total) * 1000) / 10 : 0,
        avgR: total ? Math.round((rSum / total) * 100) / 100 : 0,
      },
      criteria: {
        note: "Resolved PUBLIC calls, graded by first-touch of target vs. stop against public Orderly 1h price (same grade as the caller leaderboard). Ranked by graded R. The summary is the honest aggregate over every resolved public call, not just the cards shown.",
      },
    }, request);
  }

  // ── POST /theses/advice — JUST-IN-TIME intelligence, at the decision ──
  // Every other readout in the Lab is retrospective: you visit a tab AFTER the fact.
  // That's a dashboard. A coach speaks at the moment of the decision — so this
  // answers, for a call you are ABOUT to post: what market is this symbol in right
  // now, what is YOUR graded record in that market, and is this plan well-formed?
  //
  // Deliberately server-side: classifyRegime and planQuality already live here, and
  // the preview must run the EXACT function that will grade the call later —
  // duplicating either into the client would let the warning and the eventual grade
  // drift apart, which is worse than no warning. Public data only, no auth needed.
  if (parts[0] === "theses" && parts[1] === "advice") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, request, 405);
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, request, 400); }
    const { wallet, symbol, direction, entryPrice, stopLoss, takeProfit1, riskReward } = body || {};
    const sym = normalizeSymbol(symbol);
    if (!sym) return json({ error: "invalid symbol" }, request, 400);

    const now = Math.floor(Date.now() / 1000);
    const from = now - (REGIME.LOOKBACK + 8) * 3600;
    let cd = null;
    try {
      const r = await fetch(`https://api-evm.orderly.org/tv/history?symbol=${sym}&resolution=60&from=${from}&to=${now}`);
      const d = await r.json();
      if (d?.s === "ok" && Array.isArray(d.t)) cd = { t: d.t, h: d.h, l: d.l, c: d.c };
    } catch (e) { console.error("[advice] history", e.message); }

    const regime = cd ? classifyRegime(cd, now) : null;
    // ⚠️ Only claim an alignment when a direction was actually supplied. Quick Trade
    // asks BEFORE the trader picks a side, and callAlignment() on an undefined
    // direction would silently resolve to "AGAINST_TREND" — a confident, invented
    // warning. No direction → no alignment; the trend bucket still applies.
    const dirUp = String(direction || "").toUpperCase();
    const alignment = (regime && (dirUp === "LONG" || dirUp === "SHORT")) ? callAlignment(dirUp, regime) : null;

    // Plan quality on the DRAFT — the same scorer that will judge it once posted,
    // so a trader can fix a stop-in-noise before it costs them, not after.
    const draft = { direction, entryPrice: Number(entryPrice), stopLoss: Number(stopLoss), takeProfit1: Number(takeProfit1), riskReward: Number(riskReward), createdAt: Date.now() };
    const plan = (draft.entryPrice && draft.stopLoss && draft.takeProfit1) ? planQuality(draft, cd) : null;

    // "When will I know?" — a call grades on FIRST TOUCH, so this has a real answer,
    // and nobody asks it until they have already been waiting three days. Uses the ATR
    // the regime classifier just computed; no extra fetch.
    const eta = regime?.atrPct ? estimateResolution(draft, regime.atrPct) : null;

    // The trader's own graded record in THIS market — the line that changes minds.
    let yourRecord = null;
    if (wallet && regime) {
      try {
        const stats = await computeCallerStats(env, 30 * 86400, { onlyWallet: String(wallet).toLowerCase() });
        const a = Object.values(stats)[0];
        if (a?.regime) {
          const pick = (b) => (a.regime[b]?.calls >= 3 ? a.regime[b] : null); // no claim under 3
          yourRecord = {
            trend: pick(`trend:${regime.trend}`),
            vol: pick(`vol:${regime.vol}`),
            align: alignment ? pick(`align:${alignment}`) : null,
            calls: a.calls,
          };
        }
      } catch (e) { console.error("[advice] caller stats", e.message); }
    }

    // Warnings, most severe first. Only emitted when the evidence clears its gate —
    // a confident nudge built on 2 calls would train the wrong behavior.
    const warnings = [];
    const worst = [yourRecord?.trend, yourRecord?.align, yourRecord?.vol]
      .filter((b) => b && b.avgR < 0)
      .sort((x, y) => x.avgR - y.avgR)[0];
    if (worst) {
      warnings.push({
        severity: "high", kind: "REGIME_MISMATCH",
        text: `Your record in this market is ${worst.avgR}R over ${worst.calls} calls.`,
      });
    }
    for (const f of (plan?.flags || [])) {
      warnings.push({ severity: f === "BAD_LEVELS" ? "high" : "medium", kind: f, text: ADVICE_FLAG_TEXT[f] || f });
    }

    return json({
      symbol: sym, regime, alignment, yourRecord, plan, warnings, eta,
      note: "Scored by the same functions that will grade this call once posted.",
    }, request);
  }

  // ── /theses/postmortems — the community's shared leak report ──
  // One trader's honesty about WHY a trade lost is useful to them; the aggregate is
  // useful to everyone, and it's culture-setting (it makes admitting a process
  // error normal). Fixed taxonomy → it actually aggregates.
  // ⚠️ ANONYMOUS BY CONSTRUCTION: reasons are tallied across all wallets and the
  // wallet is never attached to a reason in the response. Self-reported, so this
  // never feeds the trustless leaderboard — it's a mirror, not a ranking.
  if (parts[0] === "theses" && parts[1] === "postmortems") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    const WINDOW_MS = 30 * 86400 * 1000;
    const since = Date.now() - WINDOW_MS;
    const reasons = [];
    let contributors = 0;
    try {
      const listed = await env.LAB_STORE.list({ prefix: "lab:" });
      for (const key of listed.keys) {
        const raw = await env.LAB_STORE.get(key.name);
        if (!raw) continue;
        let data; try { data = JSON.parse(raw); } catch { continue; }
        let anyFromWallet = 0;
        for (const t of (data.theses || [])) {
          if (!t || !isLossReason(t.lossReason)) continue;
          if ((t.createdAt || 0) < since) continue;
          reasons.push(t.lossReason);
          anyFromWallet++;
        }
        if (anyFromWallet) contributors++;
      }
    } catch (e) { console.error("[postmortems]", e.message); }

    const summary = postmortemSummary(reasons);
    return json({
      windowDays: 30,
      contributors,
      taxonomy: LOSS_REASONS,
      summary, // { tagged, counts, top } or null until the habit exists
      criteria: {
        note: "Self-reported reasons on losing calls, from a fixed taxonomy, tallied anonymously across all wallets over 30 days. Never attached to a wallet, never part of any ranking — grading stays objective and price-based.",
      },
    }, request);
  }

  // ── /theses/ledger — verifiable canonical hash of the public CALL ledger ──
  // Proof-of-call: the prediction fields + creation time, hashable by anyone.
  // (Outcomes are graded separately from public price — see /theses/leaderboard.)
  if (parts[0] === "theses" && parts[1] === "ledger") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    const ANCHOR_KV = env.NEXUS_AGENT || env.LAB_STORE;
    const sha256Hex = async (s) => {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };

    if (parts[2] === "chain") {
      const chainRaw = await env.LAB_STORE.get("theses:ledger:chain");
      const chain = chainRaw ? JSON.parse(chainRaw) : [];
      return json({ chain, length: chain.length, note: "Append-only prev-linked SHA-256 checkpoints of the public call ledger." }, request);
    }

    const listed = await env.LAB_STORE.list({ prefix: "lab:" });
    const recs = [];
    for (const key of listed.keys) {
      const raw = await env.LAB_STORE.get(key.name);
      if (!raw) continue;
      const data = JSON.parse(raw);
      const wallet = key.name.replace("lab:", "");
      for (const t of (data.theses || [])) {
        if (t.isPublic && t.symbol && t.createdAt) {
          recs.push({
            wallet, id: t.id, symbol: t.symbol, direction: t.direction,
            entryPrice: t.entryPrice, stopLoss: t.stopLoss, takeProfit1: t.takeProfit1,
            riskReward: t.riskReward, createdAt: t.createdAt,
          });
        }
      }
    }
    // Deterministic order so anyone recomputes the identical hash.
    recs.sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : (a.createdAt - b.createdAt) || (String(a.id) < String(b.id) ? -1 : 1)));
    const F = ["wallet", "id", "symbol", "direction", "entryPrice", "stopLoss", "takeProfit1", "riskReward", "createdAt"];
    const canonical = JSON.stringify(recs.map((r) => F.map((f) => r[f] ?? null)));
    const ledgerHash = await sha256Hex(canonical);

    try {
      const chainRaw = await env.LAB_STORE.get("theses:ledger:chain");
      const chain = chainRaw ? JSON.parse(chainRaw) : [];
      const last = chain[chain.length - 1];
      if (!last || last.ledgerHash !== ledgerHash) {
        const prevHash = last ? last.ledgerHash : "0".repeat(64);
        const linkHash = await sha256Hex(`${prevHash}:${ledgerHash}:${recs.length}`);
        chain.push({ ts: Date.now(), ledgerHash, prevHash, linkHash, count: recs.length });
        if (chain.length > 500) chain.shift();
        await env.LAB_STORE.put("theses:ledger:chain", JSON.stringify(chain));
      }
    } catch (e) { console.error("[theses-ledger] chain", e.message); }

    let onChain = null;
    try {
      const ocRaw = await ANCHOR_KV.get("theses:ledger:onchain");
      if (ocRaw) {
        const oc = JSON.parse(ocRaw);
        onChain = { ...oc, verified: (oc.root || "").toLowerCase() === `0x${ledgerHash}`.toLowerCase() };
      }
    } catch { /* anchor not set up yet */ }

    return json({
      ledgerHash, algorithm: "sha256",
      canonicalForm: "JSON array; each row = [" + F.join(", ") + "]; sorted by wallet, createdAt, id",
      count: recs.length, generatedAt: Date.now(), onChain, records: recs,
    }, request);
  }


  return null; // a /theses/* path we don't serve → fall through
}
