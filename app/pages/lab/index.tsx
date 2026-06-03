import { useState, useMemo } from "react";
import { useCollateral, usePrivateQuery, useAccount } from "@orderly.network/hooks";
import { useLabStorage } from "@/hooks/useLabStorage";
import { HoldersRoom } from "@/components/HoldersRoom";
import { NexusMarket } from "@/components/NexusMarket";
import type { TabId, DayGroup, ProcessedTrade } from "./types";
import { getDayKey } from "./helpers";
import { useIsMobile } from "./useIsMobile";
// Extracted Lab views
import { AnalyticsView } from "./AnalyticsView";
import { TradeLogAllView, TradeLogView } from "./TradeLog";
import { ThesisView, ThesisAnalyticsView } from "./ThesisView";
import { AgentView } from "./AgentView";
import { CopiesView } from "./CopiesView";
import { MarketIntelView } from "./MarketIntel";
import { LabWelcome, OnboardingChecklist } from "./Onboarding";
export default function TheLabPage() {
  const [activeTab, setActiveTab] = useState<TabId>("intel");
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const today = new Date();

  // ── Persistence (KV + localStorage) ─────────────────────
  const { state: rootAccountState } = useAccount();
  const rootWalletAddress = (rootAccountState as { address?: string })?.address ?? null;
  const { theses, notes, saveNote, syncing, synced } = useLabStorage(rootWalletAddress);
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [viewYear, setViewYear] = useState(today.getFullYear());

  const { data: positionHistory } = usePrivateQuery("/v1/position_history?limit=500");
  const { availableBalance } = useCollateral();

  const processedTrades = useMemo<ProcessedTrade[]>(() => {
    if (!positionHistory || !Array.isArray(positionHistory)) return [];
    return (positionHistory as Record<string, unknown>[])
      .filter((o) => o.position_status === "closed")
      .map((o) => ({
        symbol: String(o.symbol ?? ""),
        direction: (String(o.side ?? "").toUpperCase() === "LONG" ? "LONG" : "SHORT") as "LONG" | "SHORT",
        side: String(o.side ?? ""),
        pnl: parseFloat(String(o.realized_pnl ?? 0)),
        qty: parseFloat(String(o.closed_position_qty ?? 0)),
        price: parseFloat(String(o.avg_close_price ?? 0)),
        entryPrice: parseFloat(String(o.avg_open_price ?? 0)),
        timestamp: Number(o.close_timestamp ?? Date.now()),
        openTimestamp: Number(o.open_timestamp ?? 0),
        leverage: parseFloat(String(o.leverage ?? 0)),
      }));
  }, [positionHistory]);

  const dayGroups = useMemo<Record<string, DayGroup>>(() => {
    const groups: Record<string, DayGroup> = {};
    processedTrades.forEach((trade) => {
      const key = getDayKey(trade.timestamp);
      if (!groups[key]) groups[key] = { pnl: 0, trades: 0, wins: 0, tradeList: [] };
      groups[key].pnl += trade.pnl; groups[key].trades += 1;
      if (trade.pnl > 0) groups[key].wins += 1;
      groups[key].tradeList.push(trade);
    });
    return groups;
  }, [processedTrades]);

  const totalPnl = useMemo(() => processedTrades.reduce((s, t) => s + t.pnl, 0), [processedTrades]);
  const winRate = useMemo(() => { const w = processedTrades.filter((t) => t.pnl > 0).length; return processedTrades.length ? (w / processedTrades.length) * 100 : 0; }, [processedTrades]);

  const handleDayClick = (key: string, day: number) => { setSelectedDayKey(key); setSelectedDay(day); setActiveTab("tradelog"); };
  const handleBack = () => { setSelectedDayKey(null); setSelectedDay(null); };
  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); } else setViewMonth((m) => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); } else setViewMonth((m) => m + 1); };

  const isMobile = useIsMobile();

  // ── Open positions (for briefing header) ─────────────────
  const { data: posData } = usePrivateQuery("/v1/positions", { revalidateOnFocus: false });
  const openPositions: any[] = (posData as any)?.rows ?? [];
  const openCount = openPositions.length;
  const unrealizedPnl = openPositions.reduce((s: number, p: any) => s + (p.unsettled_pnl ?? 0), 0);

  // Left-to-right = the trader's lifecycle: scout → plan → automate → follow →
  // record → grade. Analytics sits last to close the loop back to the top.
  const tabs: { id: TabId; label: string; short: string }[] = [
    { id: "intel",          label: "[ MARKET INTEL ]",    short: "INTEL" },
    { id: "thesis",         label: "[ NEXUS THESIS ENGINE ]", short: "LAB"   },
    { id: "agent",          label: "[ TRADING AGENT ]",   short: "AGENT" },
    { id: "copies",         label: "[ COPY TRADES ]",     short: "COPY"  },
    { id: "tradelog",       label: "[ TRADING LOG ]",     short: "LOG"   },
    { id: "holders",        label: "[ HOLDERS ROOM ]",    short: "◆"     },
    { id: "analytics",      label: "[ ANALYTICS ]",       short: "STATS" },
  ];

  const calendarProps = { dayGroups, onDayClick: handleDayClick, viewMonth, viewYear, onPrevMonth: prevMonth, onNextMonth: nextMonth, totalPnl };

  const connected = !!rootWalletAddress;

  return (
    <div style={{ background: "#0a0e0a", minHeight: "100vh", padding: 0 }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 8px #00ff88}50%{opacity:0.4;box-shadow:0 0 2px #00ff88}}`}</style>
      {/* ── BRIEFING HEADER ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: isMobile ? "6px 10px" : "6px 18px", background: "#05080a", borderBottom: "1px solid #0d1f0d", flexWrap: "wrap", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "monospace", fontSize: 11, color: "#00ff88", letterSpacing: "0.25em", fontWeight: "bold", textShadow: "0 0 12px rgba(0,255,136,0.5)" }}>//</span>
          <span style={{ fontFamily: "monospace", fontSize: 11, color: "#fff", letterSpacing: "0.25em", fontWeight: "bold" }}>THE LAB</span>
          <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#00ff88", boxShadow: "0 0 8px #00ff88", animation: "pulse 2s infinite" }} />
        </div>
        <div style={{ display: "flex", gap: isMobile ? 10 : 20, alignItems: "center", flexWrap: "wrap" }}>
          {[
            { label: "OPEN", val: connected ? String(openCount) : "—", color: openCount > 0 ? "#fbbf24" : "#3a6a4a" },
            { label: "CLOSED", val: connected ? String(processedTrades.length) : "—", color: "#4a9fff" },
            { label: "WIN RATE", val: connected && processedTrades.length > 0 ? `${winRate.toFixed(1)}%` : "—", color: connected && processedTrades.length > 0 ? (winRate >= 50 ? "#00ff88" : "#ff4444") : "#3a6a4a" },
            { label: "REALIZED P&L", val: connected && processedTrades.length > 0 ? `${totalPnl >= 0 ? "+" : ""}$${Math.abs(totalPnl).toFixed(2)}` : "—", color: connected && processedTrades.length > 0 ? (totalPnl >= 0 ? "#00ff88" : "#ff4444") : "#3a6a4a" },
            { label: "UNREALIZED", val: connected && openCount > 0 ? `${unrealizedPnl >= 0 ? "+" : ""}$${Math.abs(unrealizedPnl).toFixed(2)}` : "—", color: connected && openCount > 0 ? (unrealizedPnl >= 0 ? "#00ff88" : "#ff4444") : "#3a6a4a" },
            { label: "BALANCE", val: connected && availableBalance != null ? `$${(availableBalance as number).toFixed(2)}` : "—", color: "#e5e7eb" },
          ].map(({ label, val, color }) => (
            <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: isMobile ? "center" : "flex-start", gap: 1 }}>
              <span style={{ fontFamily: "monospace", fontSize: 8, letterSpacing: "0.12em" }}>{label}</span>
              <span style={{ fontFamily: "monospace", fontSize: isMobile ? 11 : 12, color, fontWeight: "bold", letterSpacing: "0.05em" }}>{val}</span>
            </div>
          ))}
        </div>
      </div>
      {/* ── TAB BAR ── */}
      <div style={{ display: "flex", gap: 2, padding: isMobile ? "6px 8px" : "8px 16px", borderBottom: "1px solid #1a2e1a", background: "#080c08", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: isMobile ? 4 : 2, flex: 1 }}>
          {tabs.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
              background: activeTab === tab.id ? "#0a1a0a" : "none",
              border: `1px solid ${activeTab === tab.id ? "#00ff88" : "transparent"}`,
              color: activeTab === tab.id ? "#00ff88" : "#4a7a5a",
              fontFamily: "monospace",
              fontSize: isMobile ? 10 : 11,
              padding: isMobile ? "6px 8px" : "5px 12px",
              cursor: "pointer",
              letterSpacing: "0.05em",
              borderRadius: 3,
              minHeight: isMobile ? 36 : "auto",
              flex: isMobile ? 1 : "none",
            }}>{isMobile ? tab.short : tab.label}</button>
          ))}
        </div>
        <div style={{ fontSize: 9, fontFamily: "monospace", letterSpacing: "0.1em", color: syncing ? "#fbbf24" : synced ? "#00ff88" : "#2a4a3a", flexShrink: 0, marginLeft: 8 }}>
          {syncing ? "⟳" : synced ? "●" : rootWalletAddress ? "○" : isMobile ? "○" : "○ CONNECT WALLET"}
        </div>
      </div>
      <div style={{ padding: isMobile ? 12 : 16 }}>
        <div style={{ marginBottom: 12 }}>
          <NexusMarket />
        </div>
        {connected && (
          <OnboardingChecklist
            hasThesis={theses.length > 0}
            hasTrade={processedTrades.length > 0}
            onGoThesis={() => setActiveTab("thesis")}
            onGoAnalytics={() => setActiveTab("analytics")}
          />
        )}
        {activeTab === "analytics" && (
          <AnalyticsView orders={processedTrades} totalPnl={totalPnl} winRate={winRate} collateral={availableBalance ?? 0} />
        )}
        {activeTab === "tradelog" && (
          selectedDayKey && selectedDay !== null && dayGroups[selectedDayKey]
            ? <TradeLogView
                dayKey={selectedDayKey}
                data={dayGroups[selectedDayKey]}
                onBack={() => { setSelectedDayKey(null); setSelectedDay(null); }}
                initialNote={notes[selectedDayKey]}
                onSaveNote={saveNote}
              />
            : <TradeLogAllView
                dayGroups={dayGroups}
                onDaySelect={(key, day) => { setSelectedDayKey(key); setSelectedDay(day); }}
                notes={notes}
                calendarProps={calendarProps}
              />
        )}
        {activeTab === "thesis" && (
          <>
            <ThesisView />
            <ThesisAnalyticsView />
          </>
        )}
        {activeTab === "copies" && <CopiesView />}
        {activeTab === "intel" && (
          connected ? <MarketIntelView /> : <LabWelcome />
        )}
        {activeTab === "agent" && <AgentView />}
        {activeTab === "holders" && <HoldersRoom walletAddress={rootWalletAddress} />}
      </div>
    </div>
  );
}
