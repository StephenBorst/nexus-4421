/**
 * NexusTreasuryStack — live $NEXUS the treasury has accumulated, as % of supply.
 *
 * Tokenomics pivot (Bankr-informed, 2026-06-08): NOT burn. The treasury buys
 * $NEXUS on the lows and HOLDS it — conviction + a war chest that funds Season
 * drops. This counter makes the accumulation visible (transparency pillar).
 * Reads truth from the chain, honest at 0 until the first buy. Fail-soft.
 *
 * Cosmetic/informational. $NEXUS stays a pure community meme token — no revenue
 * share, no yield; the treasury is a separate, fee-funded mechanism.
 */

import { useEffect, useState } from "react";
import { fetchHeldStats } from "@/hooks/useNexusTier";
import { NEXUS_TREASURY_ADDRESS } from "@/components/NexusTreasury";
import { C } from "@/config/theme";

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(0);
}

export function NexusTreasuryStack({ compact = false }: { compact?: boolean }) {
  const [stats, setStats] = useState<{ held: number; pctHeld: number } | null>(null);
  const [failed, setFailed] = useState(false);

  const configured = /^0x[0-9a-fA-F]{40}$/.test(NEXUS_TREASURY_ADDRESS);

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    fetchHeldStats(NEXUS_TREASURY_ADDRESS)
      .then((s) => { if (!cancelled) setStats(s); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [configured]);

  if (!configured || failed) return null;

  const held = stats ? fmt(stats.held) : "—";
  const pct = stats ? stats.pctHeld.toFixed(4) : "—";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: compact ? 14 : 22, flexWrap: "wrap",
      padding: compact ? "8px 12px" : "12px 16px",
      background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 6,
      fontFamily: "var(--nx-font-mono)",
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: C.text.muted }}>$NEXUS in treasury</span>
        <span style={{ fontSize: compact ? 14 : 18, fontWeight: 700, color: C.text.bright }}>{held}</span>
      </div>
      <div style={{ width: 1, alignSelf: "stretch", background: C.border }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: C.text.muted }}>% of supply</span>
        <span style={{ fontSize: compact ? 14 : 18, fontWeight: 700, color: C.text.bright }}>{pct}%</span>
      </div>
    </div>
  );
}
