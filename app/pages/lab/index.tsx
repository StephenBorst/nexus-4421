import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useIsMobile } from "./useIsMobile";
import { useCollateral, usePrivateQuery, useMutation, useAccount } from "@orderly.network/hooks";
import { useLabStorage } from "@/hooks/useLabStorage";
import { useLivePrices, calcUnrealizedPnl, distancePct } from "@/hooks/useLivePrices";
import { useThesisRegistry } from "@/hooks/useThesisRegistry";
import { HoldersRoom } from "@/components/HoldersRoom";
import { NexusMarket } from "@/components/NexusMarket";
import type { ThesisTrade, ThesisStatus, TabId, DayGroup, ProcessedTrade, AgentConfig, AgentState, AgentTrade, AgentLeaderboardEntry, AgentPendingThesis } from "./types";
import { DEFAULT_CONFIG } from "./types";
import IntelPage from "@/pages/intel";


// ─── Shared styles + helpers (extracted modules) ─────────
import { cardStyle, labelStyle, navBtnStyle, inputStyle, fieldLabelStyle, STATUS_CONFIG, CLOSED_STATUSES, agentCardStyle, agentLabelStyle, agentInputStyle, agentBtnStyle } from "./styles";
import { formatPnl, getDayKey, daysInMonth, firstDayOfMonth, MONTH_NAMES } from "./helpers";

import { PnlChart, EmptyState } from "./components";

import { AnalyticsView } from "./AnalyticsView";

