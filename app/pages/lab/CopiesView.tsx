// Copy Trades tab. Extracted from index.tsx (god-file split).
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "@orderly.network/hooks";
import { useLabStorage } from "@/hooks/useLabStorage";
import { useIsMobile } from "./useIsMobile";
import type { ThesisTrade } from "./types";
import { cardStyle, labelStyle, navBtnStyle, STATUS_CONFIG } from "./styles";
import { formatPnl } from "./helpers";
import { EmptyState } from "./components";

export function CopiesView() {
  const isMobile = useIsMobile();
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;
  const { theses } = useLabStorage(walletAddress);
  const navigate = useNavigate();

  const copiedTheses = useMemo(
    () => theses.filter((t) => t.copiedFromWallet || t.id.startsWith("copy_")),
    [theses]
  );

  return (
    <div>
      <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #1a2e1a" }}>
        <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.12em", marginBottom: 4 }}>
          &#9632; COPY HISTORY — {copiedTheses.length} {copiedTheses.length === 1 ? "thesis" : "theses"} copied
        </div>
        <div style={{ fontSize: 11, color: "#3a5a4a", fontFamily: "var(--nx-font-mono)" }}>
        </div>
      </div>

      {copiedTheses.length === 0 ? (
        <EmptyState message="no copied theses yet — use COPY on any public thesis in the FEED" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {copiedTheses.map((t) => {
            const ticker = t.symbol.replace("PERP_", "").replace("_USDC", "");
            const cfg = STATUS_CONFIG[t.status] ?? STATUS_CONFIG.ACTIVE;
            const shortWallet = t.copiedFromWallet
              ? `${t.copiedFromWallet.slice(0, 6)}...${t.copiedFromWallet.slice(-4)}`
              : null;

            return (
              <div key={t.id} style={{
                background: "#0d120d",
                border: `1px solid ${cfg.border}`,
                borderRadius: 4,
                padding: "12px 14px",
              }}>
                {/* Header row */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 15, fontWeight: "bold", color: "#fff" }}>{ticker}</span>
                  <span style={{
                    fontFamily: "var(--nx-font-mono)", fontSize: 11,
                    color: t.direction === "LONG" ? "#00ff88" : "#ff4444",
                  }}>
                    {t.direction === "LONG" ? "↑" : "↓"} {t.direction}
                  </span>
                  <div style={{
                    fontFamily: "var(--nx-font-mono)", fontSize: 9, padding: "2px 8px", borderRadius: 3,
                    background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
                  }}>
                    {cfg.label}
                  </div>
                  {t.actualPnl !== null && t.status !== "ACTIVE" && (
                    <span style={{
                      fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: "bold",
                      color: t.actualPnl >= 0 ? "#00ff88" : "#ff4444",
                    }}>
                      {t.actualPnl >= 0 ? "+" : ""}${t.actualPnl.toFixed(2)}
                    </span>
                  )}
                  {shortWallet && (
                    <button
                      onClick={() => navigate(`/feed/trader/${t.copiedFromWallet}`)}
                      style={{
                        background: "none", border: "1px solid #1a2e1a", borderRadius: 3,
                        color: "#3a5a4a", fontFamily: "var(--nx-font-mono)", fontSize: 9,
                        padding: "2px 8px", cursor: "pointer", letterSpacing: "0.04em",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.color = "#4a9fff";
                        (e.currentTarget as HTMLButtonElement).style.borderColor = "#1a3a5a";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.color = "#3a5a4a";
                        (e.currentTarget as HTMLButtonElement).style.borderColor = "#1a2e1a";
                      }}
                    >
                      📋 {shortWallet} ↗
                    </button>
                  )}
                </div>

                {/* Levels grid */}
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(5, 1fr)", gap: "8px 12px" }}>
                  {[
                    { label: "ENTRY",  val: `$${t.entryPrice.toFixed(2)}`,    color: "#8aaa9a" as const },
                    { label: "STOP",   val: `$${t.stopLoss.toFixed(2)}`,      color: "#ff4444" as const },
                    { label: "TP1",    val: `$${t.takeProfit1.toFixed(2)}`,   color: "#00ff88" as const },
                    { label: "R:R",    val: `1:${t.riskReward.toFixed(2)}`,   color: (t.riskReward >= 2 ? "#00ff88" : "#fbbf24") as string },
                    { label: "MAX LOSS", val: `${t.riskPercent}% · $${(t.accountSize * t.riskPercent / 100).toFixed(0)}`, color: "#8aaa9a" as const },
                  ].map(({ label, val, color }) => (
                    <div key={label}>
                      <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "var(--nx-font-mono)" }}>{label}</div>
                      <div style={{ fontSize: 11, color, fontFamily: "var(--nx-font-mono)" }}>{val}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


