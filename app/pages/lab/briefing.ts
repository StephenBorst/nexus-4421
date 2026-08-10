// ── THE BRIEFING — deterministic intelligence over the trader's own record ───
// The Lab's differentiator isn't another chart; it's synthesis. This module reads
// the user's REAL closed-trade record (plus the live tape + agent state) and ranks
// what actually matters right now into a short, actionable briefing — no LLM, no
// key, works for everyone, instant. The insights nobody else can compute because
// nobody else has your graded record.
//
// Pure + side-effect-free so the logic is testable and can't drift with the UI.
// Design law: green = genuinely positive (profit-adjacent), amber = caution, bone =
// neutral info. Red is reserved for realized loss elsewhere — a risk *warning* is
// amber, not red.

export type InsightTone = "positive" | "caution" | "info";

export interface Insight {
  id: string;
  priority: number;                 // higher ranks first
  tone: InsightTone;
  title: string;                    // short headline
  detail: string;                   // one supporting line
  action?: { label: string; tab?: string }; // jump target inside the Lab
  meta?: { symbol: string; direction: "LONG" | "SHORT" }; // structured setup (for the coaching loop)
}

export interface BriefingTrade {
  symbol: string;
  direction: "LONG" | "SHORT";
  pnl: number;
  timestamp: number;
}

export interface BriefingInput {
  trades: BriefingTrade[];          // closed trades, any order
  winRate: number;                  // 0-100, overall
  totalPnl: number;
  openPositions: { symbol: string; direction: "LONG" | "SHORT" }[];
  tape: { label: string; score: number } | null; // RISK-ON / NEUTRAL / RISK-OFF
  agent: { active: boolean } | null;
}

// Compute the market TAPE from the public futures rows — same formula as MarketTape
// (breadth 50% / BTC trend 40% / funding crowding 10%). Kept pure here so the
// Briefing can read the tape without mounting the strip. Returns null on no data.
export function computeTape(rows: { symbol: string; "24h_open"?: string | number; "24h_close"?: string | number; last_funding_rate?: string | number }[] | null) {
  if (!rows || !rows.length) return null;
  const pct = (o?: string | number, c?: string | number) => {
    const oo = parseFloat(String(o ?? 0)), cc = parseFloat(String(c ?? 0));
    if (!oo || !cc) return 0;
    const p = ((cc - oo) / oo) * 100;
    return Math.abs(p) > 50 ? 0 : p;
  };
  const changes = rows.map((m) => pct(m["24h_open"], m["24h_close"]));
  const breadth = Math.round((changes.filter((c) => c > 0).length / changes.length) * 100);
  const btc = rows.find((m) => m.symbol === "PERP_BTC_USDC");
  const btcChg = btc ? pct(btc["24h_open"], btc["24h_close"]) : 0;
  const fundings = rows.map((m) => parseFloat(String(m.last_funding_rate ?? 0))).filter((f) => !isNaN(f));
  const fundSkew = fundings.length ? Math.round((fundings.filter((f) => f > 0).length / fundings.length) * 100) : 50;
  const btcScore = Math.max(0, Math.min(100, 50 + btcChg * 6));
  const fundScore = 100 - Math.abs(fundSkew - 50) * 2;
  const score = Math.round(breadth * 0.5 + btcScore * 0.4 + fundScore * 0.1);
  const label = score >= 60 ? "RISK-ON" : score >= 42 ? "NEUTRAL" : "RISK-OFF";
  return { score, label };
}

