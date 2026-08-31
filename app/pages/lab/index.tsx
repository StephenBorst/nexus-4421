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
import { CatalystBoard } from "./CatalystBoard";
import { ForecastDivergence } from "./ForecastDivergence";
import { PositioningBoard } from "./PositioningBoard";
import { Collapsible } from "./Collapsible";
import { LabWelcome, OnboardingChecklist } from "./Onboarding";
import { LabStanding } from "./LabStanding";
import { CommandPalette } from "./CommandPalette";
import { SimCreditsBadge } from "./SimCreditsBadge";
import { CreatorEarnings } from "./CreatorEarnings";
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
  const [showAllTabs, setShowAllTabs] = useState(false); // guest nav expands from 3 rooms → full set
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
    { id: "intel",          label: "Market Intel",       short: "INTEL", phase: "OBSERVE" },
    { id: "smart",          label: "Smart Money",        short: "SMART", phase: "OBSERVE" },
    { id: "thesis",         label: "Thesis Engine",      short: "LAB",   phase: "PLAN"    },
    { id: "agent",          label: "Trading Agent",      short: "AGENT", phase: "EXECUTE" },
    { id: "quicktrade",     label: "Quick Trade",        short: "TRADE", phase: "EXECUTE" },
    { id: "copies",         label: "Copy Trades",        short: "COPY",  phase: "EXECUTE" },
    // Holders Room is community access, not a trading step — it sits between EXECUTE
    // and PROVE so the loop still ENDS on Analytics (which closes it back to the top).
    { id: "holders",        label: "Holders Room",       short: "ROOM",  phase: ""        },
    { id: "tradelog",       label: "Trading Log",        short: "LOG",   phase: "PROVE"   },
    { id: "analytics",      label: "Analytics",          short: "STATS", phase: "PROVE"   },
  ];
  // ── Guest Lab IA — three rooms ────────────────────────────────────────────────
  // A guest (no wallet) sees the three read-first rooms — Market Intel · Smart Money · Thesis
  // Engine — plus a More toggle that reveals the rest (Agent / Quick Trade / Copy Trades / Holders
  // Room / Trading Log / Analytics, which need a wallet to be useful). A connected wallet always
  // sees the full set. If a guest deep-links to a gated tab, show everything so the active tab is
  // never orphaned. Publish / COPY / ARM LIVE stay wallet-gated in their own surfaces.
  const GUEST_ROOMS: TabId[] = ["intel", "smart", "thesis"];
  const guestNav = !rootWalletAddress && !showAllTabs && GUEST_ROOMS.includes(activeTab);
  const visibleTabs = guestNav ? tabs.filter((t) => GUEST_ROOMS.includes(t.id)) : tabs;
  // Group in declaration order — the array above IS the loop's order.
  const tabGroups = visibleTabs.reduce<{ phase: string; items: typeof tabs }[]>((acc, t) => {
    const last = acc[acc.length - 1];
    if (last && last.phase === t.phase) last.items.push(t);
    else acc.push({ phase: t.phase, items: [t] });
    return acc;
  }, []);

  const calendarProps = { dayGroups, onDayClick: handleDayClick, viewMonth, viewYear, onPrevMonth: prevMonth, onNextMonth: nextMonth, totalPnl };

  const connected = !!rootWalletAddress;
  // ── Guest Lab ───────────────────────────────────────────────────────────────
  // Once a visitor is past the funnel — ?guest=1 (documented read-only preview), a
  // prior visit's ntl_onboarded, or a Skip that set it — the Market Intel first paint
  // is THE BOARD, not the six-tile marketing splash. Read at render (uncached) so a
  // Skip that flips ntl_onboarded reveals the board on the very next paint; the URL
  // param still counts when storage is blocked. Guest is READ-ONLY — COPY / PUBLISH /
  // ARM LIVE stay wallet-gated in their own surfaces (untouched here).
  const guestPreview = (() => {
    try {
      if (searchParams.get("guest") === "1") return true;
      return localStorage.getItem("ntl_onboarded") === "true";
    } catch { return false; }
  })();

  return (
    <div style={{ background: "#0a0a0b", minHeight: "100dvh", padding: 0 }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 8px #ededf0}50%{opacity:0.4;box-shadow:0 0 2px #ededf0}}`}</style>
      {/* ── LIVE MARKET TICKER ── the Wall-Street tape up top (market presence
          restored to the fold as one thin ambient line, not the old 415px stack). */}
      <NexusTicker />
      {/* ── STATS HEADER ── account P&L stats. Hidden while DISCONNECTED (guest): the whole
          strip would just be OPEN / CLOSED / WIN RATE / REALIZED / UNREALIZED / BALANCE dashes —
          chrome over the board. Connect brings it (and the data) back. */}
      {connected && (
      <div style={{ display: "flex", alignItems: "center", justifyContent: isMobile ? "space-between" : "flex-end", padding: isMobile ? "6px 10px" : "6px 18px", background: "#0f0f11", borderBottom: "1px solid #232327", flexWrap: "wrap", gap: 4 }}>
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
      )}
      {/* ── TAB BAR ── */}
      <div style={{ display: "flex", gap: 2, padding: isMobile ? "6px 8px" : "8px 16px", borderBottom: "1px solid #232327", background: "#0f0f11", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: isMobile ? 4 : 2, flex: 1, minWidth: 0, flexWrap: isMobile ? "wrap" : "nowrap", overflowX: isMobile ? "visible" : "auto", alignItems: "center" }}>
          {/* Desktop shows the phase spine; mobile keeps the equal-width wrap grid
              (phase labels would eat the row, and the order alone carries the loop). */}
          {tabGroups.map((group, gi) => (
            <div key={group.phase || `x${gi}`} style={{ display: "contents" }}>
              {!isMobile && gi > 0 && group.phase && (
                <span style={{
                  fontFamily: "var(--nx-font-mono)", fontSize: 7.5, letterSpacing: "0.24em",
                  color: "#3f3f46", flexShrink: 0, padding: "1px 12px 0 16px", alignSelf: "center",
                  borderLeft: "1px solid #1c1c20", textTransform: "uppercase",
                }}>{group.phase}</span>
              )}
              {group.items.map((tab) => {
                const active = activeTab === tab.id;
                return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              onMouseEnter={(e) => { if (!active && !isMobile) e.currentTarget.style.color = "#d4d4d8"; }}
              onMouseLeave={(e) => { if (!active && !isMobile) e.currentTarget.style.color = "#71717a"; }}
              style={isMobile ? {
                background: active ? "#1a1a1e" : "none",
                border: `1px solid ${active ? "#33333a" : "#232327"}`,
                color: active ? "#f4f4f5" : "#71717a",
                fontFamily: "var(--nx-font-mono)", fontSize: 10, letterSpacing: "0.06em", fontWeight: 600,
                padding: "6px 8px", cursor: "pointer", borderRadius: 4,
                minHeight: 36, flex: "1 0 21%", flexShrink: 1, whiteSpace: "nowrap",
              } : {
                background: "none", border: "none",
                borderBottom: `2px solid ${active ? "#ededf0" : "transparent"}`,
                color: active ? "#f4f4f5" : "#71717a",
                fontFamily: "var(--nx-font-ui)", fontSize: 12.5, letterSpacing: "0.01em",
                fontWeight: active ? 600 : 500,
                padding: "5px 13px 8px", cursor: "pointer", borderRadius: 0,
                whiteSpace: "nowrap", transition: "color 140ms ease",
              }}>{isMobile ? tab.short : tab.label}</button>
                );
              })}
            </div>
          ))}
          {/* Guest nav: a More toggle reveals the wallet-gated rooms without a full-screen funnel. */}
          {guestNav && (
            <button onClick={() => setShowAllTabs(true)} title="Show all Lab tools"
              style={isMobile ? {
                background: "none", border: "1px solid #232327", color: "#71717a",
                fontFamily: "var(--nx-font-mono)", fontSize: 10, letterSpacing: "0.06em", fontWeight: 600,
                padding: "6px 8px", cursor: "pointer", borderRadius: 4, minHeight: 36, flex: "1 0 21%", flexShrink: 1, whiteSpace: "nowrap",
              } : {
                background: "none", border: "none", borderBottom: "2px solid transparent", color: "#71717a",
                fontFamily: "var(--nx-font-ui)", fontSize: 12.5, letterSpacing: "0.01em", fontWeight: 500,
                padding: "5px 13px 8px", cursor: "pointer", whiteSpace: "nowrap",
              }}>{isMobile ? "MORE +" : "More +"}</button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0, marginLeft: 8 }}>
          {!isMobile && <SimCreditsBadge />}
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
      {/* Extra bottom padding on phones so the last board rows (and their → ) can scroll clear
          of the fixed bottom-right NEXUS AI FAB, instead of resting under it. */}
      <div style={{ padding: isMobile ? "12px 12px 88px" : 16 }}>
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
            {/* Lead with the call form + THE READ; the thesis analytics collapse below. */}
            <Collapsible title="◇ THESIS ANALYTICS" subtitle="how your calls have performed" storageKey="nx_thesis_analytics_open">
              <ThesisAnalyticsView />
            </Collapsible>
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
          const board = <DecisionBoard onSelectTab={setActiveTab} trades={connected ? processedTrades : undefined} wallet={rootWalletAddress} theses={connected ? theses : undefined} positions={connected ? briefingPositions : undefined} />;
          // Lead with the synthesis (Briefing narrative → the Board's one-line-per-market
          // read); the deep Market Intel (news, movers, OI, long/short) collapses so the
          // tab opens as a read, not a wall of rows.
          const deep = (
            <Collapsible title="◇ MARKET INTEL · DEEP DETAIL" subtitle="news, movers, OI, long/short, per-market" storageKey="nx_intel_deep_open">
              <MarketIntelView />
            </Collapsible>
          );
          // CATALYSTS — the event layer: world events mapped to the markets you can trade
          // here (geopolitics → CL, rates → NAS, risk → BTC/SPX). Between the Board and the
          // deep detail; on-moat because every event resolves to a tradeable, gradeable call.
          // ── THE LENSES · the deep "why" behind The Board ──────────────────────────
          // The one-spine fold: the intelligence layer is now a single linear funnel —
          // READ (Briefing) → BOARD (the fused scan) → LENSES (the deep boards The Board
          // summarizes) → TAPE (raw Market Intel). The Funding + Positioning boards moved
          // OFF the Smart Money tab (which is now purely the wallet drill-down) to live here
          // as the deep read behind the Board's Confluence strip — no more two competing
          // "synthesis" tabs. Each lens is a public read that The Board folds into one line.
          const lensesHeader = (
            <div style={{ marginTop: 32, marginBottom: 4, paddingTop: 10, borderTop: "1px solid #232327" }}>
              <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 3 }}>The lenses · the deep why</div>
              <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: 17, fontWeight: 700, color: "#a1a1aa", lineHeight: 1.15, letterSpacing: "-0.01em" }}>What The Board is reading</div>
              <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 11, color: "#71717a", marginTop: 4, lineHeight: 1.5 }}>Each lens is one column on The Board, opened up. Funding &amp; positioning are the tape; catalysts &amp; forecasters are the outside crowd.</div>
            </div>
          );
          const funding = (
            <Collapsible title="◇ FUNDING EDGES · ALL MARKETS" subtitle="every mispriced perp + which fades PAID vs which were a TRAP" storageKey="nx_funding_board_open">
              <MispricedBoard />
            </Collapsible>
          );
          const positioning = (
            <Collapsible title="◇ POSITIONING · CROWD vs SMART MONEY" subtitle="where the leveraged crowd and the sharp wallets disagree — on your edge" storageKey="nx_positioning_open">
              <PositioningBoard trades={connected ? processedTrades : undefined} />
            </Collapsible>
          );
          const catalysts = <div style={{ marginTop: 22 }}><CatalystBoard /></div>;
          // FORECAST DIVERGENCE — the prediction-market lens, restored but scoped to markets
          // you can trade here (our-markets-only until the Quotient feed lands). A tradeable,
          // gradeable call on a Nexus market. Fail-soft (renders a quiet line if sparse).
          // Collapsed by default so its charts are OFF the Intel first paint (expand to read) —
          // the first screen after the briefing is the ACTIONABLE board, not a wall of charts.
          const forecast = (
            <Collapsible title="◇ FORECAST DIVERGENCE" subtitle="where prediction markets disagree with price — our markets only" storageKey="nx_forecast_open">
              <ForecastDivergence />
            </Collapsible>
          );
          const lenses = <>{lensesHeader}{funding}{positioning}{catalysts}{forecast}</>;
          // The splash only greets a brand-new DISCONNECTED visitor who hasn't cleared
          // onboarding yet (in practice the full-screen modal covers this — it's a
          // defensive fallback). Everyone else — connected, or a guest/onboarded preview
          // — lands straight on the Briefing → Board → lenses read. No wallet needed to
          // scan the whole book; only COPY / PUBLISH / ARM LIVE ask for a connect.
          const showSplash = !connected && !guestPreview;
          return <>{showSplash && <LabWelcome />}{briefing}{board}{lenses}{deep}</>;
        })()}
        {activeTab === "smart" && (
          // Smart Money is now the DEEP WALLET DRILL-DOWN the Intel funnel's Positioning lens
          // links into — every tracked wallet, consensus, you-vs-smart, watchlist. The
          // crowd-vs-smart SYNTHESIS + the funding board moved into the Intel spine (the
          // Positioning + Funding lenses), so this tab no longer competes with The Board as a
          // second synthesis surface — it's the destination for the wallet-level detail.
          <SmartMoneyView myPositions={openPositions} />
        )}
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
          {connected && <CreatorEarnings address={rootWalletAddress} />}
          {connected && <NexusPro walletAddress={rootWalletAddress} />}
        </div>
      </div>
      <CommandPalette onSelectTab={setActiveTab} />
    </div>
  );
}
