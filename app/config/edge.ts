/**
 * Personalized "edge" readout — the makes-you-a-better-trader core.
 *
 * Turns a trader's OWN realized record into a coach's read: which symbols and
 * which direction they actually make money on, and where they bleed. This is the
 * moat feature — it's derived purely from the user's graded results, so the advice
 * is grounded in fact, not vibes. Pure + typed; the copilot (get_my_edge) reads it
 * and does the human synthesis under the causation/advice guardrails.
 */

export interface EdgeTrade {
  symbol: string;
  pnl: number;
  side?: string; // "LONG" | "SHORT" (optional — degrades gracefully)
}

export interface SymbolEdge {
  symbol: string;
  trades: number;
  wins: number;
  winRatePct: number;
  pnl: number;
  avgPnl: number;
}

export interface SideEdge {
  trades: number;
  wins: number;
  winRatePct: number;
  pnl: number;
}

export interface EdgeReadout {
  closed_trades: number;
  by_symbol: SymbolEdge[]; // ranked by avg PnL, min-sample first
  by_side: { LONG: SideEdge; SHORT: SideEdge };
  best_symbol: SymbolEdge | null;
  worst_symbol: SymbolEdge | null;
  better_side: "LONG" | "SHORT" | null;
  strengths: string[];
  weaknesses: string[];
  sample_note: string;
}

const MIN_SAMPLE = 3; // per-symbol / per-side trades before we'll make a claim
const clean = (s: string) => s.replace("PERP_", "").replace("_USDC", "");
const round = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(round(n))}`;

function emptySide(): SideEdge {
  return { trades: 0, wins: 0, winRatePct: 0, pnl: 0 };
}

/** Compute the edge readout from realized trades. Never throws; safe on []. */
export function computeEdge(trades: EdgeTrade[]): EdgeReadout | null {
  if (!Array.isArray(trades) || !trades.length) return null;

  const symMap = new Map<string, { trades: number; wins: number; pnl: number }>();
  const side = { LONG: emptySide(), SHORT: emptySide() };

  for (const t of trades) {
    const sym = clean(String(t.symbol ?? ""));
    if (!sym) continue;
    const pnl = Number(t.pnl) || 0;
    const win = pnl > 0;
    const s = symMap.get(sym) ?? { trades: 0, wins: 0, pnl: 0 };
    s.trades += 1; s.wins += win ? 1 : 0; s.pnl += pnl;
    symMap.set(sym, s);

    const dir = String(t.side ?? "").toUpperCase();
    if (dir === "LONG" || dir === "SHORT") {
      const se = side[dir];
      se.trades += 1; se.wins += win ? 1 : 0; se.pnl += pnl;
    }
  }

  const by_symbol: SymbolEdge[] = [...symMap.entries()]
    .map(([symbol, v]) => ({
      symbol,
      trades: v.trades,
      wins: v.wins,
      winRatePct: Math.round((v.wins / v.trades) * 100),
      pnl: round(v.pnl),
      avgPnl: round(v.pnl / v.trades),
    }))
    .sort((a, b) => b.avgPnl - a.avgPnl);

  const finalizeSide = (se: SideEdge): SideEdge => ({
    ...se,
    pnl: round(se.pnl),
    winRatePct: se.trades ? Math.round((se.wins / se.trades) * 100) : 0,
  });
  const by_side = { LONG: finalizeSide(side.LONG), SHORT: finalizeSide(side.SHORT) };

  // Claims only on a meaningful sample; fall back to raw totals with a caveat.
  const sampled = by_symbol.filter((s) => s.trades >= MIN_SAMPLE);
  const best_symbol = (sampled[0] ?? by_symbol[0]) ?? null;
  const worst_symbol = (sampled.length ? sampled[sampled.length - 1] : by_symbol[by_symbol.length - 1]) ?? null;

  // ⚠️ PROFITABILITY decides the stronger side — NOT hit rate. A high win rate that
  // bleeds money (small wins, big losses) is not a strength. Caught on live data:
  // SHORT 54% / −$25.60 was being labelled "stronger" over LONG 53% / +$11.89 —
  // i.e. the card was telling the trader to lean into their losing side.
  let better_side: "LONG" | "SHORT" | null = null;
  if (by_side.LONG.trades >= MIN_SAMPLE && by_side.SHORT.trades >= MIN_SAMPLE) {
    const avg = (s: SideEdge) => (s.trades ? s.pnl / s.trades : 0);
    const top = avg(by_side.LONG) >= avg(by_side.SHORT) ? "LONG" : "SHORT";
    // Only claim a strength if that side actually makes money. If both bleed,
    // neither is a strength and we say nothing rather than crown a loser.
    if (by_side[top].pnl > 0) better_side = top;
  }

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  if (best_symbol && best_symbol.avgPnl > 0) {
    strengths.push(`Strongest on ${best_symbol.symbol}: ${best_symbol.winRatePct}% win rate over ${best_symbol.trades} trades (${money(best_symbol.pnl)}).`);
  }
  if (worst_symbol && worst_symbol !== best_symbol && worst_symbol.avgPnl < 0) {
    weaknesses.push(`Bleeding on ${worst_symbol.symbol}: ${worst_symbol.winRatePct}% win rate over ${worst_symbol.trades} trades (${money(worst_symbol.pnl)}).`);
  }
  if (better_side) {
    const w = by_side[better_side];
    const l = by_side[better_side === "LONG" ? "SHORT" : "LONG"];
    // Lead with the money, not the hit rate — that's what actually decided it.
    strengths.push(`Stronger ${better_side.toLowerCase()}: ${money(w.pnl)} over ${w.trades} trades (${w.winRatePct}%) vs ${money(l.pnl)} the other way.`);
  }
  // A side that bleeds despite a decent hit rate is the most actionable leak there
  // is (it's a sizing/exit problem, not a direction problem) — call it out.
  const bleedSide: "LONG" | "SHORT" = by_side.LONG.pnl <= by_side.SHORT.pnl ? "LONG" : "SHORT";
  const bleed = by_side[bleedSide];
  if (bleed.trades >= MIN_SAMPLE && bleed.pnl < 0) {
    weaknesses.push(`Bleeding ${bleedSide.toLowerCase()}: ${money(bleed.pnl)} over ${bleed.trades} trades at a ${bleed.winRatePct}% hit rate — the losses are outsizing the wins.`);
  }

  const closed = trades.length;
  const sample_note = closed < 10
    ? `Only ${closed} closed trades — treat this as directional, not conclusive.`
    : `${closed} closed trades — a workable sample, still not destiny.`;

  return { closed_trades: closed, by_symbol, by_side, best_symbol, worst_symbol, better_side, strengths, weaknesses, sample_note };
}
