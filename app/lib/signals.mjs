// ── Signal synthesis for the global Signals bell ─────────────────────────────
// The retention layer: merge the PUBLIC market + graded-crowd + tracked-wallet sources
// into one ranked feed of "reasons to come back to the Lab". Every signal carries a
// STABLE id so the bell can mark it seen and badge only genuinely NEW ones — a fade
// setup that persists across polls shouldn't keep re-buzzing. Pure + tested; the bell
// is just I/O + storage around this.

const sideWord = (d) => (d === "LONG" ? "long" : "short");
const shortAddr = (w) => `${String(w).slice(0, 6)}…${String(w).slice(-4)}`;
// A momentum setup needs rising OI (>= this %/hr) — new money, not a squeeze.
const MOMENTUM_OI_MIN = 1;
// Funding at/above this (per 8h) on the trend's side = crowd already max-positioned → late ride.
const CROWDED_FUNDING = 0.0004;

export function buildSignals({ signals, consensus, xrayEvents } = {}) {
  const out = [];
  const now = Date.now();

  // 1 — Fade setups: the most-stretched funding markets, enriched with the graded crowd.
  const funded = [...(signals || [])]
    .filter((s) => s && Math.abs(Number(s.funding_rate_8h)) >= 0.0004)
    .sort((a, b) => Math.abs(Number(b.funding_rate_8h)) - Math.abs(Number(a.funding_rate_8h)))
    .slice(0, 4);
  for (const s of funded) {
    const f = Number(s.funding_rate_8h);
    const fadeDir = f > 0 ? "SHORT" : "LONG";
    const crowdSide = f > 0 ? "LONG" : "SHORT";
    const lean = consensus?.[s.symbol] || null;
    const agree = !!(lean && lean.side === fadeDir);
    const fight = !!(lean && lean.side !== fadeDir && lean.side !== "SPLIT");
    const fundPct = (f * 100).toFixed(3);
    if (agree) {
      out.push({ id: `fade-align-${s.symbol}-${fadeDir}`, kind: "FADE_ALIGN", priority: 90, ts: now, tab: "intel",
        title: `${s.symbol}: fade ${sideWord(fadeDir)} — signal + callers agree`,
        detail: `Funding stretched ${fundPct}%/8h and the graded callers lean the same way — the mechanical setup and the people with a track record agree.` });
    } else if (fight) {
      out.push({ id: `fade-div-${s.symbol}`, kind: "DIVERGENCE", priority: 74, ts: now, tab: "smart",
        title: `${s.symbol}: signal vs the sharp callers disagree`,
        detail: `Funding says fade ${sideWord(fadeDir)}; the credible callers lean ${sideWord(lean.side)}. Disagreement is where the information is.` });
    } else {
      out.push({ id: `fund-${s.symbol}-${fadeDir}`, kind: "FUNDING", priority: 60, ts: now, tab: "intel",
        title: `${s.symbol} funding stretched ${fundPct}%/8h`,
        detail: `The crowd is heavily ${sideWord(crowdSide)} — an overcrowded ${sideWord(crowdSide)} is where a ${sideWord(fadeDir)} fade sets up.` });
    }
  }

  // 2 — Momentum: the strongest-trending core symbol, CONFIRMED by rising OI (new money
  // committing — not a squeeze). classifyRegime trend + a real OI rise; a with-trend read.
  const trending = (signals || [])
    .filter((s) => s && (s.trend === "TREND_UP" || s.trend === "TREND_DOWN") && (Number(s.trend_oi_pct) || 0) >= MOMENTUM_OI_MIN)
    .sort((a, b) => Math.abs(Number(b.trend_move_pct) || 0) - Math.abs(Number(a.trend_move_pct) || 0));
  const mom = trending[0];
  if (mom) {
    const dir = mom.trend === "TREND_UP" ? "LONG" : "SHORT";
    const move = Number(mom.trend_move_pct) || 0;
    const oi = Number(mom.trend_oi_pct) || 0;
    const fund = Number(mom.funding_rate_8h) || 0;
    const extended = (dir === "LONG" && fund >= CROWDED_FUNDING) || (dir === "SHORT" && fund <= -CROWDED_FUNDING);
    const fundNote = extended
      ? ` Funding is already crowded ${sideWord(dir)} (${(fund * 100).toFixed(3)}%/8h) — a LATE ride, tighten the stop.`
      : " Funding isn't crowded yet — room to run.";
    // LEVELS — the 4H EMA8 traders actually retest to (the read a sharp friend gives you).
    // "At the EMA8" after a trend = the first-retest continuation zone; else name the level to watch.
    const ema8 = Number(mom.ema8_4h) || null;
    const mark = Number(mom.mark_price) || null;
    let levelNote = "";
    if (ema8 && mark) {
      const fmt = (v) => v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(2) : v.toPrecision(4);
      const distPct = ((mark - ema8) / ema8) * 100;
      const withTrend = (dir === "LONG" && distPct >= 0) || (dir === "SHORT" && distPct <= 0);
      if (Math.abs(distPct) <= 0.9)
        levelNote = ` It just pulled back to its 4H EMA8 ($${fmt(ema8)}) — the first retest of the trend, where continuation entries set up.`;
      else if (withTrend)
        levelNote = ` Holding ${dir === "LONG" ? "above" : "below"} its 4H EMA8 ($${fmt(ema8)}); a pullback to that level is the lower-risk entry.`;
      else
        levelNote = ` Now on the far side of its 4H EMA8 ($${fmt(ema8)}) — the trend is stretched; wait for it to reclaim the level.`;
    }
    out.push({ id: `mom-${mom.symbol}-${dir}`, kind: "MOMENTUM", priority: extended ? 66 : 72, ts: now, tab: "intel",
      title: `${mom.symbol} is trending — ${sideWord(dir)} momentum${extended ? " (late)" : ""}`,
      detail: `${mom.symbol} is in a strong ${dir === "LONG" ? "uptrend" : "downtrend"} (${move >= 0 ? "+" : ""}${move}%) with open interest rising (+${oi}%/hr) — new money committing, a with-trend read.${levelNote}${fundNote}` });
  }

  // 3 — Tracked-wallet tier crossings (a watched wallet earned/lost a consistency tier).
  for (const e of (xrayEvents || []).slice(0, 6)) {
    if (!e || !e.wallet) continue;
    const up = e.kind === "TIER_UP";
    const day = Math.floor((Number(e.ts) || now) / 86400000); // stable per calendar day
    out.push({ id: `tier-${String(e.wallet).toLowerCase()}-${e.toTier || "none"}-${day}`, kind: "TIER", priority: up ? 66 : 50, ts: Number(e.ts) || now, tab: "smart",
      title: `${shortAddr(e.wallet)} ${up ? "earned" : "dropped to"} ${e.toTier || "no tier"}`,
      detail: up ? "A tracked wallet just crossed into a higher consistency tier — its record is strengthening." : "A tracked wallet slipped below its tier — worth a look before you copy." });
  }

  return out.sort((a, b) => b.priority - a.priority || b.ts - a.ts).slice(0, 8);
}

// How many of the current signals are NEW (id not in the seen set). Pure so the badge
// count is testable and identical to what the panel renders.
export function countUnseen(list, seen) {
  const s = seen instanceof Set ? seen : new Set(Object.keys(seen || {}));
  return (list || []).reduce((n, sig) => n + (sig && !s.has(sig.id) ? 1 : 0), 0);
}
