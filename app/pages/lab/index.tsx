import { useState, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useCollateral, usePrivateQuery, useAccount } from "@orderly.network/hooks";
import { useLabStorage } from "@/hooks/useLabStorage";
import { HoldersRoom } from "@/components/HoldersRoom";
import { QuickTrade } from "./QuickTrade";
import { NexusMarket } from "@/components/NexusMarket";
import { NexusBrokerStats } from "@/components/NexusBrokerStats";
import { NexusPro } from "@/components/NexusPro";
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
import { SmartMoneyView } from "./SmartMoneyView";
import { LabWelcome, OnboardingChecklist } from "./Onboarding";
import { LabStanding } from "./LabStanding";
import { CommandPalette } from "./CommandPalette";
import { CountUp } from "./components";

export default function TheLabPage() {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabId>(() => (searchParams.get("tab") as TabId) || "intel");
  // Honor ?tab= deep-links (e.g. the AI assistant's draft_thesis → /lab?tab=thesis).
  useEffect(() => {
    const t = searchParams.get("tab") as TabId | null;
    if (t) setActiveTab(t);
  }, [searchParams]);
  // Programmatic tab switches (deployToAgent / deployDirectiveFromThesis) fire this
  // event so they work even when the URL's ?tab= is stale (tab clicks use local
  // state, not the URL) — a plain navigate would no-op in that case.
  useEffect(() => {
    const onTab = (e: Event) => {
      const t = (e as CustomEvent).detail?.tab as TabId | undefined;
      if (t) setActiveTab(t);
    };
    window.addEventListener("nexus:lab-tab", onTab);
    return () => window.removeEventListener("nexus:lab-tab", onTab);
  }, []);
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
        // ⚠️ Orderly SIGNS the price fields by direction — avg_open_price and
        // avg_close_price come back NEGATIVE on shorts (verified on prod: 91 of 136
        // rows negative, exactly the 91 short trades). A price is never negative;
        // direction already lives in `side`/`direction`. Without abs(), volume summed
        // to −$20,087 and rendered "—" instead of $42,464, and every short showed a
        // negative entry/exit price.
        qty: Math.abs(parseFloat(String(o.closed_position_qty ?? 0))),
        price: Math.abs(parseFloat(String(o.avg_close_price ?? 0))),
        entryPrice: Math.abs(parseFloat(String(o.avg_open_price ?? 0))),
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
  // Orderly's /v1/positions returns a row for every symbol the account has state on —
  // including CLOSED ones (position_qty 0) that linger until settled. Counting raw rows
  // showed "OPEN 2" while actually flat, so keep only rows with real size.
  const openPositions: any[] = ((posData as any)?.rows ?? []).filter((p: any) => Math.abs(parseFloat(p?.position_qty ?? 0)) > 1e-9);
  const openCount = openPositions.length;
  const unrealizedPnl = openPositions.reduce((s: number, p: any) => s + (p.unsettled_pnl ?? 0), 0);

  // Left-to-right = the trader's lifecycle: scout → plan → automate → follow →
  // record → grade. Analytics sits last to close the loop back to the top.
  const tabs: { id: TabId; label: string; short: string }[] = [
    { id: "intel",          label: "[ MARKET INTEL ]",    short: "INTEL" },
    { id: "smart",          label: "[ SMART MONEY ]",     short: "SMART" },
    { id: "thesis",         label: "[ NEXUS THESIS ENGINE ]", short: "LAB"   },
    { id: "agent",          label: "[ TRADING AGENT ]",   short: "AGENT" },
    { id: "quicktrade",     label: "[ QUICK TRADE ]",     short: "TRADE" },
    { id: "copies",         label: "[ COPY TRADES ]",     short: "COPY"  },
    { id: "tradelog",       label: "[ TRADING LOG ]",     short: "LOG"   },
    { id: "holders",        label: "[ HOLDERS ROOM ]",    short: "ROOM"  },
    { id: "analytics",      label: "[ ANALYTICS ]",       short: "STATS" },
  ];

  const calendarProps = { dayGroups, onDayClick: handleDayClick, viewMonth, viewYear, onPrevMonth: prevMonth, onNextMonth: nextMonth, totalPnl };

  const connected = !!rootWalletAddress;

  return (
    <div style={{ background: "#0a0a0b", minHeight: "100dvh", padding: 0 }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 8px #ededf0}50%{opacity:0.4;box-shadow:0 0 2px #ededf0}}`}</style>
      {/* ── BRIEFING HEADER ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: isMobile ? "6px 10px" : "6px 18px", background: "#0f0f11", borderBottom: "1px solid #232327", flexWrap: "wrap", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#ededf0", letterSpacing: "0.25em", fontWeight: "bold", textShadow: "0 0 12px rgba(255,255,255,0.25)" }}>//</span>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#f4f4f5", letterSpacing: "0.25em", fontWeight: "bold" }}>THE LAB</span>
          <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#ededf0", boxShadow: "0 0 8px #ededf0", animation: "pulse 2s infinite" }} />
        </div>
        <div style={isMobile
          ? { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px 6px", width: "100%", marginTop: 4 }
          : { display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          {([
            { label: "OPEN", num: connected ? openCount : null, fmt: (v: number) => String(Math.round(v)), color: openCount > 0 ? "#fbbf24" : "#71717a" },
            { label: "CLOSED", num: connected ? processedTrades.length : null, fmt: (v: number) => String(Math.round(v)), color: "#d4d4d8" },
            { label: "WIN RATE", num: connected && processedTrades.length > 0 ? winRate : null, fmt: (v: number) => `${v.toFixed(1)}%`, color: connected && processedTrades.length > 0 ? (winRate >= 50 ? "#3ecf8e" : "#f7525f") : "#71717a" },
            { label: "REALIZED P&L", num: connected && processedTrades.length > 0 ? totalPnl : null, fmt: (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`, color: connected && processedTrades.length > 0 ? (totalPnl >= 0 ? "#3ecf8e" : "#f7525f") : "#71717a" },
            { label: "UNREALIZED", num: connected && openCount > 0 ? unrealizedPnl : null, fmt: (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`, color: connected && openCount > 0 ? (unrealizedPnl >= 0 ? "#3ecf8e" : "#f7525f") : "#71717a" },
            { label: "BALANCE", num: connected && availableBalance != null ? (availableBalance as number) : null, fmt: (v: number) => `$${v.toFixed(2)}`, color: "#f4f4f5" },
          ] as { label: string; num: number | null; fmt: (v: number) => string; color: string }[]).map(({ label, num, fmt, color }) => (
            <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: isMobile ? "center" : "flex-start", gap: 1 }}>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.12em" }}>{label}</span>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: isMobile ? 11 : 12, color, fontWeight: "bold", letterSpacing: "0.05em" }}>
                {num == null ? "—" : <CountUp value={num} format={fmt} />}
              </span>
            </div>
          ))}
        </div>
      </div>
      {/* ── TAB BAR ── */}
      <div style={{ display: "flex", gap: 2, padding: isMobile ? "6px 8px" : "8px 16px", borderBottom: "1px solid #232327", background: "#0f0f11", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: isMobile ? 4 : 2, flex: 1, minWidth: 0, flexWrap: isMobile ? "wrap" : "nowrap", overflowX: isMobile ? "visible" : "auto" }}>
          {tabs.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
              background: activeTab === tab.id ? "#1a1a1e" : "none",
              border: `1px solid ${activeTab === tab.id ? "#ededf0" : "transparent"}`,
              color: activeTab === tab.id ? "#ededf0" : "#71717a",
              fontFamily: "var(--nx-font-mono)",
              fontSize: isMobile ? 10 : 11,
              padding: isMobile ? "6px 8px" : "5px 12px",
              cursor: "pointer",
              letterSpacing: "0.05em",
              borderRadius: 3,
              minHeight: isMobile ? 36 : "auto",
              flex: isMobile ? "1 0 21%" : "none",
              flexShrink: isMobile ? 1 : 0,
              whiteSpace: "nowrap",
            }}>{isMobile ? tab.short : tab.label}</button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0, marginLeft: 8 }}>
          <span
            title="Command palette"
            onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
            style={{ fontFamily: "var(--nx-font-mono)", fontSize: isMobile ? 12 : 9, color: "#52525b", border: "1px solid #232327", borderRadius: 3, padding: isMobile ? "6px 9px" : "2px 6px", cursor: "pointer", letterSpacing: "0.05em", minHeight: isMobile ? 36 : "auto", display: "flex", alignItems: "center" }}
          >{isMobile ? "⌘" : "⌘K"}</span>
          {!isMobile && (
            <span style={{ fontSize: 9, fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", color: syncing ? "#fbbf24" : synced ? "#ededf0" : "#33333a", textShadow: synced ? "0 0 8px rgba(237,237,240,0.5)" : "none" }}>
              {syncing ? "⟳" : synced ? "●" : rootWalletAddress ? "○" : "○ CONNECT WALLET"}
            </span>
          )}
        </div>
      </div>
      <div style={{ padding: isMobile ? 12 : 16 }}>
        {/* Information hierarchy: the graded record (the moat claim) + onboarding
            lead, then the active tab — the task the user came for. The ambient promo/
            status chrome (market, network-verify, PRO badge) used to stack ~415px
            ABOVE the content (≈43% of the fold); it now lives in a context strip
            below. Renders nothing when disconnected. */}
        <LabStanding address={rootWalletAddress} />
        {connected && (
          <OnboardingChecklist
            hasThesis={theses.length > 0}
            hasTrade={processedTrades.length > 0}
            onGoThesis={() => setActiveTab("thesis")}
            onGoAnalytics={() => setActiveTab("analytics")}
          />
        )}
        {/* key={activeTab} re-mounts the content on tab switch → the .nx-fade-in
            entrance replays, giving a considered transition instead of a hard swap. */}
        <div key={activeTab} className="nx-fade-in">
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
        {activeTab === "smart" && <SmartMoneyView myPositions={openPositions} />}
        {activeTab === "agent" && <AgentView />}
        {activeTab === "holders" && <HoldersRoom walletAddress={rootWalletAddress} />}
        {activeTab === "quicktrade" && <QuickTrade />}
        </div>
        {/* Ambient context — token flywheel, network verification, PRO status. Real
            signal, but not the task, so it sits below the fold instead of in front
            of it. Hairline rule separates it from the working surface above. */}
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid #232327", display: "flex", flexDirection: "column", gap: 12 }}>
          <NexusMarket />
          <NexusBrokerStats />
          {connected && <NexusPro walletAddress={rootWalletAddress} />}
        </div>
      </div>
      <CommandPalette onSelectTab={setActiveTab} />
    </div>
  );
}