const ticker = (sym: string) => sym.replace("PERP_", "").replace("_USDC", "");
const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n) >= 1000 ? `${(Math.abs(n) / 1000).toFixed(1)}K` : Math.abs(n).toFixed(2)}`;
const wrOf = (rows: BriefingTrade[]) => (rows.length ? Math.round((rows.filter((t) => t.pnl > 0).length / rows.length) * 1000) / 10 : 0);

// Net P&L by symbol → the single best and single worst market.
function bySymbol(trades: BriefingTrade[]) {
  const m = new Map<string, { net: number; n: number }>();
  for (const t of trades) {
    const k = ticker(t.symbol);
    const cur = m.get(k) || { net: 0, n: 0 };
    cur.net += t.pnl; cur.n += 1; m.set(k, cur);
  }
  const arr = [...m.entries()].filter(([, v]) => v.n >= 2);
  if (!arr.length) return null;
  arr.sort((a, b) => b[1].net - a[1].net);
  return { best: arr[0], worst: arr[arr.length - 1] };
}

// ── THE READ — the general (wallet-free) market synthesis ────────────────────
// The personal Briefing reads YOUR record; this reads THE MARKET, in the same
// voice, so the Lab feels intelligent to anyone — connected or not. Sourced from
// the public /signals (funding + OI + confluence, the agent's own rules), the
// futures tape, and live agent activity. Pure + fail-soft on missing inputs.

export interface MarketSignal {
  symbol: string;               // bare ticker (BTC, ETH…)
  funding_rate_8h: number;      // decimal (0.0001 = 0.01%)
  price_change_pct: number;     // vs ~5-min prior snapshot
  oi_change_pct: number;
  funding_signal: "LONG" | "SHORT" | "NONE";
  oi_signal: "LONG" | "SHORT" | "NONE";
  confluence: "LONG" | "SHORT" | "NONE";
  trend?: "TREND_UP" | "TREND_DOWN" | "CHOP" | null;  // 1h regime (momentum source)
  trend_move_pct?: number | null;                     // net % move over the trend window
  trend_oi_pct?: number | null;                       // ~hourly OI change (momentum confirmation)
}

// A trend needs rising open interest (new money committing) to be a real momentum setup —
// otherwise it's a squeeze/exhaustion (fakeout). >= this %/hr OI growth = confirmed.
const MOMENTUM_OI_MIN = 1;

export interface MarketReadInput {
  rows: { symbol: string; "24h_open"?: string | number; "24h_close"?: string | number }[] | null;
  signals: MarketSignal[] | null;
  liveAgents: number | null;
  tape: { label: string; score: number } | null;
}

const pctChange = (o?: string | number, c?: string | number) => {
  const oo = parseFloat(String(o ?? 0)), cc = parseFloat(String(c ?? 0));
  if (!oo || !cc) return 0;
  const p = ((cc - oo) / oo) * 100;
  return Math.abs(p) > 60 ? 0 : p; // guard bad ticks
};

export function buildMarketRead(input: MarketReadInput): Insight[] {
  const { rows, signals, liveAgents, tape } = input;
  const out: Insight[] = [];

  // 1 — Tape headline: what the whole market is doing + what it favors.
  if (tape) {
    const guide =
      tape.label === "RISK-ON" ? "Broad strength — momentum/trend setups favored; funding fades are riskier into a bid."
      : tape.label === "RISK-OFF" ? "Broad weakness — mean-reversion fades and tighter stops; don't chase longs."
      : "Rangebound tape — funding-harvest and confluence setups fit best.";
    out.push({
      id: "read-tape",
      priority: 60,
      tone: tape.label === "RISK-OFF" ? "caution" : "info",
      title: `${tape.label} tape · ${tape.score}/100`,
      detail: guide,
      action: { label: "Market Intel", tab: "intel" },
    });
  }

  // 2 — Confluence setup: the agent's highest-conviction read, surfaced for humans.
  const conf = (signals || []).find((s) => s.confluence !== "NONE");
  if (conf) {
    out.push({
      id: "read-confluence",
      priority: 78,
      tone: "info",
      title: `Confluence: ${conf.confluence} ${conf.symbol}`,
      detail: `Funding and open interest agree — the strongest setup on the board, and exactly what the autonomous agent fades. ${conf.funding_signal === conf.confluence ? "Crowd positioning is extended." : ""}`.trim(),
      action: { label: "Run the agent", tab: "agent" },
    });
  }

  // 3 — Crowded funding (fade the crowd — the core edge). Pick the most-stretched
  // market that ISN'T already shown as the confluence setup, so it's a second read.
  const byFund = [...(signals || [])].sort((a, b) => Math.abs(b.funding_rate_8h) - Math.abs(a.funding_rate_8h));
  const hot = byFund.find((s) => !conf || s.symbol !== conf.symbol);
  if (hot && Math.abs(hot.funding_rate_8h) >= 0.0004) {
    const heavy = hot.funding_rate_8h > 0 ? "long" : "short";
    out.push({
      id: "read-funding",
      priority: 68,
      tone: "info",
      title: `${hot.symbol} funding is stretched (${(hot.funding_rate_8h * 100).toFixed(3)}%/8h)`,
      detail: `The crowd is heavily ${heavy}. Overcrowded funding is where fades set up — the higher it goes, the more it's paying you to lean the other way.`,
      action: { label: "See the read", tab: "intel" },
    });
  }

  // 4 — Biggest movers across the whole board (all markets, not just majors).
  if (rows && rows.length) {
    let top = { sym: "", chg: 0 }, bot = { sym: "", chg: 0 };
    for (const r of rows) {
      const c = pctChange(r["24h_open"], r["24h_close"]);
      if (c > top.chg) top = { sym: r.symbol.replace("PERP_", "").replace("_USDC", ""), chg: c };
      if (c < bot.chg) bot = { sym: r.symbol.replace("PERP_", "").replace("_USDC", ""), chg: c };
    }
    if (top.sym && bot.sym && (Math.abs(top.chg) >= 4 || Math.abs(bot.chg) >= 4)) {
      out.push({
        id: "read-movers",
        priority: 48,
        tone: "info",
        title: `${top.sym} +${top.chg.toFixed(1)}% leads · ${bot.sym} ${bot.chg.toFixed(1)}% lags`,
        detail: "The widest 24h dispersion on the board — where the momentum and the mean-reversion both live.",
        action: { label: "Market Intel", tab: "intel" },
      });
    }
  }

  // 5 — Live agents in the market right now (ties the scene to the Arena).
  if (typeof liveAgents === "number" && liveAgents > 0) {
    out.push({
      id: "read-live-agents",
      priority: 44,
      tone: "info",
      title: `${liveAgents} autonomous ${liveAgents === 1 ? "agent is" : "agents are"} live in the market`,
      detail: "Real positions from Nexus agents right now — every entry and exit graded on-chain. Watch them work, or put yours in.",
      action: { label: "Trading Agent", tab: "agent" },
    });
  }

  // 6 — OI surge: conviction building where open interest is expanding fast.
  const byOi = [...(signals || [])].sort((a, b) => Math.abs(b.oi_change_pct) - Math.abs(a.oi_change_pct));
  const oiHot = byOi[0];
  if (oiHot && Math.abs(oiHot.oi_change_pct) >= 3 && oiHot.symbol !== conf?.symbol && oiHot.symbol !== hot?.symbol) {
    out.push({
      id: "read-oi",
      priority: 40,
      tone: "info",
      title: `Open interest is ${oiHot.oi_change_pct > 0 ? "surging" : "flushing"} on ${oiHot.symbol} (${oiHot.oi_change_pct > 0 ? "+" : ""}${oiHot.oi_change_pct.toFixed(1)}%)`,
      detail: oiHot.oi_change_pct > 0 ? "New money is committing — conviction, or a crowd building to fade." : "Positions are unwinding — a squeeze or a reset in progress.",
      action: { label: "Market Intel", tab: "intel" },
    });
  }

  return out.sort((a, b) => b.priority - a.priority);
}