// ─── Calendar View ───────────────────────────────────────
function CalendarView({ dayGroups, onDayClick, viewMonth, viewYear, onPrevMonth, onNextMonth, totalPnl }: { dayGroups: Record<string, DayGroup>; onDayClick: (key: string, day: number) => void; viewMonth: number; viewYear: number; onPrevMonth: () => void; onNextMonth: () => void; totalPnl: number; }) {
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const totalDays = daysInMonth(viewMonth, viewYear);
  const firstDay = firstDayOfMonth(viewMonth, viewYear);
  const today = new Date();
  const tradingDays = Object.keys(dayGroups).filter((k) => { const p = k.split("-"); return parseInt(p[1]) - 1 === viewMonth && parseInt(p[0]) === viewYear; }).length;
  const cells = Array.from({ length: 42 }, (_, i) => { const d = i - firstDay + 1; return d >= 1 && d <= totalDays ? d : null; });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button style={navBtnStyle} onClick={onPrevMonth}>&#8592;</button>
          <button style={{ ...navBtnStyle, background: "#00ff88", color: "#080c08", border: "none", fontWeight: "bold" }}>TODAY</button>
          <button style={navBtnStyle} onClick={onNextMonth}>&#8594;</button>
          <span style={{ fontSize: 20, color: "#00ff88", fontFamily: "monospace" }}>{MONTH_NAMES[viewMonth]} {viewYear}</span>
        </div>
        <div style={{ ...cardStyle, display: "flex", gap: 20, padding: "10px 16px" }}>
          <div><div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>{"// PNL"}</div><div style={{ fontSize: 16, color: totalPnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>{formatPnl(totalPnl)}</div></div>
          <div style={{ width: 1, background: "#1a2e1a" }} />
          <div><div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>{"// DAYS"}</div><div style={{ fontSize: 16, color: "#00ff88", fontFamily: "monospace" }}>{tradingDays}</div></div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
        {days.map((d) => <div key={d} style={{ fontSize: 10, color: "#3a5a4a", textAlign: "center", padding: "6px 0", fontFamily: "monospace" }}>{d}</div>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {cells.map((cellDay, i) => {
          if (!cellDay) return <div key={i} style={{ minHeight: 80 }} />;
          const key = `${viewYear}-${viewMonth + 1}-${cellDay}`;
          const data = dayGroups[key];
          const isToday = cellDay === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear();
          return (
            <div key={i} role={data ? "button" : undefined} tabIndex={data ? 0 : -1}
              onClick={() => data && onDayClick(key, cellDay)}
              onKeyDown={(e) => e.key === "Enter" && data && onDayClick(key, cellDay)}
              style={{ background: data ? "#0d120d" : "#0a0e0a", border: `1px solid ${isToday ? "#1a4a2a" : data ? "#1a3a1a" : "#121c12"}`, borderRadius: 4, minHeight: 80, padding: "6px 8px", cursor: data ? "pointer" : "default", fontFamily: "monospace" }}>
              <div style={{ fontSize: 11, color: "#3a5a4a" }}>{cellDay}</div>
              {data && <div>
                <div style={{ fontSize: 10, color: "#3a5a4a" }}>&#9632;</div>
                <div style={{ fontSize: 13, color: data.pnl >= 0 ? "#00ff88" : "#ff4444", fontWeight: "bold" }}>{formatPnl(data.pnl)}</div>
                <div style={{ fontSize: 9, color: "#3a5a4a" }}>{data.trades}T</div>
                <div style={{ fontSize: 9, color: "#3a5a4a" }}>{data.trades ? `${Math.round((data.wins / data.trades) * 100)}%` : ""}</div>
              </div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Trade Log All View ───────────────────────────────────
function TradeLogAllView({
  dayGroups,
  onDaySelect,
  notes,
  calendarProps,
}: {
  dayGroups: Record<string, DayGroup>;
  onDaySelect: (key: string, day: number) => void;
  notes: Record<string, string>;
  calendarProps: React.ComponentProps<typeof CalendarView>;
}) {
  const [filter, setFilter] = useState<"all" | "wins" | "losses">("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"list" | "calendar">("list");

  const sortedDays = useMemo(() =>
    Object.entries(dayGroups)
      .sort(([a], [b]) => {
        const toTs = (k: string) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
        return toTs(b) - toTs(a);
      }),
    [dayGroups]
  );

  const filtered = useMemo(() => sortedDays.filter(([key, g]) => {
    if (filter === "wins" && g.pnl < 0) return false;
    if (filter === "losses" && g.pnl >= 0) return false;
    if (search) {
      const syms = g.tradeList.map(t => t.symbol.replace("PERP_","").replace("_USDC","").toLowerCase());
      if (!syms.some(s => s.includes(search.toLowerCase())) && !key.includes(search)) return false;
    }
    return true;
  }), [sortedDays, filter, search]);

  const totalPnl = useMemo(() => sortedDays.reduce((s, [, g]) => s + g.pnl, 0), [sortedDays]);
  const totalTrades = useMemo(() => sortedDays.reduce((s, [, g]) => s + g.trades, 0), [sortedDays]);
  const winDays = useMemo(() => sortedDays.filter(([, g]) => g.pnl > 0).length, [sortedDays]);

  const formatKey = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  };

  const viewToggle = (
    <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
      {([
        { id: "list" as const, label: "▤ LIST" },
        { id: "calendar" as const, label: "▦ CALENDAR" },
      ]).map(({ id, label }) => (
        <button key={id} onClick={() => setView(id)} style={{
          ...navBtnStyle, fontSize: 10, padding: "5px 16px",
          color: view === id ? "#00ff88" : "#3a5a4a",
          borderColor: view === id ? "#1a4a2a" : "#1a2e1a",
          background: view === id ? "#0a2a0a" : "transparent",
        }}>{label}</button>
      ))}
    </div>
  );

  if (view === "calendar") {
    return (
      <div>
        {viewToggle}
        <CalendarView {...calendarProps} />
      </div>
    );
  }

  if (sortedDays.length === 0) {
    return (
      <div>
        {viewToggle}
        <EmptyState message="no closed trades found — connect wallet to load your trade history" />
      </div>
    );
  }

  return (
    <div>
      {viewToggle}
      {/* ── Summary bar ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginBottom: 16 }}>
        {[
          { label: "TOTAL PNL",   value: `${totalPnl >= 0 ? "+" : ""}$${Math.abs(totalPnl).toFixed(2)}`, color: totalPnl >= 0 ? "#00ff88" : "#ff4444" },
          { label: "TRADING DAYS", value: String(sortedDays.length),  color: "#4a9fff" },
          { label: "WIN DAYS",    value: `${winDays} / ${sortedDays.length}`, color: "#00ff88" },
          { label: "TOTAL TRADES", value: String(totalTrades),         color: "#a855f7" },
        ].map(r => (
          <div key={r.label} style={cardStyle}>
            <div style={labelStyle}>{r.label}</div>
            <div style={{ fontSize: 20, fontWeight: "bold", fontFamily: "monospace", color: r.color }}>{r.value}</div>
          </div>
        ))}
      </div>

      {/* ── Filters ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        {(["all", "wins", "losses"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            ...navBtnStyle, fontSize: 10, padding: "5px 14px",
            color: filter === f ? "#00ff88" : "#3a5a4a",
            borderColor: filter === f ? "#1a4a2a" : "#1a2e1a",
            background: filter === f ? "#0a2a0a" : "transparent",
          }}>{f.toUpperCase()}</button>
        ))}
        <input
          placeholder="search symbol or date…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, width: 220, padding: "5px 10px", fontSize: 11 }}
        />
      </div>

      {/* ── Day rows ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {filtered.map(([key, g]) => {
          const winRate = g.trades ? Math.round((g.wins / g.trades) * 100) : 0;
          const [, m, d] = key.split("-").map(Number);
          return (
            <div
              key={key}
              onClick={() => onDaySelect(key, d)}
              style={{
                ...cardStyle, cursor: "pointer", display: "grid",
                gridTemplateColumns: "180px 1fr repeat(4, 90px) 28px",
                alignItems: "center", gap: 12,
                borderColor: g.pnl >= 0 ? "#1a3a2a" : "#3a1a1a",
                transition: "background 0.15s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#101810")}
              onMouseLeave={e => (e.currentTarget.style.background = "#0d120d")}
            >
              {/* date */}
              <div>
                <div style={{ fontSize: 12, color: "#fff", fontFamily: "monospace", fontWeight: "bold" }}>{formatKey(key)}</div>
                {notes[key] && <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", marginTop: 2, fontStyle: "italic" }}>📝 note</div>}
              </div>
              {/* symbols */}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {[...new Set(g.tradeList.map(t => t.symbol.replace("PERP_","").replace("_USDC","")))].map(s => (
                  <span key={s} style={{ fontSize: 9, color: "#4a9fff", fontFamily: "monospace", background: "#0a1a2a", border: "1px solid #0a2a3a", borderRadius: 3, padding: "2px 6px" }}>{s}</span>
                ))}
              </div>
              {/* stats */}
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>PNL</div>
                <div style={{ fontSize: 14, fontWeight: "bold", fontFamily: "monospace", color: g.pnl >= 0 ? "#00ff88" : "#ff4444" }}>{g.pnl >= 0 ? "+" : ""}${Math.abs(g.pnl).toFixed(2)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>TRADES</div>
                <div style={{ fontSize: 14, fontFamily: "monospace", color: "#a855f7" }}>{g.trades}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>WIN RATE</div>
                <div style={{ fontSize: 14, fontFamily: "monospace", color: winRate >= 50 ? "#00ff88" : "#ff4444" }}>{winRate}%</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ height: 40, width: 4, background: "#1a2e1a", borderRadius: 2, display: "inline-block", position: "relative", verticalAlign: "middle" }}>
                  <div style={{ position: "absolute", bottom: 0, width: "100%", height: `${winRate}%`, background: g.pnl >= 0 ? "#00ff88" : "#ff4444", borderRadius: 2 }} />
                </div>
              </div>
              <div style={{ fontSize: 14, color: "#2a4a3a", fontFamily: "monospace", textAlign: "right" }}>›</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Trade Log View ──────────────────────────────────────
function TradeLogView({ dayKey, data, onBack, initialNote, onSaveNote }: {
  dayKey: string;
  data: DayGroup;
  onBack: () => void;
  initialNote?: string;
  onSaveNote?: (dayKey: string, note: string) => void;
}) {
  const [note, setNote] = useState(initialNote ?? localStorage.getItem(`lab_note_${dayKey}`) ?? "");
  const [saved, setSaved] = useState(false);
  const saveNote = () => {
    localStorage.setItem(`lab_note_${dayKey}`, note);
    onSaveNote?.(dayKey, note);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #1a2e1a" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "monospace" }}>
          <button onClick={onBack} style={{ ...navBtnStyle, fontSize: 12 }}>&#8592; BACK</button>
          <span style={{ fontSize: 13, color: "#00ff88" }}>&#9632; TRADING_LOG/{dayKey}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 9, color: "#3a5a4a", background: "#0d120d", border: "1px solid #1a2e1a", padding: "3px 8px", borderRadius: 3, fontFamily: "monospace" }}>{data.trades} TRADES</span>
          <div style={{ display: "flex", gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#ff5f57" }} />
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#febc2e" }} />
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#28c840" }} />
          </div>
        </div>
      </div>
      <div style={{ ...cardStyle, marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: "#3a5a4a", letterSpacing: "0.08em", marginBottom: 8, fontFamily: "monospace" }}>&#9632; NOTES</div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add notes about this trading day..."
          style={{ width: "100%", background: "#080c08", border: "1px solid #1a2e1a", borderRadius: 3, color: "#00ff88", fontFamily: "monospace", fontSize: 12, padding: "10px 12px", resize: "none", height: 80, outline: "none" }} />
        <button onClick={saveNote} style={{ ...navBtnStyle, marginTop: 8, color: saved ? "#00ff88" : "#3a6a4a" }}>
          &#9632; {saved ? "SAVED!" : "SAVE NOTE"}
        </button>
      </div>
      {data.tradeList.map((trade, i) => (
        <div key={i} style={{ ...cardStyle, marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 16, color: "#fff", fontWeight: "bold", fontFamily: "monospace" }}>{trade.symbol.replace("_USDC", "").replace("PERP_", "")}</div>
              <div style={{ fontSize: 10, color: trade.direction === "SHORT" ? "#ff4444" : "#00ff88", marginTop: 3, fontFamily: "monospace" }}>
                {trade.direction === "SHORT" ? "↓" : "↑"} {trade.direction} {trade.leverage ? `${trade.leverage}x` : ""}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, color: "#3a5a4a", letterSpacing: "0.08em", fontFamily: "monospace" }}>P&L</div>
              <div style={{ fontSize: 18, fontWeight: "bold", color: trade.pnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>{formatPnl(trade.pnl)}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 24, marginTop: 10 }}>
            <div><div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>ENTRY</div><div style={{ fontSize: 12, color: "#8aaa9a", fontFamily: "monospace" }}>${trade.entryPrice?.toFixed(2) ?? "—"}</div></div>
            <div><div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>EXIT</div><div style={{ fontSize: 12, color: "#8aaa9a", fontFamily: "monospace" }}>${trade.price.toFixed(2)}</div></div>
            <div><div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>QTY</div><div style={{ fontSize: 12, color: "#8aaa9a", fontFamily: "monospace" }}>{trade.qty}</div></div>
          </div>
          <div style={{ fontSize: 9, color: "#2a4a3a", marginTop: 8, fontFamily: "monospace" }}>{new Date(trade.timestamp).toLocaleTimeString()}</div>
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 12 }}>
        <div style={cardStyle}><div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>TOTAL P&L</div><div style={{ fontSize: 14, color: data.pnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>{formatPnl(data.pnl)}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>WIN RATE</div><div style={{ fontSize: 14, color: "#00ff88", fontFamily: "monospace" }}>{data.trades ? `${Math.round((data.wins / data.trades) * 100)}%` : "—"}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>TRADES</div><div style={{ fontSize: 14, color: "#00ff88", fontFamily: "monospace" }}>{data.trades}</div></div>
      </div>
    </div>
  );
}

import { ThesisView, ThesisAnalyticsView } from "./ThesisView";

// ─── Copies View ─────────────────────────────────────────
function CopiesView() {
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
        <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "monospace", letterSpacing: "0.12em", marginBottom: 4 }}>
          &#9632; COPY HISTORY — {copiedTheses.length} {copiedTheses.length === 1 ? "thesis" : "theses"} copied
        </div>
        <div style={{ fontSize: 11, color: "#3a5a4a", fontFamily: "monospace" }}>
        </div>
      </div>

      {copiedTheses.length === 0 ? (
        <EmptyState message="no copied theses yet — use COPY on any public thesis in the FEED" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {copiedTheses.map((t) => {
            const ticker = t.symbol.replace("PERP_", "").replace("_USDC", "");
            const cfg = STATUS_CONFIG[t.status];
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
                  <span style={{ fontFamily: "monospace", fontSize: 15, fontWeight: "bold", color: "#fff" }}>{ticker}</span>
                  <span style={{
                    fontFamily: "monospace", fontSize: 11,
                    color: t.direction === "LONG" ? "#00ff88" : "#ff4444",
                  }}>
                    {t.direction === "LONG" ? "↑" : "↓"} {t.direction}
                  </span>
                  <div style={{
                    fontFamily: "monospace", fontSize: 9, padding: "2px 8px", borderRadius: 3,
                    background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
                  }}>
                    {cfg.label}
                  </div>
                  {t.actualPnl !== null && t.status !== "ACTIVE" && (
                    <span style={{
                      fontFamily: "monospace", fontSize: 12, fontWeight: "bold",
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
                        color: "#3a5a4a", fontFamily: "monospace", fontSize: 9,
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
                      <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</div>
                      <div style={{ fontSize: 11, color, fontFamily: "monospace" }}>{val}</div>
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


// ─── News helpers ─────────────────────────────────────────
interface NewsItem { title: string; description: string; link: string; pubDate: string; source: string; category: string; }

function categorizeNews(title: string, desc: string): string {
  const t = (title + " " + desc).toLowerCase();
  if (/\b(fed|fomc|powell|interest rate|inflation|gdp|recession|economy|treasury|cpi|monetary)\b/.test(t)) return "MACRO";
  if (/\b(defi|dex|perpetual|protocol|yield|aave|uniswap|orderly|gmx|liquidity|onchain)\b/.test(t)) return "DEFI";
  if (/\b(geopolit|war|sanction|iran|russia|china|tariff|trade war|conflict|military)\b/.test(t)) return "GEOPOLITICS";
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|blockchain|altcoin|token|nft|web3)\b/.test(t)) return "CRYPTO";
  if (/\b(stocks|equity|nasdaq|s&p|dow|earnings|ipo|nyse|market cap|share)\b/.test(t)) return "MARKETS";
  return "NEWS";
}

async function fetchNewsFeed(url: string, sourceName: string): Promise<NewsItem[]> {
  try {
    const r = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}&count=10`);
    const d = await r.json();
    if (d.status !== "ok") return [];
    return (d.items as any[]).map((item: any) => ({
      title: item.title?.trim() ?? "",
      description: (item.description ?? "").replace(/<[^>]*>/g, "").slice(0, 240).trim(),
      link: item.link ?? "",
      pubDate: item.pubDate ?? "",
      source: sourceName,
      category: categorizeNews(item.title ?? "", item.description ?? ""),
    }));
  } catch { return []; }
}

function NewsTab() {
  const [items,     setItems]     = useState<NewsItem[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [filter,    setFilter]    = useState("ALL");
  const [countdown, setCountdown] = useState(300);
  const isMob = useIsMobile();

  const TEAL   = "#38d2c7", GREEN = "#29e9a9", RED = "#f5618b", YELLOW = "#ffd146";
  const DIM    = "rgba(255,255,255,0.35)", MUTED = "rgba(255,255,255,0.60)", BRIGHT = "rgba(255,255,255,0.87)";
  const CATS   = ["ALL", "CRYPTO", "MACRO", "DEFI", "MARKETS", "GEOPOLITICS"];
  const catClr = (c: string) => c === "MACRO" ? YELLOW : c === "DEFI" ? TEAL : c === "GEOPOLITICS" ? RED : c === "MARKETS" ? MUTED : GREEN;

  const FEEDS = [
    { url: "https://www.coindesk.com/arc/outboundfeeds/rss/",             name: "COINDESK"      },
    { url: "https://cointelegraph.com/rss",                               name: "COINTELEGRAPH" },
    { url: "https://decrypt.co/feed",                                     name: "DECRYPT"       },
    { url: "https://thedefiant.io/feed",                                  name: "THE DEFIANT"   },
    { url: "https://finance.yahoo.com/news/rssindex",                     name: "YAHOO FINANCE" },
  ];

  const load = async () => {
    setLoading(true);
    const results = await Promise.allSettled(FEEDS.map(f => fetchNewsFeed(f.url, f.name)));
    const all = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
    const seen = new Set<string>();
    const deduped = all
      .filter(i => { const k = i.title.slice(0, 50); if (seen.has(k)) return false; seen.add(k); return !!i.title; })
      .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
      .slice(0, 50);
    setItems(deduped);
    setLoading(false);
    setCountdown(300);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { const iv = setInterval(load, 300_000); return () => clearInterval(iv); }, []);
  useEffect(() => { const t = setInterval(() => setCountdown(c => c > 0 ? c - 1 : 300), 1000); return () => clearInterval(t); }, []);

  const ago = (d: string) => { const m = (Date.now() - new Date(d).getTime()) / 60000; return m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.round(m/60)}h` : `${Math.round(m/1440)}d`; };
  const shown = filter === "ALL" ? items : items.filter(i => i.category === filter);

  return (
    <div style={{ fontFamily: "'Courier New', Courier, monospace", color: BRIGHT, fontSize: 13 }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
        <span style={{ color: TEAL, fontSize: 10, letterSpacing: "0.12em" }}>// MARKET INTELLIGENCE FEED</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {loading
            ? <span style={{ color: TEAL, fontSize: 10 }}>⟳ CONNECTING</span>
            : <span style={{ color: DIM, fontSize: 10 }}>REFRESH {countdown}s</span>}
          <button onClick={load} style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", color: MUTED, fontFamily: "monospace", fontSize: 10, padding: "2px 8px", cursor: "pointer" }}>↻</button>
        </div>
      </div>

      {/* Category filter */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        {CATS.map(c => (
          <button key={c} onClick={() => setFilter(c)} style={{
            background: filter === c ? "rgba(56,210,199,0.08)" : "none",
            border: `1px solid ${filter === c ? TEAL : "rgba(255,255,255,0.08)"}`,
            color: filter === c ? TEAL : DIM,
            fontFamily: "monospace", fontSize: 10,
            padding: "3px 9px", cursor: "pointer", letterSpacing: "0.06em",
          }}>{c}</button>
        ))}
        <span style={{ color: DIM, fontSize: 10, marginLeft: "auto", alignSelf: "center" }}>{shown.length} stories</span>
      </div>

      {/* Loading state */}
      {loading && items.length === 0 && (
        <div style={{ color: DIM, padding: "40px 0", textAlign: "center", fontSize: 12 }}>
          CONNECTING TO FEEDS…<br />
          <span style={{ fontSize: 10, opacity: 0.5 }}>coindesk · cointelegraph · decrypt · the defiant · yahoo finance</span>
        </div>
      )}

      {/* Feed cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {shown.map((item, i) => (
          <a key={i} href={item.link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", display: "block" }}>
            <div
              style={{ padding: "10px 12px", background: "rgba(255,255,255,0.015)", border: "1px solid rgba(255,255,255,0.06)", cursor: "pointer" }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(56,210,199,0.28)")}
              onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)")}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5, gap: 8 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ color: catClr(item.category), fontSize: 9, letterSpacing: "0.1em", border: "1px solid currentColor", padding: "1px 5px" }}>{item.category}</span>
                  <span style={{ color: DIM, fontSize: 10 }}>{item.source}</span>
                </div>
                <span style={{ color: DIM, fontSize: 10, flexShrink: 0 }}>{ago(item.pubDate)}</span>
              </div>
              <div style={{ color: BRIGHT, fontWeight: 600, fontSize: isMob ? 12 : 13, lineHeight: 1.4, marginBottom: item.description ? 4 : 0 }}>{item.title}</div>
              {item.description && (
                <div style={{ color: MUTED, fontSize: 11, lineHeight: 1.5 }}>{item.description.slice(0, 180)}{item.description.length > 180 ? "…" : ""}</div>
              )}
            </div>
          </a>
        ))}
      </div>

      {!loading && shown.length === 0 && (
        <div style={{ color: DIM, padding: "20px 0", textAlign: "center", fontSize: 12 }}>No {filter} stories found in current feed.</div>
      )}

      <div style={{ color: DIM, fontSize: 10, marginTop: 12, letterSpacing: "0.05em" }}>
        // COINDESK · COINTELEGRAPH · DECRYPT · THE DEFIANT · YAHOO FINANCE · AUTO-REFRESH 5MIN
      </div>
    </div>
  );
}

// ─── AgentView ───────────────────────────────────────────
import { AgentView } from "./AgentView";

// ─── Main Page ───────────────────────────────────────────
// ─── Market Intel (Intel + News merged) ──────────────────
function MarketIntelView() {
  const [sub, setSub] = useState<"intel" | "news">("intel");
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {([
          { id: "intel" as const, label: "INTEL" },
          { id: "news" as const, label: "NEWS" },
        ]).map(({ id, label }) => (
          <button key={id} onClick={() => setSub(id)} style={{
            ...navBtnStyle, fontSize: 10, padding: "5px 16px",
            color: sub === id ? "#00ff88" : "#3a5a4a",
            borderColor: sub === id ? "#1a4a2a" : "#1a2e1a",
            background: sub === id ? "#0a2a0a" : "transparent",
          }}>{label}</button>
        ))}
      </div>
      {sub === "intel" ? <IntelPage embedded /> : <NewsTab />}
    </div>
  );
}

// ─── First-run Welcome (disconnected) ────────────────────
function LabWelcome() {
  const features = [
    { icon: "◈", title: "NEXUS THESIS ENGINE", desc: "Plan every trade — position sizing, R:R, funding cost, live P&L tracking, on-chain proof." },
    { icon: "⬢", title: "AUTO AGENT", desc: "Deploy an algo that trades funding edges for you. Hard risk caps, kill switch, order-only keys." },
    { icon: "▣", title: "ANALYTICS", desc: "Trading score, win-rate breakdowns, hold-time & leverage analysis — grade yourself like a desk." },
    { icon: "▤", title: "TRADE LOG", desc: "Full journal of every closed day with notes, filters, and a calendar heatmap." },
  ];
  return (
    <div style={{ padding: "32px 8px" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: "#00ff88", letterSpacing: "0.3em", marginBottom: 12, textShadow: "0 0 12px rgba(0,255,136,0.5)" }}>// THE LAB</div>
        <div style={{ fontFamily: "monospace", fontSize: 28, color: "#fff", fontWeight: "bold", marginBottom: 12, lineHeight: 1.25 }}>
          The trading terminal that<br />makes you a better trader.
        </div>
        <div style={{ fontFamily: "monospace", fontSize: 13, color: "#5a7a6a", maxWidth: 580, margin: "0 auto", lineHeight: 1.6 }}>
          Plan it, automate it, grade it. Most apps just let you trade — The Lab turns every
          position into a repeatable process. Connect your wallet to load your data and unlock every tool.
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, maxWidth: 760, margin: "0 auto 28px" }}>
        {features.map((f) => (
          <div key={f.title} style={{ ...cardStyle, padding: "16px 18px" }}>
            <div style={{ fontSize: 20, color: "#00ff88", marginBottom: 8 }}>{f.icon}</div>
            <div style={{ fontFamily: "monospace", fontSize: 12, color: "#fff", fontWeight: "bold", letterSpacing: "0.08em", marginBottom: 6 }}>{f.title}</div>
            <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5a7a6a", lineHeight: 1.5 }}>{f.desc}</div>
          </div>
        ))}
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "monospace", fontSize: 11, color: "#3a5a4a", border: "1px solid #1a2e1a", borderRadius: 4, padding: "10px 18px", background: "#0a0e0a" }}>
          <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#fbbf24", boxShadow: "0 0 8px #fbbf24", animation: "pulse 2s infinite" }} />
          Connect your wallet (top right) to load your trades and activate The Lab
        </div>
      </div>
    </div>
  );
}

// ─── Onboarding Activation Checklist ─────────────────────
function OnboardingChecklist({
  hasThesis,
  hasTrade,
  onGoThesis,
  onGoAnalytics,
}: {
  hasThesis: boolean;
  hasTrade: boolean;
  onGoThesis: () => void;
  onGoAnalytics: () => void;
}) {
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem("lab_onboard_dismissed") === "1"
  );
  if (dismissed) return null;

  const steps = [
    { key: "connect", label: "Connect your wallet", hint: "Your data is loading — you're in.", done: true, action: null },
    { key: "thesis",  label: "Plan your first thesis", hint: "Size a trade with R:R, stops & funding in the Nexus Thesis Engine.", done: hasThesis, action: onGoThesis, cta: "OPEN NEXUS THESIS ENGINE" },
    { key: "trade",   label: "Place your first trade", hint: "Trade anywhere on Nexus — it flows back here automatically.", done: hasTrade, action: null },
    { key: "grade",   label: "Grade your performance", hint: "See your trading score, breakdowns & journal.", done: hasTrade, action: onGoAnalytics, cta: "VIEW ANALYTICS" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;
  const pct = Math.round((doneCount / steps.length) * 100);

  const dismiss = () => {
    window.localStorage.setItem("lab_onboard_dismissed", "1");
    setDismissed(true);
  };

  return (
    <div style={{ ...cardStyle, marginBottom: 16, borderColor: allDone ? "#1a4a2a" : "#1a3a2a" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: "monospace", fontSize: 10, color: "#00ff88", letterSpacing: "0.12em" }}>
            {allDone ? "🎉 YOU'RE SET UP" : "// GET STARTED"}
          </span>
          <span style={{ fontFamily: "monospace", fontSize: 10, color: "#3a5a4a" }}>{doneCount}/{steps.length}</span>
        </div>
        <button onClick={dismiss} style={{ ...navBtnStyle, fontSize: 9, padding: "3px 10px", color: "#3a5a4a" }}>
          {allDone ? "DISMISS" : "SKIP"}
        </button>
      </div>
      <div style={{ height: 4, background: "#0a0e0a", borderRadius: 2, marginBottom: 14, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: "#00ff88", transition: "width 0.4s", boxShadow: "0 0 8px rgba(0,255,136,0.5)" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.map((s) => (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{
              width: 18, height: 18, borderRadius: "50%", flexShrink: 0,
              border: `1px solid ${s.done ? "#00ff88" : "#2a4a3a"}`,
              background: s.done ? "#00ff8820" : "transparent",
              color: s.done ? "#00ff88" : "#2a4a3a",
              fontFamily: "monospace", fontSize: 11, textAlign: "center", lineHeight: "17px",
            }}>{s.done ? "✓" : ""}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "monospace", fontSize: 12, color: s.done ? "#8aaa9a" : "#fff", textDecoration: s.done ? "line-through" : "none" }}>{s.label}</div>
              <div style={{ fontFamily: "monospace", fontSize: 10, color: "#3a5a4a", marginTop: 1 }}>{s.hint}</div>
            </div>
            {!s.done && s.action && (
              <button onClick={s.action} style={{ ...navBtnStyle, fontSize: 9, padding: "5px 12px", color: "#00ff88", borderColor: "#1a4a2a", flexShrink: 0 }}>
                {s.cta}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

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
