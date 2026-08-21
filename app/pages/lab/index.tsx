import { useState, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useCollateral, usePrivateQuery, useAccount } from "@orderly.network/hooks";
import { useLabStorage } from "@/hooks/useLabStorage";
import { HoldersRoom } from "@/components/HoldersRoom";
import { QuickTrade } from "./QuickTrade";
import { NexusTicker } from "@/components/NexusTicker";
import { NexusBuyBar } from "@/components/NexusBuyBar";
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
import { MarketTape } from "./MarketTape";
import { SmartMoneyView } from "./SmartMoneyView";
import { MispricedBoard } from "./MispricedBoard";
import { MacroView } from "./MacroView";
import { PositioningBoard } from "./PositioningBoard";
import { LabWelcome, OnboardingChecklist } from "./Onboarding";
import { LabStanding } from "./LabStanding";
import { CommandPalette } from "./CommandPalette";
import { NexusBriefing } from "./NexusBriefing";
import { DecisionBoard } from "./DecisionBoard";
import { CountUp } from "./components";

// Legacy alias: the old MISPRICED/GAPS tab was folded into SMART MONEY (Phase 1 re-slice),
// so any ?tab=mispriced deep-link, shared OG link, or copilot nav resolves to smart.
const normTab = (t: string | null | undefined): TabId | null =>
  !t ? null : (t === "mispriced" || t === "gaps") ? "smart" : (t as TabId);