// ── THE FUSION — the synthesis of syntheses ──────────────────────────────────
// Every other read is EITHER about the market (tape, funding, movers) OR about you
// (your record, your leaks). This is the intersection nobody else can compute: it
// takes the market's cleanest fade setup (crowded funding), the merit-weighted CALLER
// consensus on that symbol, and YOUR edge (which side you're actually good at + whether
// you're a proven crowd-fader) and asks the only question that matters — "is this setup
// MINE?". Aligned → your highest-conviction, personalized play. Off your edge → the
// blunt "sit it out". This is the moat: it requires the graded market, the graded crowd,
// and your graded record all at once. Pure + fail-soft on any missing input.
export interface FusionInput {
  trades: BriefingTrade[];
  signals: MarketSignal[] | null;
  consensus: Record<string, { side: "LONG" | "SHORT" | "SPLIT"; lean: number; participants: number }> | null;
  tape: { label: string; score: number } | null;
  contrarian?: { calls: number; avgR: number } | null; // the user's OWN fade record
  // The user's ALIGN edge (with-trend vs counter-trend), from the graded regime
  // attribution — the honest per-CLASS edge. A funding fade is a counter-trend play,
  // so a strong AGAINST_TREND edge means the setup is the user's kind of trade.
  alignEdge?: { best: { bucket: string; avgR: number } } | null;
}

