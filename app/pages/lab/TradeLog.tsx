// Trade Log tab — calendar heatmap + day-by-day journal (CalendarView is used
// internally by TradeLogAllView's list⇄calendar toggle). Extracted from index.tsx.
import { useState, useMemo } from "react";
import type { DayGroup } from "./types";
import { cardStyle, labelStyle, navBtnStyle, inputStyle } from "./styles";
import { formatPnl, daysInMonth, firstDayOfMonth, MONTH_NAMES } from "./helpers";
import { EmptyState } from "./components";
import { useIsMobile } from "./useIsMobile";

function CalendarView({ dayGroups, onDayClick, viewMonth, viewYear, onPrevMonth, onNextMonth, totalPnl }: { dayGroups: Record<string, DayGroup>; onDayClick: (key: string, day: number) => void; viewMonth: number; viewYear: number; onPrevMonth: () => void; onNextMonth: () => void; totalPnl: number; }) {
  const isMobile = useIsMobile();
  const cellH = isMobile ? 60 : 80; // fixed cell height → every day is the same size
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
          <button style={{ ...navBtnStyle, background: "#ededf0", color: "#0f0f11", border: "none", fontWeight: "bold" }}>TODAY</button>
          <button style={navBtnStyle} onClick={onNextMonth}>&#8594;</button>
          <span style={{ fontSize: 20, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{MONTH_NAMES[viewMonth]} {viewYear}</span>
        </div>
        <div style={{ ...cardStyle, display: "flex", gap: 20, padding: "10px 16px" }}>
          <div><div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{"// PNL"}</div><div style={{ fontSize: 16, color: totalPnl >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)" }}>{formatPnl(totalPnl)}</div></div>
          <div style={{ width: 1, background: "#232327" }} />
          <div><div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{"// DAYS"}</div><div style={{ fontSize: 16, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{tradingDays}</div></div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
        {days.map((d) => <div key={d} style={{ fontSize: 10, color: "#52525b", textAlign: "center", padding: "6px 0", fontFamily: "var(--nx-font-mono)" }}>{d}</div>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {cells.map((cellDay, i) => {
          if (!cellDay) return <div key={i} style={{ height: cellH }} />;
          const key = `${viewYear}-${viewMonth + 1}-${cellDay}`;
          const data = dayGroups[key];
          const isToday = cellDay === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear();
          return (
            <div key={i} role={data ? "button" : undefined} tabIndex={data ? 0 : -1}
              onClick={() => data && onDayClick(key, cellDay)}
              onKeyDown={(e) => e.key === "Enter" && data && onDayClick(key, cellDay)}
              style={{ background: data ? "#141416" : "#0a0a0b", border: `1px solid ${isToday ? "#33333a" : data ? "#232327" : "#141416"}`, borderRadius: 4, height: cellH, padding: isMobile ? "3px 4px" : "6px 8px", cursor: data ? "pointer" : "default", fontFamily: "var(--nx-font-mono)", overflow: "hidden", boxSizing: "border-box" }}>
              <div style={{ fontSize: isMobile ? 9 : 11, color: "#52525b" }}>{cellDay}</div>
              {data && (isMobile ? (
                <div>
                  <div style={{ fontSize: 10, color: data.pnl >= 0 ? "#3ecf8e" : "#f7525f", fontWeight: "bold", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{formatPnl(data.pnl)}</div>
                  <div style={{ fontSize: 8, color: "#52525b" }}>{data.trades}T · {data.trades ? `${Math.round((data.wins / data.trades) * 100)}%` : ""}</div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 10, color: "#52525b" }}>&#9632;</div>
                  <div style={{ fontSize: 13, color: data.pnl >= 0 ? "#3ecf8e" : "#f7525f", fontWeight: "bold" }}>{formatPnl(data.pnl)}</div>
                  <div style={{ fontSize: 9, color: "#52525b" }}>{data.trades}T</div>
                  <div style={{ fontSize: 9, color: "#52525b" }}>{data.trades ? `${Math.round((data.wins / data.trades) * 100)}%` : ""}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Trade Log All View ───────────────────────────────────
export function TradeLogAllView({
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
  const isMobile = useIsMobile();
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
          color: view === id ? "#ededf0" : "#52525b",
          borderColor: view === id ? "#33333a" : "#232327",
          background: view === id ? "#1a1a1e" : "transparent",
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
          { label: "TOTAL PNL",   value: `${totalPnl >= 0 ? "+" : ""}$${Math.abs(totalPnl).toFixed(2)}`, color: totalPnl >= 0 ? "#3ecf8e" : "#f7525f" },
          { label: "TRADING DAYS", value: String(sortedDays.length),  color: "#e8f0ea" },
          { label: "WIN DAYS",    value: `${winDays} / ${sortedDays.length}`, color: "#ededf0" },
          { label: "TOTAL TRADES", value: String(totalTrades),         color: "#e8f0ea" },
        ].map(r => (
          <div key={r.label} style={cardStyle}>
            <div style={labelStyle}>{r.label}</div>
            <div style={{ fontSize: 20, fontWeight: "bold", fontFamily: "var(--nx-font-mono)", color: r.color }}>{r.value}</div>
          </div>
        ))}
      </div>

      {/* ── Filters ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        {(["all", "wins", "losses"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            ...navBtnStyle, fontSize: 10, padding: "5px 14px",
            color: filter === f ? "#ededf0" : "#52525b",
            borderColor: filter === f ? "#33333a" : "#232327",
            background: filter === f ? "#1a1a1e" : "transparent",
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
      {/* Dense fixed-width rows — scroll horizontally on mobile instead of clipping */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowX: isMobile ? "auto" : "visible" }}>
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
                minWidth: isMobile ? 620 : undefined,
                alignItems: "center", gap: 12,
                borderColor: g.pnl >= 0 ? "#232327" : "#3a1a1a",
                transition: "background 0.15s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#101810")}
              onMouseLeave={e => (e.currentTarget.style.background = "#141416")}
            >
              {/* date */}
              <div>
                <div style={{ fontSize: 12, color: "#fff", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{formatKey(key)}</div>
                {notes[key] && <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginTop: 2, fontStyle: "italic" }}>📝 note</div>}
              </div>
              {/* symbols */}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {[...new Set(g.tradeList.map(t => t.symbol.replace("PERP_","").replace("_USDC","")))].map(s => (
                  <span key={s} style={{ fontSize: 9, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", background: "#141416", border: "1px solid #232327", borderRadius: 3, padding: "2px 6px" }}>{s}</span>
                ))}
              </div>
              {/* stats */}
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>PNL</div>
                <div style={{ fontSize: 14, fontWeight: "bold", fontFamily: "var(--nx-font-mono)", color: g.pnl >= 0 ? "#3ecf8e" : "#f7525f" }}>{g.pnl >= 0 ? "+" : ""}${Math.abs(g.pnl).toFixed(2)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>TRADES</div>
                <div style={{ fontSize: 14, fontFamily: "var(--nx-font-mono)", color: "#a1a1aa" }}>{g.trades}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>WIN RATE</div>
                <div style={{ fontSize: 14, fontFamily: "var(--nx-font-mono)", color: winRate >= 50 ? "#3ecf8e" : "#f7525f" }}>{winRate}%</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ height: 40, width: 4, background: "#232327", borderRadius: 2, display: "inline-block", position: "relative", verticalAlign: "middle" }}>
                  <div style={{ position: "absolute", bottom: 0, width: "100%", height: `${winRate}%`, background: g.pnl >= 0 ? "#3ecf8e" : "#f7525f", borderRadius: 2 }} />
                </div>
              </div>
              <div style={{ fontSize: 14, color: "#33333a", fontFamily: "var(--nx-font-mono)", textAlign: "right" }}>›</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Trade Log View ──────────────────────────────────────
export function TradeLogView({ dayKey, data, onBack, initialNote, onSaveNote }: {
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #232327" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--nx-font-mono)" }}>
          <button onClick={onBack} style={{ ...navBtnStyle, fontSize: 12 }}>&#8592; BACK</button>
          <span style={{ fontSize: 13, color: "#ededf0" }}>&#9632; TRADING_LOG/{dayKey}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 9, color: "#52525b", background: "#141416", border: "1px solid #232327", padding: "3px 8px", borderRadius: 3, fontFamily: "var(--nx-font-mono)" }}>{data.trades} TRADES</span>
          <div style={{ display: "flex", gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#ff5f57" }} />
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#febc2e" }} />
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#3ecf8e" }} />
          </div>
        </div>
      </div>
      <div style={{ ...cardStyle, marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: "#52525b", letterSpacing: "0.08em", marginBottom: 8, fontFamily: "var(--nx-font-mono)" }}>&#9632; NOTES</div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add notes about this trading day..."
          style={{ width: "100%", background: "#0f0f11", border: "1px solid #232327", borderRadius: 3, color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontSize: 12, padding: "10px 12px", resize: "none", height: 80, outline: "none" }} />
        <button onClick={saveNote} style={{ ...navBtnStyle, marginTop: 8, color: saved ? "#ededf0" : "#71717a" }}>
          &#9632; {saved ? "SAVED!" : "SAVE NOTE"}
        </button>
      </div>
      {data.tradeList.map((trade, i) => (
        <div key={i} style={{ ...cardStyle, marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 16, color: "#fff", fontWeight: "bold", fontFamily: "var(--nx-font-mono)" }}>{trade.symbol.replace("_USDC", "").replace("PERP_", "")}</div>
              <div style={{ fontSize: 10, color: trade.direction === "SHORT" ? "#f7525f" : "#3ecf8e", marginTop: 3, fontFamily: "var(--nx-font-mono)" }}>
                {trade.direction === "SHORT" ? "↓" : "↑"} {trade.direction} {trade.leverage ? `${trade.leverage}x` : ""}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, color: "#52525b", letterSpacing: "0.08em", fontFamily: "var(--nx-font-mono)" }}>P&L</div>
              <div style={{ fontSize: 18, fontWeight: "bold", color: trade.pnl >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)" }}>{formatPnl(trade.pnl)}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 24, marginTop: 10 }}>
            <div><div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>ENTRY</div><div style={{ fontSize: 12, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)" }}>${trade.entryPrice?.toFixed(2) ?? "—"}</div></div>
            <div><div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>EXIT</div><div style={{ fontSize: 12, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)" }}>${trade.price.toFixed(2)}</div></div>
            <div><div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>QTY</div><div style={{ fontSize: 12, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)" }}>{trade.qty}</div></div>
          </div>
          <div style={{ fontSize: 9, color: "#33333a", marginTop: 8, fontFamily: "var(--nx-font-mono)" }}>{new Date(trade.timestamp).toLocaleTimeString()}</div>
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 12 }}>
        <div style={cardStyle}><div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>TOTAL P&L</div><div style={{ fontSize: 14, color: data.pnl >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)" }}>{formatPnl(data.pnl)}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>WIN RATE</div><div style={{ fontSize: 14, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{data.trades ? `${Math.round((data.wins / data.trades) * 100)}%` : "—"}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 8, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>TRADES</div><div style={{ fontSize: 14, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{data.trades}</div></div>
      </div>
    </div>
  );
}