export default function TheLabPage() {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabId>(() => normTab(searchParams.get("tab")) || "intel");
  // Honor ?tab= deep-links (e.g. the AI assistant's draft_thesis → /lab?tab=thesis).
  useEffect(() => {
    const t = normTab(searchParams.get("tab"));
    if (t) setActiveTab(t);
  }, [searchParams]);
  // Programmatic tab switches (deployToAgent / deployDirectiveFromThesis) fire this
  // event so they work even when the URL's ?tab= is stale (tab clicks use local
  // state, not the URL) — a plain navigate would no-op in that case.
  useEffect(() => {
    const onTab = (e: Event) => {
      const t = normTab((e as CustomEvent).detail?.tab);
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
  // Positions in the shape The Briefing reads (direction from signed qty).
  const briefingPositions = openPositions
    .map((p: any) => ({ symbol: String(p.symbol ?? ""), direction: (parseFloat(p.position_qty ?? 0) >= 0 ? "LONG" : "SHORT") as "LONG" | "SHORT" }))
    .filter((p) => p.symbol);

  // ── The loop, made visible ────────────────────────────────────────────────
  // The product's whole claim is a LOOP — observe → plan → execute → prove — but the
  // nav used to be nine equal-weight peers, which reads as nine unrelated tools and
  // hides the one thing that makes the Lab coherent. Tabs are unchanged; they're now
  // grouped under the phase they belong to, so the structure teaches the workflow.
  // (Holders Room sits outside the loop — it's community access, not a trading step,
  // and pretending otherwise would be the same dishonesty in the other direction.)
  const tabs: { id: TabId; label: string; short: string; phase: string }[] = [
    { id: "intel",          label: "[ MARKET INTEL ]",       short: "INTEL", phase: "OBSERVE" },
    { id: "macro",          label: "[ MACRO ]",              short: "MACRO", phase: "OBSERVE" },
    { id: "smart",          label: "[ SMART MONEY ]",        short: "SMART", phase: "OBSERVE" },
    { id: "thesis",         label: "[ NEXUS THESIS ENGINE ]", short: "LAB",  phase: "PLAN"    },
    { id: "agent",          label: "[ TRADING AGENT ]",      short: "AGENT", phase: "EXECUTE" },
    { id: "quicktrade",     label: "[ QUICK TRADE ]",        short: "TRADE", phase: "EXECUTE" },
    { id: "copies",         label: "[ COPY TRADES ]",        short: "COPY",  phase: "EXECUTE" },
    // Holders Room is community access, not a trading step — it sits between EXECUTE
    // and PROVE so the loop still ENDS on Analytics (which closes it back to the top).
    { id: "holders",        label: "[ HOLDERS ROOM ]",       short: "ROOM",  phase: ""        },
    { id: "tradelog",       label: "[ TRADING LOG ]",        short: "LOG",   phase: "PROVE"   },
    { id: "analytics",      label: "[ ANALYTICS ]",          short: "STATS", phase: "PROVE"   },
  ];
  // Group in declaration order — the array above IS the loop's order.
  const tabGroups = tabs.reduce<{ phase: string; items: typeof tabs }[]>((acc, t) => {
    const last = acc[acc.length - 1];
    if (last && last.phase === t.phase) last.items.push(t);
    else acc.push({ phase: t.phase, items: [t] });
    return acc;
  }, []);

  const calendarProps = { dayGroups, onDayClick: handleDayClick, viewMonth, viewYear, onPrevMonth: prevMonth, onNextMonth: nextMonth, totalPnl };

  const connected = !!rootWalletAddress;

  return (
    <div style={{ background: "#0a0a0b", minHeight: "100dvh", padding: 0 }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 8px #ededf0}50%{opacity:0.4;box-shadow:0 0 2px #ededf0}}`}</style>
      {/* ── LIVE MARKET TICKER ── the Wall-Street tape up top (market presence
          restored to the fold as one thin ambient line, not the old 415px stack). */}
      <NexusTicker />
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
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: "#71717a" }}>{label}</span>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: isMobile ? 11 : 12, color, fontWeight: "bold", letterSpacing: "0.05em" }}>
                {num == null ? "—" : <CountUp value={num} format={fmt} />}
              </span>
            </div>
          ))}
        </div>
      </div>
      {/* ── TAB BAR ── */}
      <div style={{ display: "flex", gap: 2, padding: isMobile ? "6px 8px" : "8px 16px", borderBottom: "1px solid #232327", background: "#0f0f11", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: isMobile ? 4 : 2, flex: 1, minWidth: 0, flexWrap: isMobile ? "wrap" : "nowrap", overflowX: isMobile ? "visible" : "auto", alignItems: "center" }}>
          {/* Desktop shows the phase spine; mobile keeps the equal-width wrap grid
              (phase labels would eat the row, and the order alone carries the loop). */}
          {tabGroups.map((group, gi) => (
            <div key={group.phase || `x${gi}`} style={{ display: "contents" }}>
              {!isMobile && gi > 0 && group.phase && (
                <span style={{
                  fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.16em",
                  color: "#52525b", flexShrink: 0, padding: "0 8px 0 10px",
                  borderLeft: "1px solid #232327",
                }}>{group.phase}</span>
              )}
              {group.items.map((tab) => (
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
        {/* Regime strip on the DECISION tabs only — the tape informs the trade you're
            about to size/automate. Outside the keyed div so it stays mounted (no
            re-fetch) when switching between thesis and agent. */}
        {connected && (activeTab === "thesis" || activeTab === "agent") && <MarketTape compact />}
        {/* key={activeTab} re-mounts the content on tab switch → the .nx-fade-in
            entrance replays, giving a considered transition instead of a hard swap. */}
        <div key={activeTab} className="nx-fade-in">
        {activeTab === "analytics" && (
          <AnalyticsView orders={processedTrades} totalPnl={totalPnl} winRate={winRate} collateral={availableBalance ?? 0} theses={theses} wallet={rootWalletAddress} />
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
            <ThesisView realizedTrades={connected ? processedTrades : undefined} wallet={rootWalletAddress} />
            <ThesisAnalyticsView />
          </>
        )}
        {activeTab === "copies" && <CopiesView />}
        {activeTab === "intel" && (() => {
          // The Briefing reads the MARKET for everyone (wallet-free) and adds a personal
          // lens when connected — so the Lab feels intelligent on the first visit.
          const briefing = (
            <NexusBriefing
              trades={connected ? processedTrades : []}
              winRate={winRate}
              totalPnl={totalPnl}
              openPositions={connected ? briefingPositions : []}
              wallet={rootWalletAddress}
              onSelectTab={setActiveTab}
            />
          );
          // Connected → the Briefing IS your terminal read, so it leads, then the
          // instruments. Disconnected → lead with the welcome (the value prop / the
          // prize), Briefing below as proof the Lab is already intelligent — so a
          // first-timer isn't met with a wall of market rows before the pitch.
          // The Board (every market, one verifiable read) sits between the narrative
          // Briefing and the deep Market Intel — scan the whole book at a glance. Shown
          // to everyone; it's market-level, no wallet needed.
          const board = <DecisionBoard onSelectTab={setActiveTab} trades={connected ? processedTrades : undefined} wallet={rootWalletAddress} />;
          return connected
            ? <>{briefing}{board}<MarketIntelView /></>
            : <><LabWelcome />{briefing}{board}</>;
        })()}
        {activeTab === "smart" && (
          <>
            {/* Phase 2 — the fused read leads: crowd (funding) vs smart money (wallets),
                confluence = high conviction, split = the debate. Deep boards below. */}
            <PositioningBoard />
            <SmartMoneyView myPositions={openPositions} />
            {/* Fade-the-crowd funding board, folded in from the old MISPRICED tab (Phase 1
                re-slice): Smart Money = follow the sharp; the funding board = fade the crowd.
                Two sides of positioning, one tab. */}
            <div style={{ marginTop: 32, paddingTop: 4, borderTop: "1px solid #232327" }}>
              <MispricedBoard />
            </div>
          </>
        )}
        {activeTab === "macro" && <MacroView />}
        {activeTab === "agent" && <AgentView />}
        {activeTab === "holders" && <HoldersRoom walletAddress={rootWalletAddress} />}
        {activeTab === "quicktrade" && <QuickTrade />}
        </div>
        {/* Slim footer — the live $NEXUS price now lives in the top ticker, so the
            bulky 4-stat market card + the lone "verify on Orderly" band were just
            redundant clutter. Keep only the actionable bits: a thin BUY $NEXUS row
            and (connected) the PRO status/upsell. Hairline rule separates it from
            the working surface above. */}
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid #232327", display: "flex", flexDirection: "column", gap: 12 }}>
          <NexusBuyBar />
          {connected && <NexusPro walletAddress={rootWalletAddress} />}
        </div>
      </div>
      <CommandPalette onSelectTab={setActiveTab} />
    </div>
  );
}
