/**
 * NexusPro — the PRO upgrade / pricing surface.
 *
 * PRO users see a compact "active" confirmation; free users see the upsell with
 * the paths to PRO. Holder-unlock works today (Buy $NEXUS → hold → unlock); the
 * USDC subscribe + pay-in-$NEXUS paths show "soon" until PAYMENTS_LIVE.
 */

import { useState } from "react";
import { useSubscription } from "@/hooks/useSubscription";
import { useNexusTier, TIER_META, TIER_THRESHOLDS } from "@/hooks/useNexusTier";
import {
  PRO_FEATURES, PRO_MONTHLY_USDC, NEXUS_PAY_DISCOUNT_PCT, PRO_HOLDER_TIER,
  PAYMENTS_LIVE, nexusDiscountedPrice,
} from "@/config/subscription";
import { NexusTierBadge } from "@/components/NexusTierBadge";
import { BuyNexusButton } from "@/components/BuyNexusButton";

const card: React.CSSProperties = { background: "#0d120d", border: "1px solid #1a4a2a", borderRadius: 6, padding: 16 };
const mono = "monospace";

const DISMISS_KEY = "nexus_pro_dismissed";

export function NexusPro({ walletAddress }: { walletAddress: string | null }) {
  const { isPro, via } = useSubscription(walletAddress);
  const { tier } = useNexusTier(walletAddress);
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(DISMISS_KEY) === "1"
  );
  const holderMin = TIER_THRESHOLDS.find((t) => t.tier === PRO_HOLDER_TIER)?.min ?? 0;

  const dismiss = () => {
    if (typeof window !== "undefined") window.localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  // Dismissed (free users only — keep showing the PRO/ACTIVE badge for subscribers).
  if (dismissed && !isPro) return null;

  // Active PRO → compact confirmation.
  if (isPro) {
    return (
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: mono, fontSize: 12, fontWeight: "bold", color: "#00ff88", letterSpacing: "0.08em" }}>◆ NEXUS PRO · ACTIVE</span>
        <NexusTierBadge tier={tier} size="md" />
        <span style={{ fontFamily: mono, fontSize: 10, color: "#5a8a6a", marginLeft: "auto" }}>
          {via === "holder" ? "unlocked via $NEXUS holdings" : "subscription active"}
        </span>
      </div>
    );
  }

  return (
    <div style={{ ...card }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: mono, fontSize: 13, fontWeight: "bold", color: "#00ff88", letterSpacing: "0.1em" }}>◆ NEXUS PRO</span>
        <span style={{ fontFamily: mono, fontSize: 10, color: "#5a8a6a" }}>unlock the full terminal</span>
        <button
          onClick={dismiss}
          style={{
            marginLeft: "auto", background: "none", border: "1px solid #1a2e1a", borderRadius: 3,
            color: "#3a5a4a", fontFamily: mono, fontSize: 9, padding: "3px 10px",
            cursor: "pointer", letterSpacing: "0.05em", alignSelf: "center",
          }}
        >
          DISMISS
        </button>
      </div>

      {/* Benefits */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginBottom: 14 }}>
        {PRO_FEATURES.map((f) => (
          <div key={f.key} style={{ background: "#0a0e0a", border: "1px solid #1a2e1a", borderRadius: 4, padding: "8px 10px" }}>
            <div style={{ fontFamily: mono, fontSize: 10, color: "#00ff88", marginBottom: 2 }}>◇ {f.label}</div>
            <div style={{ fontFamily: mono, fontSize: 8, color: "#5a8a6a", lineHeight: 1.4 }}>{f.desc}</div>
          </div>
        ))}
      </div>

      {/* Paths to PRO */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        {/* Path 1 — hold (live today) */}
        <div style={{ border: "1px solid #1a4a2a", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: "#fff", fontWeight: "bold" }}>
            HOLD <span style={{ color: TIER_META[PRO_HOLDER_TIER].color }}>{TIER_META[PRO_HOLDER_TIER].glyph} {PRO_HOLDER_TIER}</span>
          </div>
          <div style={{ fontFamily: mono, fontSize: 9, color: "#5a8a6a" }}>
            Hold {holderMin.toLocaleString()} $NEXUS → PRO unlocked, free. <span style={{ color: "#00ff88" }}>Live now.</span>
          </div>
          <BuyNexusButton size="sm" />
        </div>

        {/* Path 2 — subscribe USDC */}
        <div style={{ border: "1px solid #1a2e1a", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 8, opacity: PAYMENTS_LIVE ? 1 : 0.7 }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: "#fff", fontWeight: "bold" }}>SUBSCRIBE</div>
          <div style={{ fontFamily: mono, fontSize: 9, color: "#5a8a6a" }}>
            <span style={{ color: "#fff", fontSize: 13, fontWeight: "bold" }}>${PRO_MONTHLY_USDC}</span>/mo in USDC.
            Pay in $NEXUS → <span style={{ color: "#00ff88" }}>${nexusDiscountedPrice()}/mo ({NEXUS_PAY_DISCOUNT_PCT}% off)</span>.
          </div>
          <div style={{ fontFamily: mono, fontSize: 9, color: "#3a6a4a", border: "1px solid #1a2e1a", borderRadius: 3, padding: "5px 10px", textAlign: "center" }}>
            {PAYMENTS_LIVE ? "SUBSCRIBE" : "coming soon"}
          </div>
        </div>
      </div>

      <div style={{ fontFamily: mono, fontSize: 8, color: "#2a4a3a", marginTop: 10, lineHeight: 1.4 }}>
        PRO is a software subscription. $NEXUS pays for it (consumptive use) or unlocks it by holdings (access) — no revenue share, no yield.
      </div>
    </div>
  );
}
