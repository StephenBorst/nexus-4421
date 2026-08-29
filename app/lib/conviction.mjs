// ── Conviction ranking — shared by the Scanner UI and the copilot get_conviction tool ──
// Pure: given the funding-fade board (mispriced markets), the smart-money consensus map,
// and the graded-caller consensus map, tally how many INDEPENDENT reads confirm each fade
// and rank by net agreement. Kept pure + side-effect-free so the UI and the AI tool share
// ONE source of truth (they can't drift) and it's node:test-able.
//
// A read "confirms" when its lean matches the fade direction; "against" when it opposes.
// Funding is the base (the fade setup itself). Net = confirmations beyond funding − against.

const bare = (s) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");

// The economic floor for a FADE (Grok) — a stretch on a trivial funding band (−0.66%/yr) is
// not a crowded position worth fading, so it never earns a fade badge OR a scanner rank. ONE
// literal, the file of truth: briefing.ts re-exports THIS, and the ticket + Board import it
// from there. Below the floor a market isn't a fade candidate at all.
export const FADE_FUNDING_FLOOR_PCT_YR = 10;

export function rankConviction(markets, smMap = {}, callerMap = {}, limit = 8) {
  const rows = (markets || [])
    .filter((m) => m && (m.direction === "LONG" || m.direction === "SHORT") && Math.abs(Number(m.fundingAnnualPct) || 0) >= FADE_FUNDING_FLOOR_PCT_YR)
    .map((m) => {
      const coin = bare(m.coin);
      const dir = m.direction;
      const reads = [{ label: "funding", ok: true }];
      const s = smMap[coin];
      // Carry each read's OWN side, not just whether it agrees — so a surface can show WHICH
      // way a disagreeing read leans ("✗ callers LONG"), reconciling "SHORT here / LONG there"
      // in place instead of leaving two Nexus surfaces silently contradicting each other (Grok).
      if (s && (s.side === "LONG" || s.side === "SHORT")) reads.push({ label: "smart", ok: s.side === dir, side: s.side });
      const c = callerMap[coin];
      if (c && (c.side === "LONG" || c.side === "SHORT")) reads.push({ label: "callers", ok: c.side === dir, side: c.side });
      const extra = reads.filter((r) => r.label !== "funding" && r.ok).length;
      const against = reads.filter((r) => !r.ok).length;
      // Carry the reversion hist (edgeQuality) so the scanner can DOCK its conviction the same
      // way the ticket does — a weak clock (TRAP / reverted ≤42%) can't read HIGH (Grok).
      const eq = m.edgeQuality;
      const revertedPct = eq && Number.isFinite(eq.revertedPct) ? eq.revertedPct : null;
      const histWeak = !!eq && (eq.tier === "TRAP" || (revertedPct != null && revertedPct <= 42));
      return { coin, direction: dir, fundingAnnualPct: Number(m.fundingAnnualPct) || 0, extra, against, reads, revertedPct, histWeak };
    });
  rows.sort((a, b) => (b.extra - b.against) - (a.extra - a.against) || Math.abs(b.fundingAnnualPct) - Math.abs(a.fundingAnnualPct));
  return rows.slice(0, limit);
}

// The conviction label for a ranked row (net confirmations).
export function convictionLevel(row) {
  // A weak reversion clock DOCKS conviction — aligned lenses over a losing hist can't read
  // HIGH/MODERATE (Grok: "if hist hit <40% or E[R] <0, it cannot say HIGH").
  if (row && row.histWeak) return (row.against || 0) > (row.extra || 0) ? "CONFLICTED" : "FUNDING_ONLY";
  const net = row.extra - row.against;
  if (net >= 2) return "HIGH";
  if (net === 1) return "MODERATE";
  if (row.against > row.extra) return "CONFLICTED";
  return "FUNDING_ONLY";
}