export function buildFusion(input: FusionInput): Insight[] {
  const { trades, signals, consensus, contrarian } = input;
  const out: Insight[] = [];

  // Setup selection, by CONVICTION CLASS. A confluence read (funding AND open interest
  // agree — the agent's highest-conviction fade) wins; otherwise the most-stretched
  // funding market. The direction is the fade in both cases. This is the generalization:
  // the fusion reasons over setup CLASS, not just raw funding.
  const confl = (signals || []).find((s) => s.confluence === "LONG" || s.confluence === "SHORT");
  const byFund = [...(signals || [])].sort((a, b) => Math.abs(b.funding_rate_8h) - Math.abs(a.funding_rate_8h));
  const hot = byFund.find((s) => Math.abs(s.funding_rate_8h) >= 0.0004);
  const pick = confl || hot;
  if (!pick) return out;
  const klass: "confluence" | "funding" = confl ? "confluence" : "funding";
  const fadeDir: "LONG" | "SHORT" = klass === "confluence" ? (pick.confluence as "LONG" | "SHORT") : (pick.funding_rate_8h > 0 ? "SHORT" : "LONG");
  const heavy = fadeDir === "SHORT" ? "long" : "short";   // crowd is on the opposite side of the fade
  const sym = pick.symbol;                                // signals use bare tickers
  const fundPct = (pick.funding_rate_8h * 100).toFixed(3);
  const setupPhrase = klass === "confluence"
    ? "funding and open interest agree (the highest-conviction fade)"
    : `funding is stretched (${fundPct}%/8h)`;

  // The graded crowd's lean on this symbol (merit-weighted callers), if any.
  const lean = consensus?.[sym] || null;
  const callersAgree = !!(lean && lean.side === fadeDir);
  const callersFight = !!(lean && lean.side !== fadeDir && lean.side !== "SPLIT");
  const callerNote = callersAgree ? " The merit-weighted callers lean the same way — the setup and the people with a track record agree."
    : callersFight ? ` But the credible callers actually lean ${lean!.side} — a real disagreement, so treat it as lower-conviction.`
    : "";

  // Your edge: which side you're measurably better on (needs a real sample both sides).
  const longs = trades.filter((t) => t.direction === "LONG");
  const shorts = trades.filter((t) => t.direction === "SHORT");
  let userSide: "LONG" | "SHORT" | null = null, userWr = 0;
  if (longs.length >= 4 && shorts.length >= 4) {
    const lw = wrOf(longs), sw = wrOf(shorts);
    if (Math.abs(lw - sw) >= 12) { userSide = lw > sw ? "LONG" : "SHORT"; userWr = Math.max(lw, sw); }
  }
  const provenFader = !!(contrarian && contrarian.calls >= 3 && contrarian.avgR > 0);
  const faderNote = provenFader ? `, and your record fading the crowd is +${contrarian!.avgR}R over ${contrarian!.calls} calls` : "";
  const sideWord = (d: "LONG" | "SHORT") => (d === "LONG" ? "long" : "short");

  // Per-CLASS edge (the matrix). A funding fade is a COUNTER-TREND / mean-reversion play;
  // riding a trend is a WITH-trend / momentum play. Match the setup to the user's ALIGN
  // edge: AGAINST_TREND traders get fades, WITH_TREND traders get the trend to ride.
  const alignBest = input.alignEdge?.best?.bucket || null;
  const alignAvgR = input.alignEdge?.best?.avgR ?? 0;
  const classAgainst = alignBest === "align:AGAINST_TREND"; // mean-reversion / fader
  const classWith = alignBest === "align:WITH_TREND";       // momentum / trend-rider
  const classNote = classAgainst ? ` Counter-trend fades are your class — your align edge is +${alignAvgR}R against the trend.`
    : classWith ? " ⚠ Your record leans WITH-trend, so this counter-trend fade is off your usual style — respect the risk."
    : "";

  // The MOMENTUM setup: the strongest-trending core symbol, CONFIRMED by rising OI (new
  // money committing). A trend on thinning OI is a squeeze/exhaustion, not a setup — it
  // doesn't qualify, which is the sharpening.
  const trending = (signals || [])
    .filter((s) => (s.trend === "TREND_UP" || s.trend === "TREND_DOWN") && (s.trend_oi_pct ?? 0) >= MOMENTUM_OI_MIN)
    .sort((a, b) => Math.abs(b.trend_move_pct ?? 0) - Math.abs(a.trend_move_pct ?? 0));
  const mom = trending[0] || null;
  const momDir: "LONG" | "SHORT" | null = mom ? (mom.trend === "TREND_UP" ? "LONG" : "SHORT") : null;
  const momMove = mom?.trend_move_pct ?? 0;
  const momOi = mom?.trend_oi_pct ?? 0;

  if (mom && momDir && classWith) {
    // A momentum trader + a live, OI-confirmed trend = ride it. Leads for this user.
    out.push({
      id: "fusion-momentum",
      priority: 92,
      tone: "positive",
      title: `Your setup: ride the ${mom.symbol} trend (${sideWord(momDir)})`,
      detail: `${mom.symbol} is in a strong ${momDir === "LONG" ? "uptrend" : "downtrend"} (${momMove >= 0 ? "+" : ""}${momMove}%) and open interest is rising (+${momOi}%/hr) — new money committing, not a squeeze. Momentum is your class: your align edge is +${alignAvgR}R WITH the trend. Ride it, don't fade it.`,
      action: { label: "Structure it", tab: "thesis" },
      meta: { symbol: mom.symbol, direction: momDir },
    });
  } else if (userSide && userSide === fadeDir) {
    out.push({
      id: "fusion-your-setup",
      priority: 92,
      tone: "positive",
      title: `Your setup: fade the crowd ${sideWord(fadeDir)} on ${sym}`,
      detail: `${sym}: ${setupPhrase} — the crowd is heavily ${heavy}, so the clean fade is ${sideWord(fadeDir)}, and that's your stronger side (${userWr}% win rate)${faderNote}.${classNote}${callerNote}`,
      action: { label: "Structure it", tab: "thesis" },
      meta: { symbol: sym, direction: fadeDir },
    });
  } else if (!userSide && classAgainst) {
    // No directional edge, but the SETUP CLASS is where their edge lives.
    out.push({
      id: "fusion-your-class",
      priority: 88,
      tone: "positive",
      title: `Your kind of setup: counter-trend fade ${sideWord(fadeDir)} on ${sym}`,
      detail: `${sym}: ${setupPhrase} — the clean fade is ${sideWord(fadeDir)}, and counter-trend fades are where your edge lives (align +${alignAvgR}R against the trend)${faderNote}.${callerNote}`,
      action: { label: "Structure it", tab: "thesis" },
      meta: { symbol: sym, direction: fadeDir },
    });
  } else if (userSide && userSide !== fadeDir) {
    out.push({
      id: "fusion-not-your-side",
      priority: 84,
      tone: "caution",
      title: `${sym}'s setup is a ${sideWord(fadeDir)} fade — not your side`,
      detail: `The crowd is heavily ${heavy}, so the clean fade is ${sideWord(fadeDir)}. But your edge is ${sideWord(userSide)}-side (${userWr}%). Sit it out or size down — chasing setups off your edge is where records leak.${callerNote}`,
      action: { label: "Why", tab: "analytics" },
    });
  } else if (callersAgree) {
    out.push({
      id: "fusion-signal-crowd",
      priority: 74,
      tone: "info",
      title: `${sym}: the signal and the graded callers both say fade ${sideWord(fadeDir)}`,
      detail: `${setupPhrase} — the crowd is heavily ${heavy} — and the merit-weighted callers lean ${sideWord(fadeDir)} too, so the mechanical setup and the people with a track record agree.`,
      action: { label: "See the read", tab: "intel" },
    });
  } else if (callersFight) {
    out.push({
      id: "fusion-divergence",
      priority: 70,
      tone: "info",
      title: `${sym}: the signal and the sharp callers disagree`,
      detail: `Funding says fade ${sideWord(fadeDir)}, but the credible callers lean ${sideWord(lean!.side as "LONG" | "SHORT")}. Disagreement is where the information is — look before you commit.`,
      action: { label: "Smart money", tab: "smart" },
    });
  }

  return out.sort((a, b) => b.priority - a.priority);
}

