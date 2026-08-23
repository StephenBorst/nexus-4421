// ── Conviction ranking — shared by the Scanner UI and the copilot get_conviction tool ──
// Pure: given the funding-fade board (mispriced markets), the smart-money consensus map,
// and the graded-caller consensus map, tally how many INDEPENDENT reads confirm each fade
// and rank by net agreement. Kept pure + side-effect-free so the UI and the AI tool share
// ONE source of truth (they can't drift) and it's node:test-able.
//
// A read "confirms" when its lean matches the fade direction; "against" when it opposes.
// Funding is the base (the fade setup itself). Net = confirmations beyond funding − against.

const bare = (s) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");

export function rankConviction(markets, smMap = {}, callerMap = {}, limit = 8) {
  const rows = (markets || [])
    .filter((m) => m && (m.direction === "LONG" || m.direction === "SHORT"))
    .map((m) => {
      const coin = bare(m.coin);
      const dir = m.direction;
      const reads = [{ label: "funding", ok: true }];
      const s = smMap[coin];
      if (s && (s.side === "LONG" || s.side === "SHORT")) reads.push({ label: "smart", ok: s.side === dir });
      const c = callerMap[coin];
      if (c && (c.side === "LONG" || c.side === "SHORT")) reads.push({ label: "callers", ok: c.side === dir });
      const extra = reads.filter((r) => r.label !== "funding" && r.ok).length;
      const against = reads.filter((r) => !r.ok).length;
      return { coin, direction: dir, fundingAnnualPct: Number(m.fundingAnnualPct) || 0, extra, against, reads };
    });
  rows.sort((a, b) => (b.extra - b.against) - (a.extra - a.against) || Math.abs(b.fundingAnnualPct) - Math.abs(a.fundingAnnualPct));
  return rows.slice(0, limit);
}

// The conviction label for a ranked row (net confirmations).
export function convictionLevel(row) {
  const net = row.extra - row.against;
  if (net >= 2) return "HIGH";
  if (net === 1) return "MODERATE";
  if (row.against > row.extra) return "CONFLICTED";
  return "FUNDING_ONLY";
}
