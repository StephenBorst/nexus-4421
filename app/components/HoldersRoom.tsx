/**
 * HoldersRoom — $NEXUS holders-only Thesis room (Lab tab).
 *
 * Access perk: theses authored by $NEXUS holders, visible only to holders.
 * Non-holders see a locked teaser explaining how to enter. Pure access/status —
 * no financial right, no promise; $NEXUS stays a pure community meme token.
 *
 * Gate = the connected wallet's tier (useNexusTier). Content = public theses
 * filtered to authors who are themselves holders (alpha-adjacency).
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useNexusTier,
  TIER_META,
  TIER_THRESHOLDS,
} from "@/hooks/useNexusTier";
import { NexusTierBadge } from "@/components/NexusTierBadge";
import { NexusBurnCounter } from "@/components/NexusBurnCounter";

const API_BASE = "https://og.nexustradinglabs.com";

type FeedThesis = {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  riskReward: number;
  status: string;
  createdAt: number;
  wallet: string;
  displayName: string | null;
  notes: string;
};

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: "#4a9fff", HIT_TP: "#00ff88", STOPPED_OUT: "#ff4444",
  INVALIDATED: "#fbbf24", CLOSED: "#8aaa9a",
};

function LockScreen() {
  const minOperator = TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1].min;
  return (
    <div style={{ textAlign: "center", padding: "48px 20px", maxWidth: 480, margin: "0 auto" }}>
      <div style={{ fontSize: 28, marginBottom: 12 }}>🔒</div>
      <div style={{ fontFamily: "monospace", fontSize: 14, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 10 }}>
        HOLDERS ROOM — LOCKED
      </div>
      <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5a8a6a", lineHeight: 1.7, marginBottom: 18 }}>
        A private room for $NEXUS holders. Theses from holders, for holders.
        <br />
        Hold at least <b style={{ color: "#fff" }}>{minOperator.toLocaleString()} $NEXUS</b> to unlock the
        {" "}<span style={{ color: TIER_META.OPERATOR.color }}>{TIER_META.OPERATOR.glyph} OPERATOR</span> tier and enter.
      </div>
      <div style={{ fontFamily: "monospace", fontSize: 9, color: "#2a4a3a", lineHeight: 1.6 }}>
        $NEXUS is a pure community meme token — zero built-in utility or revenue share.
        <br />
        Tiers unlock access &amp; status inside the Lab, nothing more.
      </div>
    </div>
  );
}

export function HoldersRoom({ walletAddress }: { walletAddress: string | null }) {
  const navigate = useNavigate();
  const { tier, isLoading: tierLoading } = useNexusTier(walletAddress);
  const [theses, setTheses] = useState<FeedThesis[] | null>(null);
  const [loadingFeed, setLoadingFeed] = useState(false);

  const isHolder = tier !== "NONE";

  useEffect(() => {
    if (!isHolder || !walletAddress) return;
    setLoadingFeed(true);
    // Server-gated endpoint: only returns holders-only theses if the address holds $NEXUS.
    fetch(`${API_BASE}/feed/holders?address=${walletAddress.toLowerCase()}`)
      .then((r) => r.json())
      .then((data: { feed?: FeedThesis[] }) => {
        setTheses((data.feed ?? []).sort((a, b) => b.createdAt - a.createdAt));
      })
      .catch(() => setTheses([]))
      .finally(() => setLoadingFeed(false));
  }, [isHolder, walletAddress]);

  if (!walletAddress) {
    return (
      <div style={{ textAlign: "center", padding: "48px 20px", fontFamily: "monospace", fontSize: 12, color: "#3a6a4a" }}>
        Connect a wallet to check $NEXUS holder access.
      </div>
    );
  }

  if (tierLoading) {
    return (
      <div style={{ textAlign: "center", padding: "48px 20px", fontFamily: "monospace", fontSize: 12, color: "#3a6a4a" }}>
        Checking $NEXUS balance…
      </div>
    );
  }

  if (!isHolder) return <LockScreen />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Welcome + burn counter */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ fontFamily: "monospace", fontSize: 12, color: "#8aaa9a", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#00ff88" }}>//</span> HOLDERS ROOM
          <NexusTierBadge tier={tier} size="md" />
        </div>
        <NexusBurnCounter compact />
      </div>

      {loadingFeed && (
        <div style={{ fontFamily: "monospace", fontSize: 11, color: "#3a6a4a", padding: "20px 0", textAlign: "center" }}>
          loading holder theses…
        </div>
      )}

      {theses && theses.length === 0 && !loadingFeed && (
        <div style={{ fontFamily: "monospace", fontSize: 11, color: "#3a6a4a", padding: "32px 0", textAlign: "center" }}>
          No holders-only theses yet. In the Nexus Thesis Engine, set a thesis to ◆ HOLDERS to share it here.
        </div>
      )}

      {theses && theses.map((t) => {
        const ticker = t.symbol.replace("PERP_", "").replace("_USDC", "");
        const name = t.displayName ?? `${t.wallet.slice(0, 6)}…${t.wallet.slice(-4)}`;
        const statusColor = STATUS_COLOR[t.status] ?? "#8aaa9a";
        return (
          <div key={t.id} style={{ background: "#0d120d", border: "1px solid #1a2e1a", borderRadius: 4, padding: "12px 16px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <button
              onClick={() => navigate(`/feed/trader/${t.wallet}`)}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "monospace", fontSize: 11, color: "#8aaa9a", minWidth: 140 }}
            >
              {name}
              <NexusTierBadge address={t.wallet} />
            </button>
            <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: "bold", color: "#fff" }}>{ticker}</span>
            <span style={{ fontFamily: "monospace", fontSize: 10, color: t.direction === "LONG" ? "#00ff88" : "#ff4444" }}>
              {t.direction === "LONG" ? "↑" : "↓"} {t.direction}
            </span>
            <span style={{ fontFamily: "monospace", fontSize: 10, color: t.riskReward >= 2 ? "#00ff88" : "#fbbf24" }}>
              1:{t.riskReward.toFixed(2)}
            </span>
            <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 9, letterSpacing: "0.08em", color: statusColor, border: `1px solid ${statusColor}33`, borderRadius: 3, padding: "2px 8px" }}>
              {t.status}
            </span>
          </div>
        );
      })}
    </div>
  );
}