/**
 * Build the ranked briefing. Returns [] when there's nothing honest to say
 * (e.g. no trades yet) — the caller renders nothing rather than filler.
 */
export function buildBriefing(input: BriefingInput): Insight[] {
  const { trades, winRate, totalPnl, openPositions, tape, agent } = input;
  const out: Insight[] = [];
  const sorted = [...trades].sort((a, b) => b.timestamp - a.timestamp); // newest first
  const n = sorted.length;

  // 1 — Open position fighting the tape (highest priority: it's live risk NOW).
  if (tape && openPositions.length) {
    for (const p of openPositions) {
      const fights =
        (tape.label === "RISK-OFF" && p.direction === "LONG") ||
        (tape.label === "RISK-ON" && p.direction === "SHORT");
      if (fights) {
        out.push({
          id: `conflict-${ticker(p.symbol)}`,
          priority: 95,
          tone: "caution",
          title: `Your ${p.direction} ${ticker(p.symbol)} is against a ${tape.label} tape`,
          detail: `Broad ${tape.label === "RISK-OFF" ? "weakness" : "strength"} (${tape.score}/100) — tighten the stop or size down unless your thesis is specifically a fade.`,
          action: { label: "Check the tape", tab: "smart" },
        });
      }
    }
  }

  // 2 — Recent streak (behavioral; acts on the last few closes).
  if (n >= 3) {
    const last3 = sorted.slice(0, 3);
    if (last3.every((t) => t.pnl < 0)) {
      out.push({
        id: "streak-cold",
        priority: 85,
        tone: "caution",
        title: "Three straight losses",
        detail: "Cold streaks compound when you press to get even. Size down or step away — the tape will still be here tomorrow.",
        action: { label: "Review the log", tab: "tradelog" },
      });
    } else if (n >= 4 && sorted.slice(0, 4).every((t) => t.pnl > 0)) {
      out.push({
        id: "streak-hot",
        priority: 55,
        tone: "positive",
        title: "Four wins in a row",
        detail: "You're in rhythm. Press the edge, but keep the same risk per trade — streaks end when size creeps.",
        action: { label: "See what's working", tab: "analytics" },
      });
    }
  }

  // 3 — Directional edge (needs a real sample on both sides).
  const longs = trades.filter((t) => t.direction === "LONG");
  const shorts = trades.filter((t) => t.direction === "SHORT");
  if (longs.length >= 4 && shorts.length >= 4) {
    const lw = wrOf(longs), sw = wrOf(shorts);
    if (Math.abs(lw - sw) >= 15) {
      const strong = lw > sw ? "long" : "short";
      const weak = lw > sw ? "short" : "long";
      out.push({
        id: "edge-directional",
        priority: 70,
        tone: "info",
        title: `Your edge is on the ${strong} side`,
        detail: `${lw}% win rate ${strong === "long" ? "long" : "short"} vs ${sw > lw ? sw : Math.min(lw, sw)}% ${weak}. Trade more ${strong}s; be far more selective on ${weak}s.`,
        action: { label: "Full breakdown", tab: "analytics" },
      });
    }
  }

  // 4 — Best / worst market by realized P&L.
  const sym = bySymbol(trades);
  if (sym && sym.best[0] !== sym.worst[0]) {
    const [bName, bV] = sym.best;
    const [wName, wV] = sym.worst;
    if (bV.net > 0 && wV.net < 0) {
      out.push({
        id: "market-spread",
        priority: 60,
        tone: "info",
        title: `${bName} pays you; ${wName} bleeds you`,
        detail: `${bName} ${money(bV.net)} over ${bV.n} trades — ${wName} ${money(wV.net)} over ${wV.n}. Concentrate where you have the read.`,
        action: { label: "By-market stats", tab: "analytics" },
      });
    }
  }

  // 5 — Overtrading: do you win less on your busy days?
  if (n >= 12) {
    const byDay = new Map<string, BriefingTrade[]>();
    for (const t of trades) {
      const d = new Date(t.timestamp); const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      (byDay.get(k) || byDay.set(k, []).get(k)!).push(t);
    }
    const days = [...byDay.values()];
    if (days.length >= 4) {
      const avg = trades.length / days.length;
      const busy = days.filter((d) => d.length > avg).flat();
      const calm = days.filter((d) => d.length <= avg).flat();
      if (busy.length >= 4 && calm.length >= 4) {
        const bw = wrOf(busy), cw = wrOf(calm);
        if (cw - bw >= 12) {
          out.push({
            id: "overtrading",
            priority: 65,
            tone: "caution",
            title: "You win less on high-volume days",
            detail: `${bw}% on busy days vs ${cw}% on selective days. The extra trades are costing you — fewer, better setups.`,
            action: { label: "Open the calendar", tab: "tradelog" },
          });
        }
      }
    }
  }

  // 6 — Proven record, no agent running → automate the edge.
  if (agent && !agent.active && n >= 10 && winRate >= 50 && totalPnl > 0) {
    out.push({
      id: "agent-idle",
      priority: 50,
      tone: "info",
      title: "You have a proven record and no agent running",
      detail: `${winRate.toFixed(0)}% win rate, ${money(totalPnl)} net. Hand a rules version of your edge to the agent and let it work while you don't.`,
      action: { label: "Set up the agent", tab: "agent" },
    });
  }

  // 7 — Record anchor (always something honest to say once there are trades).
  if (n >= 1) {
    out.push({
      id: "record-anchor",
      priority: 20,
      tone: totalPnl >= 0 && winRate >= 50 ? "positive" : "info",
      title: `Your record: ${n} trades · ${winRate.toFixed(0)}% · ${money(totalPnl)}`,
      detail: totalPnl >= 0
        ? "Net-positive and graded from public price — the kind of record you can actually stand behind."
        : "Underwater right now. The log below is where the fix starts — find the pattern, cut it.",
      action: { label: "Prove it / dig in", tab: "analytics" },
    });
  }

  return out.sort((a, b) => b.priority - a.priority);
}
