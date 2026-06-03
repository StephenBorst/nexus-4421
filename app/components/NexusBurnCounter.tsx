/**
 * NexusBurnCounter
 *
 * Live, on-chain view of $NEXUS provably removed from circulation (held at the
 * dead address) as a % of total supply. This is the visible end of the flywheel:
 * DEX trading fees → treasury → buy $NEXUS → burn. Reads truth from the chain,
 * so it's honest even at zero — it simply shows 0 burned until the first burn.
 *
 * Cosmetic/informational only. $NEXUS remains a pure community meme token with
 * zero built-in utility or revenue share; the treasury that funds burns is a
 * separate, fee-funded mechanism.
 */

import { useEffect, useState } from "react";
import { fetchBurnStats } from "@/hooks/useNexusTier";

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(0);
}

export function NexusBurnCounter({ compact = false }: { compact?: boolean }) {
  const [stats, setStats] = useState<{ burned: number; totalSupply: number; pctBurned: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchBurnStats()
      .then((s) => { if (!cancelled) setStats(s); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  if (failed) return null;

  const burned = stats ? fmt(stats.burned) : "—";
  const pct = stats ? stats.pctBurned.toFixed(4) : "—";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: compact ? 12 : 20,
      padding: compact ? "8px 12px" : "12px 16px",
      background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 4,
      fontFamily: "monospace",
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 8, letterSpacing: "0.12em", color: "#3a5a4a" }}>🔥 $NEXUS BURNED</span>
        <span style={{ fontSize: compact ? 14 : 18, fontWeight: "bold", color: "#ff7a45" }}>{burned}</span>
      </div>
      <div style={{ width: 1, alignSelf: "stretch", background: "#1a2e1a" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 8, letterSpacing: "0.12em", color: "#3a5a4a" }}>% OF SUPPLY</span>
        <span style={{ fontSize: compact ? 14 : 18, fontWeight: "bold", color: "#00ff88" }}>{pct}%</span>
      </div>
      {!compact && (
        <div style={{ flex: 1, minWidth: 0, fontSize: 8, color: "#2a4a3a", lineHeight: 1.4, textAlign: "right" }}>
          fees → treasury → buyback → burn
          <br />
          provable on-chain · dead address
        </div>
      )}
    </div>
  );
}
