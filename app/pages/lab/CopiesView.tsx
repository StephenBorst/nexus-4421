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
      <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #232327" }}>
        <div style={{ fontSize: 10, color: "#ededf0", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.12em", marginBottom: 4 }}>
          &#9632; COPY HISTORY — {copiedTheses.length} {copiedTheses.length === 1 ? "thesis" : "theses"} copied
        </div>
        <div style={{ fontSize: 11, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>
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
                background: "#141416",
                border: `1px solid ${cfg.border}`,
                borderRadius: 4,
                padding: "12px 14px",
              }}>
                {/* Header row */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 15, fontWeight: "bold", color: "#fff" }}>{ticker}</span>
                  <span style={{
                    fontFamily: "var(--nx-font-mono)", fontSize: 11,
                    color: t.direction === "LONG" ? "#3ecf8e" : "#f7525f",
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
                      color: t.actualPnl >= 0 ? "#3ecf8e" : "#f7525f",
                    }}>
                      {t.actualPnl >= 0 ? "+" : ""}${t.actualPnl.toFixed(2)}
                    </span>
                  )}
                  {shortWallet && (
                    <button
                      onClick={() => navigate(`/feed/trader/${t.copiedFromWallet}`)}
                      style={{
                        background: "none", border: "1px solid #232327", borderRadius: 3,
                        color: "#52525b", fontFamily: "var(--nx-font-mono)", fontSize: 9,
                        padding: "2px 8px", cursor: "pointer", letterSpacing: "0.04em",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.color = "#d4d4d8";
                        (e.currentTarget as HTMLButtonElement).style.borderColor = "#1a3a5a";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.color = "#52525b";
                        (e.currentTarget as HTMLButtonElement).style.borderColor = "#232327";
                      }}
                    >
                      📋 {shortWallet} ↗
                    </button>
                  )}
                </div>

                {/* Levels grid */}
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(5, 1fr)", gap: "8px 12px" }}>
                  {[
                    { label: "ENTRY",  val: `$${t.entryPrice.toFixed(2)}`,    color: "#a1a1aa" as const },
                    { label: "STOP",   val: `$${t.stopLoss.toFixed(2)}`,      color: "#f7525f" as const },
                    { label: "TP1",    val: `$${t.takeProfit1.toFixed(2)}`,   color: "#ededf0" as const },
                    { label: "R:R",    val: `1:${t.riskReward.toFixed(2)}`,   color: (t.riskReward >= 2 ? "#ededf0" : "#fbbf24") as string },
                    { label: "MAX LOSS", val: `${t.riskPercent}% · $${(t.accountSize * t.riskPercent / 100).toFixed(0)}`, color: "#a1a1aa" as const },
                  ].map(({ label, val, color }) => (
                    <div key={label}>
                      <div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{label}</div>
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


