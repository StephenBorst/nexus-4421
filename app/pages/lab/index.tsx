import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";

// ─── Responsive hook ──────────────────────────────────────
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
}
import { useCollateral, usePrivateQuery, useMutation, useAccount } from "@orderly.network/hooks";
import { useLabStorage } from "@/hooks/useLabStorage";
import { useLivePrices, calcUnrealizedPnl, distancePct } from "@/hooks/useLivePrices";
import { useThesisRegistry } from "@/hooks/useThesisRegistry";
import type { ThesisTrade, ThesisStatus } from "./types";
import IntelPage from "@/pages/intel";

// ─── Types ───────────────────────────────────────────────
type TabId = "analytics" | "calendar" | "tradelog" | "thesis" | "copies" | "thesisanalytics" | "intel";

interface DayGroup {
  pnl: number;
  trades: number;
  wins: number;
  tradeList: ProcessedTrade[];
}

interface ProcessedTrade {
  symbol: string;
  direction: "LONG" | "SHORT";
  side: string;
  pnl: number;
  qty: number;
  price: number;
  entryPrice?: number;
  timestamp: number;
  openTimestamp?: number;
  leverage?: number;
}

// ─── Thesis Types (imported from ./types) ─────────────────

// ─── Styles ──────────────────────────────────────────────
const cardStyle: React.CSSProperties = {
  background: "#0d120d",
  border: "1px solid #1a2e1a",
  borderRadius: 4,
  padding: "12px 14px",
};

const labelStyle: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: "0.12em",
  color: "#3a5a4a",
  marginBottom: 6,
  fontFamily: "monospace",
};

const navBtnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid #1a2e1a",
  color: "#4a7a5a",
  fontFamily: "monospace",
  fontSize: 11,
  padding: "5px 12px",
  cursor: "pointer",
  borderRadius: 3,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#080c08",
  border: "1px solid #1a2e1a",
  borderRadius: 3,
  color: "#00ff88",
  fontFamily: "monospace",
  fontSize: 12,
  padding: "8px 10px",
  outline: "none",
  boxSizing: "border-box",
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#3a5a4a",
  fontFamily: "monospace",
  letterSpacing: "0.1em",
  marginBottom: 4,
  display: "block",
};

// ─── Status Config ────────────────────────────────────────
const STATUS_CONFIG: Record<ThesisStatus, { label: string; color: string; bg: string; border: string }> = {
  ACTIVE:      { label: "ACTIVE",      color: "#4a9fff", bg: "#0a1a2a", border: "#1a3a5a" },
  HIT_TP:      { label: "HIT TP",      color: "#00ff88", bg: "#0a2a0a", border: "#1a4a2a" },
  STOPPED_OUT: { label: "STOPPED OUT", color: "#ff4444", bg: "#2a0a0a", border: "#4a1a1a" },
  INVALIDATED: { label: "INVALIDATED", color: "#fbbf24", bg: "#2a1a00", border: "#4a3a00" },
};

const CLOSED_STATUSES: ThesisStatus[] = ["HIT_TP", "STOPPED_OUT", "INVALIDATED"];

// ─── Helpers ─────────────────────────────────────────────
function formatPnl(val: number) {
  return `${val >= 0 ? "+" : ""}$${Math.abs(val).toFixed(2)}`;
}

function getDayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function daysInMonth(month: number, year: number) {
  return new Date(year, month + 1, 0).getDate();
}

function firstDayOfMonth(month: number, year: number) {
  return new Date(year, month, 1).getDay();
}

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

// ─── PnL Chart ───────────────────────────────────────────
function PnlChart({ points }: { points: number[] }) {
  if (points.length < 2) {
    return (
      <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: "#2a4a3a", fontFamily: "monospace", fontSize: 11 }}>
        no data yet
      </div>
    );
  }
  const w = 500; const h = 160;
  const min = Math.min(0, ...points);
  const max = Math.max(...points) || 1;
  const range = max - min || 1;
  const pts = points.map((v, i) => `${(i / (points.length - 1)) * w},${h - ((v - min) / range) * h * 0.9 + h * 0.05}`).join(" ");
  const lastY = h - ((points[points.length - 1] - min) / range) * h * 0.9 + h * 0.05;
  const firstY = h - ((points[0] - min) / range) * h * 0.9 + h * 0.05;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 160 }}>
      <polyline points={pts} fill="none" stroke="#00ff88" strokeWidth="2" />
      <circle cx={w} cy={lastY} r="5" fill="#00ff88" />
      <circle cx={0} cy={firstY} r="4" fill="#00ff88" fillOpacity="0.5" />
    </svg>
  );
}

// ─── Empty State ─────────────────────────────────────────
function EmptyState({ message }: { message: string }) {
  return (
    <div style={{ padding: "40px 0", textAlign: "center", color: "#2a4a3a", fontFamily: "monospace", fontSize: 12 }}>
      <div style={{ fontSize: 20, marginBottom: 8 }}>&#9632;</div>
      {message}
    </div>
  );
}

// ─── Radar Chart ─────────────────────────────────────────
function RadarChart({ scores }: { scores: { label: string; value: number }[] }) {
  const cx = 160; const cy = 160; const r = 120;
  const n = scores.length;
  const angleStep = (2 * Math.PI) / n;
  const getPoint = (i: number, radius: number) => {
    const angle = i * angleStep - Math.PI / 2;
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  };
  const gridLevels = [0.25, 0.5, 0.75, 1];
  const dataPoints = scores.map((s, i) => getPoint(i, (s.value / 100) * r));
  const dataPath = dataPoints.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ") + "Z";
  return (
    <svg viewBox="0 0 320 320" style={{ width: "100%", maxWidth: 280 }}>
      {gridLevels.map((level) => {
        const pts = scores.map((_, i) => getPoint(i, level * r));
        const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ") + "Z";
        return <path key={level} d={path} fill="none" stroke="#1a2e1a" strokeWidth="1" />;
      })}
      {scores.map((_, i) => {
        const p = getPoint(i, r);
        return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#1a2e1a" strokeWidth="1" />;
      })}
      <path d={dataPath} fill="#00ff88" fillOpacity="0.15" stroke="#00ff88" strokeWidth="2" />
      {dataPoints.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="4" fill="#00ff88" />)}
      {scores.map((s, i) => {
        const p = getPoint(i, r + 20);
        return <text key={i} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 10, fill: "#3a5a4a", fontFamily: "monospace" }}>{s.label}</text>;
      })}
      {scores.map((s, i) => {
        const p = getPoint(i, r - 16);
        return <text key={i} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 9, fill: "#00ff88", fontFamily: "monospace" }}>{s.value}</text>;
      })}
    </svg>
  );
}

// ─── Trading Score ────────────────────────────────────────
function TradingScoreSection({ orders, winRate }: { orders: ProcessedTrade[]; winRate: number }) {
  const metrics = useMemo(() => {
    if (!orders.length) return null;
    const wins = orders.filter((o) => o.pnl > 0);
    const losses = orders.filter((o) => o.pnl < 0);
    const avgWin = wins.length ? wins.reduce((s, o) => s + o.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, o) => s + o.pnl, 0) / losses.length) : 0.01;
    const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * (losses.length || 1)) : 99;
    const totalPnl = orders.reduce((s, o) => s + o.pnl, 0);
    let running = 0; let peak = 0; let maxDD = 0;
    orders.forEach((o) => { running += o.pnl; if (running > peak) peak = running; const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0; if (dd > maxDD) maxDD = dd; });
    const pnlValues = orders.map((o) => o.pnl);
    const mean = pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length;
    const variance = pnlValues.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / pnlValues.length;
    const stdDev = Math.sqrt(variance);
    const consistency = stdDev > 0 ? Math.max(0, 100 - (stdDev / Math.abs(mean || 1)) * 10) : 100;
    const recovery = totalPnl > 0 ? Math.min(100, (totalPnl / (maxDD || 1)) * 10) : 50;
    const winScore = Math.min(100, winRate);
    const pfScore = Math.min(100, profitFactor * 5);
    const wlScore = Math.min(100, (avgWin / (avgLoss || 1)) * 10);
    const ddScore = Math.max(0, 100 - maxDD * 5);
    const recScore = Math.min(100, recovery);
    const conScore = Math.min(100, consistency);
    const composite = winScore * 0.15 + pfScore * 0.25 + wlScore * 0.20 + ddScore * 0.20 + recScore * 0.10 + conScore * 0.10;
    const levsWithData = orders.filter((o) => o.leverage && o.leverage > 0);
    const avgLev = levsWithData.length ? levsWithData.reduce((s, o) => s + (o.leverage ?? 0), 0) / levsWithData.length : 0;
    const traderType = avgLev > 20 ? "DEGEN" : avgLev > 10 ? "SCALPER" : avgLev > 5 ? "SWING" : "POSITION";
    return {
      scores: [
        { label: "Win Rate", value: Math.round(winScore) },
        { label: "Profit Factor", value: Math.round(pfScore) },
        { label: "Win/Loss", value: Math.round(wlScore) },
        { label: "Recovery", value: Math.round(recScore) },
        { label: "Drawdown", value: Math.round(ddScore) },
        { label: "Consistency", value: Math.round(conScore) },
      ],
      composite: Math.round(composite),
      traderType,
      avgLev: avgLev.toFixed(1),
      details: [
        { label: "WIN %", weight: "15%", score: Math.round(winScore), raw: `${winRate.toFixed(1)}%` },
        { label: "PROFIT FACTOR", weight: "25%", score: Math.round(pfScore), raw: profitFactor.toFixed(2) },
        { label: "AVG W/L", weight: "20%", score: Math.round(wlScore), raw: (avgWin / (avgLoss || 1)).toFixed(2) },
        { label: "MAX DD", weight: "20%", score: Math.round(ddScore), raw: `${maxDD.toFixed(1)}%` },
        { label: "RECOVERY", weight: "10%", score: Math.round(recScore), raw: recovery.toFixed(2) },
        { label: "CONSISTENCY", weight: "10%", score: Math.round(conScore), raw: stdDev.toFixed(3) },
      ],
    };
  }, [orders, winRate]);

  if (!metrics) return <EmptyState message="connect wallet + make trades to see trading score" />;

  return (
    <div style={{ ...cardStyle, marginTop: 12 }}>
      <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 16, fontFamily: "monospace", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#3a5a4a" }}>&#9632;</span> TRADING SCORE
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 24, alignItems: "center" }}>
        <RadarChart scores={metrics.scores} />
        <div>
          <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 4 }}>COMPOSITE SCORE</div>
          <div style={{ fontSize: 64, fontWeight: "bold", color: "#00ff88", fontFamily: "monospace", lineHeight: 1 }}>{metrics.composite}</div>
          <div style={{ height: 4, background: "#1a2e1a", borderRadius: 2, margin: "10px 0 16px" }}>
            <div style={{ height: 4, background: "#00ff88", borderRadius: 2, width: `${metrics.composite}%` }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            {metrics.details.map((d) => (
              <div key={d.label} style={{ background: "#0a0e0a", border: "1px solid #1a2e1a", borderRadius: 4, padding: "8px 10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>{d.label}</span>
                  <span style={{ fontSize: 8, color: "#2a4a3a", fontFamily: "monospace" }}>{d.weight}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontSize: 16, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>{d.score}</span>
                  <span style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace" }}>/100 {d.raw}</span>
                </div>
                <div style={{ height: 3, background: "#1a2e1a", borderRadius: 2, marginTop: 6 }}>
                  <div style={{ height: 3, background: d.score > 80 ? "#00ff88" : d.score > 50 ? "#fbbf24" : "#ff4444", borderRadius: 2, width: `${d.score}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ background: "#0a0e0a", border: "1px solid #1a3a2a", borderRadius: 3, padding: "5px 12px", fontSize: 11, color: "#00ff88", fontFamily: "monospace" }}>{metrics.traderType}</div>
            <div style={{ background: "#0a0e0a", border: "1px solid #1a3a2a", borderRadius: 3, padding: "5px 12px", fontSize: 11, color: "#00ff88", fontFamily: "monospace" }}>{metrics.avgLev}X AVG LEV</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Breakdown Row ────────────────────────────────────────
function BreakdownRow({ orders }: { orders: ProcessedTrade[] }) {
  const holdTime = useMemo(() => {
    const buckets = [
      { label: "<1h", maxMs: 3600000, pnl: 0, count: 0, wins: 0 },
      { label: "1-4h", maxMs: 14400000, pnl: 0, count: 0, wins: 0 },
      { label: "4-12h", maxMs: 43200000, pnl: 0, count: 0, wins: 0 },
      { label: "12-24h", maxMs: 86400000, pnl: 0, count: 0, wins: 0 },
      { label: "1-3d", maxMs: 259200000, pnl: 0, count: 0, wins: 0 },
      { label: "3d+", maxMs: Infinity, pnl: 0, count: 0, wins: 0 },
    ];
    orders.forEach((o) => {
      if (!o.openTimestamp || !o.timestamp) return;
      const held = o.timestamp - o.openTimestamp;
      const bucket = buckets.find((b, i) => {
        const prev = i === 0 ? 0 : buckets[i - 1].maxMs;
        return held >= prev && held < b.maxMs;
      });
      if (bucket) { bucket.count++; bucket.pnl += o.pnl; if (o.pnl > 0) bucket.wins++; }
    });
    return buckets;
  }, [orders]);

  const weekday = useMemo(() => {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const data = days.map((d) => ({ label: d, trades: 0, wins: 0, pnl: 0 }));
    orders.forEach((o) => {
      const day = new Date(o.timestamp).getDay();
      data[day].trades++; data[day].pnl += o.pnl;
      if (o.pnl > 0) data[day].wins++;
    });
    const weekdayTrades = data.slice(1, 6).reduce((s, d) => s + d.trades, 0);
    const weekdayWins = data.slice(1, 6).reduce((s, d) => s + d.wins, 0);
    const weekendTrades = [data[0], data[6]].reduce((s, d) => s + d.trades, 0);
    const weekendWins = [data[0], data[6]].reduce((s, d) => s + d.wins, 0);
    return {
      days: data,
      weekdayWR: weekdayTrades ? ((weekdayWins / weekdayTrades) * 100).toFixed(1) : "0.0",
      weekendWR: weekendTrades ? ((weekendWins / weekendTrades) * 100).toFixed(1) : "0.0",
    };
  }, [orders]);

  const leverage = useMemo(() => {
    const levsWithData = orders.filter((o) => o.leverage && o.leverage > 0);
    const avgLev = levsWithData.length ? levsWithData.reduce((s, o) => s + (o.leverage ?? 0), 0) / levsWithData.length : 0;
    const buckets = [
      { label: "1-5x", min: 1, max: 5, trades: 0, wins: 0, pnl: 0 },
      { label: "5-10x", min: 5, max: 10, trades: 0, wins: 0, pnl: 0 },
      { label: "10-25x", min: 10, max: 25, trades: 0, wins: 0, pnl: 0 },
      { label: "25-50x", min: 25, max: 50, trades: 0, wins: 0, pnl: 0 },
      { label: "50x+", min: 50, max: Infinity, trades: 0, wins: 0, pnl: 0 },
    ];
    levsWithData.forEach((o) => {
      const b = buckets.find((b) => (o.leverage ?? 0) >= b.min && (o.leverage ?? 0) < b.max);
      if (b) { b.trades++; b.pnl += o.pnl; if (o.pnl > 0) b.wins++; }
    });
    return { buckets: buckets.filter((b) => b.trades > 0), avgLev: avgLev.toFixed(1) };
  }, [orders]);

  const maxDayTrades = Math.max(...weekday.days.map((d) => d.trades), 1);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 8 }}>
      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#fbbf24", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; HOLD TIME</div>
        {holdTime.map((b) => (
          <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace", width: 40 }}>{b.label}</div>
            <div style={{ flex: 1, height: 20, background: "#0a0e0a", borderRadius: 3, overflow: "hidden" }}>
              {b.count > 0 && (
                <div style={{ height: "100%", background: "#1a4a2a", width: `${(b.count / orders.length) * 100}%`, display: "flex", alignItems: "center", paddingLeft: 6 }}>
                  <span style={{ fontSize: 9, color: "#00ff88", fontFamily: "monospace" }}>{b.count} ({Math.round((b.count / orders.length) * 100)}%)</span>
                </div>
              )}
            </div>
            <div style={{ fontSize: 10, color: b.pnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", width: 44, textAlign: "right" }}>
              {b.count > 0 ? formatPnl(b.pnl) : "+$0"}
            </div>
          </div>
        ))}
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#4a9fff", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; WEEKDAY BREAKDOWN</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 80, marginBottom: 12 }}>
          {weekday.days.map((d) => (
            <div key={d.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              {d.trades > 0 && <div style={{ fontSize: 8, color: "#00ff88", fontFamily: "monospace" }}>{Math.round((d.wins / d.trades) * 100)}%</div>}
              <div style={{ width: "100%", height: d.trades > 0 ? `${(d.trades / maxDayTrades) * 60}px` : "4px", background: d.trades > 0 ? "#1a4a2a" : "#0a150a", borderRadius: 3, border: "1px solid #1a3a1a" }} />
              <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>{d.label}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div><div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>WEEKDAY WR</div><div style={{ fontSize: 16, color: "#00ff88", fontFamily: "monospace" }}>{weekday.weekdayWR}%</div></div>
          <div style={{ textAlign: "right" }}><div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>WEEKEND WR</div><div style={{ fontSize: 16, color: parseFloat(weekday.weekendWR) > 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>{weekday.weekendWR}%</div></div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#a855f7", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; LEVERAGE ANALYSIS</div>
        {leverage.buckets.length === 0
          ? <div style={{ fontSize: 11, color: "#2a4a3a", fontFamily: "monospace" }}>no leverage data available</div>
          : leverage.buckets.map((b) => (
            <div key={b.label} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: "#fff", fontFamily: "monospace" }}>{b.label}</span>
                <span style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace" }}>{b.trades} trades {b.trades ? `${Math.round((b.wins / b.trades) * 100)}%` : ""}</span>
              </div>
              <div style={{ height: 4, background: "#1a2e1a", borderRadius: 2 }}>
                <div style={{ height: 4, background: "#fbbf24", borderRadius: 2, width: `${(b.trades / orders.length) * 100}%` }} />
              </div>
              <div style={{ fontSize: 10, color: b.pnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", marginTop: 3 }}>{formatPnl(b.pnl)}</div>
            </div>
          ))
        }
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #1a2e1a", display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>AVG LEVERAGE</span>
          <span style={{ fontSize: 16, color: "#fbbf24", fontFamily: "monospace" }}>{leverage.avgLev}x</span>
        </div>
      </div>
    </div>
  );
}

// ─── Top Assets ───────────────────────────────────────────
function TopAssets({ orders }: { orders: ProcessedTrade[] }) {
  const assets = useMemo(() => {
    const map: Record<string, { pnl: number; trades: number; wins: number }> = {};
    orders.forEach((o) => {
      const sym = o.symbol.replace("PERP_", "").replace("_USDC", "");
      if (!map[sym]) map[sym] = { pnl: 0, trades: 0, wins: 0 };
      map[sym].pnl += o.pnl; map[sym].trades++;
      if (o.pnl > 0) map[sym].wins++;
    });
    return Object.entries(map).sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl)).slice(0, 6);
  }, [orders]);

  if (!assets.length) return null;

  return (
    <div style={{ ...cardStyle, marginTop: 8 }}>
      <div style={{ fontSize: 10, color: "#4a9fff", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; TOP ASSETS</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
        {assets.map(([sym, data]) => {
          const wr = Math.round((data.wins / data.trades) * 100);
          return (
            <div key={sym} style={{ background: "#0a0e0a", border: "1px solid #1a2e1a", borderRadius: 4, padding: "10px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: "#fff", fontWeight: "bold", fontFamily: "monospace" }}>{sym}</span>
                <span style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace" }}>{data.trades}</span>
              </div>
              <div style={{ fontSize: 16, color: data.pnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontWeight: "bold", marginBottom: 8 }}>{formatPnl(data.pnl)}</div>
              <div style={{ height: 3, background: "#1a2e1a", borderRadius: 2, marginBottom: 4 }}>
                <div style={{ height: 3, background: wr > 50 ? "#00ff88" : "#ff4444", borderRadius: 2, width: `${wr}%` }} />
              </div>
              <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>{wr}% WR</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Performance Analysis ─────────────────────────────────
function PerformanceAnalysis({ orders }: { orders: ProcessedTrade[] }) {
  const data = useMemo(() => {
    if (!orders.length) return null;
    const sorted = [...orders].sort((a, b) => b.pnl - a.pnl);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    const longs = orders.filter((o) => o.direction === "LONG");
    const shorts = orders.filter((o) => o.direction === "SHORT");
    const longWins = longs.filter((o) => o.pnl > 0).length;
    const shortWins = shorts.filter((o) => o.pnl > 0).length;
    return { best, worst, longs, shorts, longWins, shortWins };
  }, [orders]);

  if (!data) return null;

  const bestSym = data.best.symbol.replace("PERP_", "").replace("_USDC", "");
  const worstSym = data.worst.symbol.replace("PERP_", "").replace("_USDC", "");

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; PERFORMANCE ANALYSIS</div>
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 9, color: "#00ff88", fontFamily: "monospace", marginBottom: 4 }}>Best Trade</div>
          <div style={{ background: "#0a150a", border: "1px solid #1a3a1a", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 14, color: "#fff", fontWeight: "bold", fontFamily: "monospace" }}>{bestSym} {data.best.direction.toLowerCase()}</span>
              <span style={{ fontSize: 16, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>{formatPnl(data.best.pnl)}</span>
            </div>
            {data.best.leverage && <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace", marginTop: 4 }}>{data.best.leverage}x leverage</div>}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: "#ff4444", fontFamily: "monospace", marginBottom: 4 }}>Worst Trade</div>
          <div style={{ background: "#150a0a", border: "1px solid #3a1a1a", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 14, color: "#fff", fontWeight: "bold", fontFamily: "monospace" }}>{worstSym} {data.worst.direction.toLowerCase()}</span>
              <span style={{ fontSize: 16, color: "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>{formatPnl(data.worst.pnl)}</span>
            </div>
            {data.worst.leverage && <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace", marginTop: 4 }}>{data.worst.leverage}x leverage</div>}
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; LONG vs SHORT</div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "#8aaa9a", fontFamily: "monospace" }}>Long Trades</span>
            <span style={{ fontSize: 12, color: "#3a5a4a", fontFamily: "monospace" }}>{data.longs.length} trades</span>
          </div>
          <div style={{ height: 6, background: "#1a2e1a", borderRadius: 3, marginBottom: 4 }}>
            <div style={{ height: 6, background: data.longs.length ? "#4a9fff" : "#1a2e1a", borderRadius: 3, width: `${data.longs.length ? (data.longWins / data.longs.length) * 100 : 0}%` }} />
          </div>
          <div style={{ fontSize: 11, color: "#3a5a4a", fontFamily: "monospace" }}>{data.longs.length ? `${Math.round((data.longWins / data.longs.length) * 100)}%` : "0%"}</div>
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "#8aaa9a", fontFamily: "monospace" }}>Short Trades</span>
            <span style={{ fontSize: 12, color: "#3a5a4a", fontFamily: "monospace" }}>{data.shorts.length} trades</span>
          </div>
          <div style={{ height: 6, background: "#1a2e1a", borderRadius: 3, marginBottom: 4 }}>
            <div style={{ height: 6, background: data.shorts.length ? "#00ff88" : "#1a2e1a", borderRadius: 3, width: `${data.shorts.length ? (data.shortWins / data.shorts.length) * 100 : 0}%` }} />
          </div>
          <div style={{ fontSize: 11, color: "#3a5a4a", fontFamily: "monospace" }}>{data.shorts.length ? `${Math.round((data.shortWins / data.shorts.length) * 100)}%` : "0%"}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Analytics View ──────────────────────────────────────
function AnalyticsView({ orders, totalPnl, winRate, collateral }: { orders: ProcessedTrade[]; totalPnl: number; winRate: number; collateral: number; }) {
  const volume = useMemo(() => orders.reduce((s, o) => s + o.qty * o.price, 0), [orders]);
  const avgWin = useMemo(() => { const w = orders.filter((o) => o.pnl > 0); return w.length ? w.reduce((s, o) => s + o.pnl, 0) / w.length : 0; }, [orders]);
  const avgLoss = useMemo(() => { const l = orders.filter((o) => o.pnl < 0); return l.length ? Math.abs(l.reduce((s, o) => s + o.pnl, 0) / l.length) : 0; }, [orders]);
  const bestTrade = useMemo(() => Math.max(0, ...orders.map((o) => o.pnl)), [orders]);
  const worstTrade = useMemo(() => Math.min(0, ...orders.map((o) => o.pnl)), [orders]);
  const cumulativePnl = useMemo(() => { let r = 0; return [0, ...orders.map((o) => { r += o.pnl; return r; })]; }, [orders]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 8 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>TOTAL PNL</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "monospace", color: totalPnl >= 0 ? "#00ff88" : "#ff4444" }}>{formatPnl(totalPnl)}</div>
          <div style={{ fontSize: 10, color: "#3a5a4a", marginTop: 4, fontFamily: "monospace" }}>realized</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>WIN RATE</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "monospace", color: "#4a9fff" }}>{orders.length ? `${winRate.toFixed(1)}%` : "—"}</div>
          <div style={{ height: 4, background: "#1a2e1a", borderRadius: 2, marginTop: 8 }}><div style={{ height: 4, background: "#4a9fff", borderRadius: 2, width: `${winRate}%` }} /></div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>TRADES</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "monospace", color: "#a855f7" }}>{orders.length}</div>
          <div style={{ fontSize: 10, color: "#3a5a4a", marginTop: 4, fontFamily: "monospace" }}>closed</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>BALANCE</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "monospace", color: "#fbbf24" }}>{collateral > 0 ? `$${collateral.toFixed(2)}` : "—"}</div>
          <div style={{ fontSize: 10, color: "#3a5a4a", marginTop: 4, fontFamily: "monospace" }}>usdc</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 240px", gap: 8, marginBottom: 8 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>&#9632; P&amp;L OVER TIME</div>
          {orders.length ? <PnlChart points={cumulativePnl} /> : <EmptyState message="connect wallet + make trades to see curve" />}
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: 10, color: "#4a9fff", letterSpacing: "0.1em", marginBottom: 14, fontFamily: "monospace" }}>PERFORMANCE</div>
          {[
            { label: "AVG WIN", value: orders.length ? `$${avgWin.toFixed(2)}` : "—" },
            { label: "AVG LOSS", value: orders.length ? `$${avgLoss.toFixed(2)}` : "—" },
            { label: "BEST TRADE", value: orders.length ? `$${bestTrade.toFixed(2)}` : "—" },
            { label: "WORST TRADE", value: orders.length ? `$${Math.abs(worstTrade).toFixed(2)}` : "—" },
            { label: "VOLUME", value: volume > 0 ? `$${volume.toFixed(0)}` : "—" },
          ].map((r) => (
            <div key={r.label} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: "#3a5a4a", letterSpacing: "0.08em", fontFamily: "monospace" }}>{r.label}</div>
              <div style={{ fontSize: 18, color: "#00ff88", fontFamily: "monospace" }}>{r.value}</div>
            </div>
          ))}
        </div>
      </div>

      <TradingScoreSection orders={orders} winRate={winRate} />
      <BreakdownRow orders={orders} />
      <PerformanceAnalysis orders={orders} />
      <TopAssets orders={orders} />

      {orders.length === 0 && <EmptyState message="no closed trades found — connect wallet to load your data" />}
    </div>
  );
}

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
          <span style={{ fontSize: 13, color: "#00ff88" }}>&#9632; TRADE_LOG/{dayKey}</span>
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 12 }}>
        <div style={cardStyle}><div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>TOTAL P&L</div><div style={{ fontSize: 14, color: data.pnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>{formatPnl(data.pnl)}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>WIN RATE</div><div style={{ fontSize: 14, color: "#00ff88", fontFamily: "monospace" }}>{data.trades ? `${Math.round((data.wins / data.trades) * 100)}%` : "—"}</div></div>
        <div style={cardStyle}><div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>TRADES</div><div style={{ fontSize: 14, color: "#00ff88", fontFamily: "monospace" }}>{data.trades}</div></div>
      </div>
    </div>
  );
}

// ─── Thesis Calculator ────────────────────────────────────
function calcThesis(form: {
  entryPrice: string; stopLoss: string; takeProfit1: string; takeProfit2: string;
  riskPercent: string; accountSize: string; fundingRate: string; direction: "LONG" | "SHORT";
}) {
  const entry = parseFloat(form.entryPrice);
  const stop = parseFloat(form.stopLoss);
  const tp1 = parseFloat(form.takeProfit1);
  const account = parseFloat(form.accountSize);
  const riskPct = parseFloat(form.riskPercent);
  const funding = parseFloat(form.fundingRate);
  if (!entry || !stop || !tp1 || !account || !riskPct) return null;
  const riskAmount = account * (riskPct / 100);
  const stopDistancePct = Math.abs((entry - stop) / entry);
  if (stopDistancePct === 0) return null;
  const positionSize = riskAmount / stopDistancePct;
  const leverage = positionSize / account;
  const rewardDistance = Math.abs((tp1 - entry) / entry);
  const riskReward = rewardDistance / stopDistancePct;
  const fundingPerPeriod = positionSize * (Math.abs(funding) / 100);
  return {
    positionSize: Math.min(positionSize, account * 100),
    leverage: Math.min(leverage, 100),
    riskReward, riskAmount,
    fundingCost8h: fundingPerPeriod,
    fundingCost24h: fundingPerPeriod * 3,
    fundingCost72h: fundingPerPeriod * 9,
  };
}

// ─── Thesis Card ──────────────────────────────────────────
function ThesisCard({ t, onUpdate, onRemove, walletAddress, isMobile, markPrice }: {
  t: ThesisTrade;
  onUpdate: (id: string, patch: Partial<ThesisTrade>) => void;
  onRemove: (id: string) => void;
  walletAddress?: string | null;
  isMobile?: boolean;
  markPrice?: number | null;
}) {
  const [actualInput, setActualInput] = useState(t.actualPnl !== null ? String(t.actualPnl) : "");
  const [inputVisible, setInputVisible] = useState(false);
  const cfg = STATUS_CONFIG[t.status];
  const isClosed = CLOSED_STATUSES.includes(t.status);

  const handleStatusClick = (s: ThesisStatus) => {
    const next = t.status === s ? "ACTIVE" : s;
    onUpdate(t.id, { status: next });
    if (CLOSED_STATUSES.includes(next)) setInputVisible(true);
    else setInputVisible(false);
  };

  const saveActual = () => {
    const val = parseFloat(actualInput);
    if (!isNaN(val)) onUpdate(t.id, { actualPnl: val });
    setInputVisible(false);
  };

  const plannedPnl = t.riskReward * (t.riskPercent / 100) * t.accountSize;
  const accuracy = t.actualPnl !== null && plannedPnl !== 0
    ? Math.min(200, Math.max(0, (t.actualPnl / plannedPnl) * 100))
    : null;

  return (
    <div style={{
      ...cardStyle,
      border: `1px solid ${cfg.border}`,
      background: isClosed ? "#0a0c0a" : "#0d120d",
      opacity: t.status === "INVALIDATED" ? 0.7 : 1,
    }}>
      {/* Top row */}
      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "stretch" : "flex-start", justifyContent: "space-between", marginBottom: 10, gap: isMobile ? 10 : 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flex: 1, minWidth: 0 }}>
          <div style={{ minWidth: 52 }}>
            <div style={{ fontSize: 16, color: "#fff", fontWeight: "bold", fontFamily: "monospace" }}>{t.symbol.replace("PERP_","").replace("_USDC","")}</div>
            <div style={{ fontSize: 10, color: t.direction === "LONG" ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>
              {t.direction === "LONG" ? "↑" : "↓"} {t.direction} · {t.leverage.toFixed(1)}x
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(3, 1fr)" : "repeat(6, auto)", gap: isMobile ? "8px 12px" : "0 16px", flex: 1 }}>
            {[
              { label: "ENTRY", val: `$${t.entryPrice.toFixed(2)}` },
              { label: "STOP", val: `$${t.stopLoss.toFixed(2)}`, color: "#ff4444" },
              { label: "TP1", val: `$${t.takeProfit1.toFixed(2)}`, color: "#00ff88" },
              { label: "SIZE", val: `$${t.positionSize.toFixed(0)}` },
              { label: "R:R", val: `1:${t.riskReward.toFixed(2)}`, color: t.riskReward >= 2 ? "#00ff88" : "#fbbf24" },
              { label: "72H FUND", val: `$${t.fundingCost72h.toFixed(3)}`, color: "#fbbf24" },
            ].map(({ label, val, color }) => (
              <div key={label}>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</div>
                <div style={{ fontSize: 12, color: color ?? "#8aaa9a", fontFamily: "monospace" }}>{val}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: isMobile ? "row" : "column", alignItems: isMobile ? "center" : "flex-end", justifyContent: isMobile ? "space-between" : "flex-start", gap: 6, flexShrink: 0 }}>
          {!isMobile && <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace" }}>{new Date(t.createdAt).toLocaleDateString()}</div>}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {t.status === "ACTIVE" && walletAddress && (
              <a
                href={`https://t.me/nexustradinglabs_bot?start=${walletAddress.toLowerCase()}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...navBtnStyle, fontSize: 10, color: "#29b6f6", borderColor: "#0a2a3a", textDecoration: "none", display: "inline-block", textAlign: "center", minHeight: 36, lineHeight: "22px", padding: "6px 12px" }}
              >
                🔔 ALERTS
              </a>
            )}
            <button
              onClick={() => onUpdate(t.id, { isPublic: !t.isPublic })}
              title={t.isPublic ? "Click to make private" : "Click to publish to feed"}
              style={{
                ...navBtnStyle, fontSize: 10, minHeight: 36, padding: "6px 12px",
                color: t.isPublic ? "#00ff88" : "#3a5a4a",
                borderColor: t.isPublic ? "#1a4a2a" : "#1a2e1a",
                background: t.isPublic ? "#0a2a0a" : "transparent",
              }}
            >
              {t.isPublic ? "📡 PUBLIC" : "📡 PRIVATE"}
            </button>
            <button onClick={() => onRemove(t.id)} style={{ ...navBtnStyle, fontSize: 10, color: "#ff4444", borderColor: "#2a1a1a", minHeight: 36, padding: "6px 12px" }}>REMOVE</button>
          </div>
        </div>
      </div>

      {/* Status buttons */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {(Object.keys(STATUS_CONFIG) as ThesisStatus[]).map((s) => {
          const c = STATUS_CONFIG[s];
          const active = t.status === s;
          return (
            <button key={s} onClick={() => handleStatusClick(s)} style={{
              fontFamily: "monospace", fontSize: 9, padding: "6px 12px",
              cursor: "pointer", borderRadius: 3, letterSpacing: "0.06em",
              minHeight: 32,
              border: `1px solid ${active ? c.border : "#1a2e1a"}`,
              background: active ? c.bg : "transparent",
              color: active ? c.color : "#2a4a3a",
            }}>{c.label}</button>
          );
        })}
      </div>

      {/* Live P&L — only shown for ACTIVE theses with a mark price */}
      {t.status === "ACTIVE" && markPrice != null && (() => {
        const { pnl, pct } = calcUnrealizedPnl(t.direction, t.entryPrice, markPrice, t.positionSize);
        const toSL = distancePct(markPrice, t.stopLoss);
        const toTP = distancePct(markPrice, t.takeProfit1);
        const isWinning = pnl >= 0;
        return (
          <div style={{ borderTop: "1px solid #1a2e1a", paddingTop: 10, marginBottom: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: "8px 16px" }}>
              <div>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 2 }}>MARK PRICE</div>
                <div style={{ fontSize: 13, color: "#fff", fontFamily: "monospace", fontWeight: "bold" }}>
                  ${markPrice.toFixed(markPrice < 10 ? 4 : 2)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 2 }}>UNREALIZED P&L</div>
                <div style={{ fontSize: 13, fontFamily: "monospace", fontWeight: "bold", color: isWinning ? "#00ff88" : "#ff4444" }}>
                  {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                  <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.7 }}>({pct >= 0 ? "+" : ""}{pct.toFixed(2)}%)</span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 2 }}>TO SL</div>
                <div style={{ fontSize: 13, color: "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>
                  {toSL.toFixed(2)}%
                </div>
              </div>
              <div>
                <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 2 }}>TO TP1</div>
                <div style={{ fontSize: 13, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>
                  {toTP.toFixed(2)}%
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Actual P&L — only shown when closed */}
      {isClosed && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, paddingTop: 8, borderTop: "1px solid #1a2e1a" }}>
          <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", whiteSpace: "nowrap" }}>ACTUAL P&L</div>
          {t.actualPnl !== null && !inputVisible ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 16, color: t.actualPnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>
                {formatPnl(t.actualPnl)}
              </div>
              {accuracy !== null && (
                <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace" }}>
                  {accuracy.toFixed(0)}% of plan
                </div>
              )}
              <button onClick={() => setInputVisible(true)} style={{ ...navBtnStyle, fontSize: 9, padding: "3px 8px" }}>EDIT</button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="number"
                placeholder="e.g. 142.50 or -87.00"
                value={actualInput}
                onChange={(e) => setActualInput(e.target.value)}
                style={{ ...inputStyle, width: 180, padding: "5px 8px", fontSize: 11 }}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
              />
              <button onClick={saveActual} style={{ ...navBtnStyle, fontSize: 10, color: "#00ff88", borderColor: "#1a4a2a" }}>SAVE</button>
              {t.actualPnl !== null && (
                <button onClick={() => setInputVisible(false)} style={{ ...navBtnStyle, fontSize: 10 }}>CANCEL</button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Notes */}
      {t.notes && (
        <div style={{ marginTop: 6, paddingTop: 8, borderTop: "1px solid #1a2e1a", fontSize: 11, color: "#3a5a4a", fontFamily: "monospace", fontStyle: "italic" }}>
          &quot;{t.notes}&quot;
        </div>
      )}
    </div>
  );
}

// ─── Thesis Analytics Section ─────────────────────────────
function ThesisAnalyticsSection({ trades }: { trades: ThesisTrade[] }) {
  const closedTrades = trades.filter((t) => CLOSED_STATUSES.includes(t.status));
  const withPnl = closedTrades.filter((t) => t.actualPnl !== null);

  if (closedTrades.length === 0) return null;

  const hits = trades.filter((t) => t.status === "HIT_TP").length;
  const stoppedOut = trades.filter((t) => t.status === "STOPPED_OUT").length;
  const invalidated = trades.filter((t) => t.status === "INVALIDATED").length;
  const winRate = closedTrades.length ? Math.round((hits / closedTrades.length) * 100) : 0;
  const totalActualPnl = withPnl.reduce((s, t) => s + (t.actualPnl ?? 0), 0);

  const sortedByPnl = [...withPnl].sort((a, b) => (b.actualPnl ?? 0) - (a.actualPnl ?? 0));
  const bestThesis = sortedByPnl[0] ?? null;
  const worstThesis = sortedByPnl.length > 1 ? sortedByPnl[sortedByPnl.length - 1] : null;

  const sortedByDate = [...withPnl].sort((a, b) => a.createdAt - b.createdAt);
  let running = 0;
  const cumulativePoints = [0, ...sortedByDate.map((t) => { running += (t.actualPnl ?? 0); return running; })];

  return (
    <div style={{ marginTop: 16, marginBottom: 16 }}>
      {/* Breakdown Card */}
      <div style={{ ...cardStyle, marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 16, fontFamily: "monospace" }}>
          <span style={{ color: "#3a5a4a" }}>&#9632;</span> ACCURACY BREAKDOWN
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
          <div style={{ background: "#0a150a", border: "1px solid #1a4a2a", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 6 }}>HIT TP</div>
            <div style={{ fontSize: 28, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>{hits}</div>
          </div>
          <div style={{ background: "#150a0a", border: "1px solid #4a1a1a", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 6 }}>STOPPED OUT</div>
            <div style={{ fontSize: 28, color: "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>{stoppedOut}</div>
          </div>
          <div style={{ background: "#150e00", border: "1px solid #4a3a00", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 6 }}>INVALIDATED</div>
            <div style={{ fontSize: 28, color: "#fbbf24", fontFamily: "monospace", fontWeight: "bold" }}>{invalidated}</div>
          </div>
          <div style={{ background: "#0a0e0a", border: "1px solid #1a3a5a", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 6 }}>WIN RATE</div>
            <div style={{ fontSize: 28, color: "#4a9fff", fontFamily: "monospace", fontWeight: "bold" }}>{winRate}%</div>
            <div style={{ height: 3, background: "#1a2e1a", borderRadius: 2, marginTop: 8 }}>
              <div style={{ height: 3, background: "#4a9fff", borderRadius: 2, width: `${winRate}%` }} />
            </div>
          </div>
          <div style={{ background: "#0a0e0a", border: `1px solid ${totalActualPnl >= 0 ? "#1a4a2a" : "#4a1a1a"}`, borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", marginBottom: 6 }}>TOTAL ACTUAL P&amp;L</div>
            <div style={{ fontSize: 22, color: totalActualPnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>
              {withPnl.length > 0 ? formatPnl(totalActualPnl) : "—"}
            </div>
            {withPnl.length > 0 && (
              <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace", marginTop: 4 }}>{withPnl.length} logged</div>
            )}
          </div>
        </div>
      </div>

      {/* Best / Worst + Cumulative Chart */}
      {withPnl.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {/* Best Thesis */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; BEST THESIS</div>
            {bestThesis ? (
              <>
                <div style={{ background: "#0a150a", border: "1px solid #1a3a1a", borderRadius: 4, padding: "10px 12px", marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                    <span style={{ fontSize: 15, color: "#fff", fontWeight: "bold", fontFamily: "monospace" }}>{bestThesis.symbol}</span>
                    <span style={{ fontSize: 16, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>{formatPnl(bestThesis.actualPnl ?? 0)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ fontSize: 10, color: bestThesis.direction === "LONG" ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>
                      {bestThesis.direction === "LONG" ? "↑" : "↓"} {bestThesis.direction}
                    </div>
                    <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace" }}>1:{bestThesis.riskReward.toFixed(2)} R:R</div>
                  </div>
                </div>
                <div style={{ fontSize: 9, color: STATUS_CONFIG[bestThesis.status].color, fontFamily: "monospace", letterSpacing: "0.06em" }}>
                  {STATUS_CONFIG[bestThesis.status].label}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "#2a4a3a", fontFamily: "monospace" }}>no P&L logged yet</div>
            )}
          </div>

          {/* Worst Thesis */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#ff4444", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; WORST THESIS</div>
            {worstThesis ? (
              <>
                <div style={{ background: "#150a0a", border: "1px solid #3a1a1a", borderRadius: 4, padding: "10px 12px", marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                    <span style={{ fontSize: 15, color: "#fff", fontWeight: "bold", fontFamily: "monospace" }}>{worstThesis.symbol}</span>
                    <span style={{ fontSize: 16, color: "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>{formatPnl(worstThesis.actualPnl ?? 0)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ fontSize: 10, color: worstThesis.direction === "LONG" ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>
                      {worstThesis.direction === "LONG" ? "↑" : "↓"} {worstThesis.direction}
                    </div>
                    <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace" }}>1:{worstThesis.riskReward.toFixed(2)} R:R</div>
                  </div>
                </div>
                <div style={{ fontSize: 9, color: STATUS_CONFIG[worstThesis.status].color, fontFamily: "monospace", letterSpacing: "0.06em" }}>
                  {STATUS_CONFIG[worstThesis.status].label}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "#2a4a3a", fontFamily: "monospace" }}>
                {withPnl.length === 1 ? "need 2+ results" : "no P&L logged yet"}
              </div>
            )}
          </div>

          {/* Cumulative Thesis P&L Chart */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 4, fontFamily: "monospace" }}>&#9632; THESIS P&amp;L</div>
            <PnlChart points={cumulativePoints} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>{sortedByDate.length} results plotted</div>
              <div style={{ fontSize: 10, color: totalActualPnl >= 0 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>{formatPnl(totalActualPnl)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Thesis Analytics View ───────────────────────────────
function ThesisAnalyticsView() {
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;
  const { theses } = useLabStorage(walletAddress);

  const closed = useMemo(
    () => theses.filter((t) => t.status === "HIT_TP" || t.status === "STOPPED_OUT"),
    [theses]
  );

  const summaryStats = useMemo(() => {
    const wins = closed.filter((t) => t.status === "HIT_TP").length;
    const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
    const avgRR = theses.length > 0 ? theses.reduce((s, t) => s + t.riskReward, 0) / theses.length : 0;
    const totalPnl = closed.reduce((s, t) => s + (t.actualPnl ?? 0), 0);
    return { total: theses.length, winRate, avgRR, totalPnl };
  }, [theses, closed]);

  const equityPoints = useMemo(() => {
    const sorted = [...closed].sort((a, b) => a.createdAt - b.createdAt);
    let running = 0;
    return sorted.map((t) => { running += (t.actualPnl ?? 0); return running; });
  }, [closed]);

  const streaks = useMemo(() => {
    const sortedDesc = [...closed].sort((a, b) => b.createdAt - a.createdAt);
    let current = 0;
    for (const t of sortedDesc) {
      if (t.status === "HIT_TP") current++;
      else break;
    }
    const sortedAsc = [...closed].sort((a, b) => a.createdAt - b.createdAt);
    let best = 0;
    let streak = 0;
    for (const t of sortedAsc) {
      if (t.status === "HIT_TP") { streak++; if (streak > best) best = streak; }
      else streak = 0;
    }
    return { current, best };
  }, [closed]);

  const assetStats = useMemo(() => {
    const map = new Map<string, { wins: number; total: number; rrSum: number }>();
    for (const t of closed) {
      const sym = t.symbol.replace("PERP_", "").replace("_USDC", "");
      if (!map.has(sym)) map.set(sym, { wins: 0, total: 0, rrSum: 0 });
      const s = map.get(sym)!;
      s.total++;
      if (t.status === "HIT_TP") s.wins++;
      s.rrSum += t.riskReward;
    }
    return [...map.entries()]
      .map(([sym, s]) => ({
        sym,
        winRate: (s.wins / s.total) * 100,
        total: s.total,
        avgRR: s.rrSum / s.total,
      }))
      .sort((a, b) => b.winRate - a.winRate);
  }, [closed]);

  const bestAssets = assetStats.slice(0, 5);
  const worstAssets = [...assetStats].reverse().slice(0, 3);

  if (!walletAddress) {
    return <EmptyState message="connect wallet to view thesis analytics" />;
  }

  const endVal = equityPoints.length > 0 ? equityPoints[equityPoints.length - 1] : 0;
  const lineColor = endVal >= 0 ? "#00ff88" : "#ff4444";

  const renderEquityCurve = () => {
    if (equityPoints.length < 2) {
      return (
        <div style={{ padding: "20px 0", fontFamily: "monospace", fontSize: 11, color: "#2a4a3a" }}>
          Not enough data yet.
        </div>
      );
    }
    const w = 500; const svgH = 120;
    const allPoints = [0, ...equityPoints];
    const minV = Math.min(...allPoints);
    const maxV = Math.max(...allPoints);
    const range = maxV - minV || 1;
    const n = allPoints.length;
    const toY = (v: number) => svgH - ((v - minV) / range) * svgH * 0.85 + svgH * 0.075;
    const pts = allPoints.map((v, i) => `${(i / (n - 1)) * w},${toY(v)}`).join(" ");
    const zeroY = toY(0);
    const lastY = toY(equityPoints[equityPoints.length - 1]);
    return (
      <svg viewBox={`0 0 ${w} ${svgH}`} style={{ width: "100%", height: 120 }}>
        <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="#1a2e1a" strokeWidth="1" strokeDasharray="4,4" />
        <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="2" />
        <circle cx={w} cy={lastY} r="4" fill={lineColor} />
      </svg>
    );
  };

  const assetRow = (a: { sym: string; winRate: number; total: number; avgRR: number }, i: number, maxIdx: number) => (
    <div
      key={a.sym}
      style={{
        display: "grid", gridTemplateColumns: "1fr 54px 40px 54px", gap: 8,
        padding: "5px 0",
        borderBottom: i < maxIdx ? "1px solid #0f1f0f" : "none",
        alignItems: "center",
      }}
    >
      <span style={{ fontFamily: "monospace", fontSize: 11, color: "#fff" }}>{a.sym}</span>
      <span style={{ fontFamily: "monospace", fontSize: 11, textAlign: "right", color: a.winRate >= 50 ? "#00ff88" : "#ff4444" }}>
        {a.winRate.toFixed(0)}%
      </span>
      <span style={{ fontFamily: "monospace", fontSize: 10, textAlign: "right", color: "#3a5a4a" }}>{a.total}</span>
      <span style={{ fontFamily: "monospace", fontSize: 10, textAlign: "right", color: a.avgRR >= 2 ? "#00ff88" : "#fbbf24" }}>
        1:{a.avgRR.toFixed(1)}
      </span>
    </div>
  );

  const tableHeader = () => (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 54px 40px 54px", gap: 8, marginBottom: 6 }}>
      {["SYMBOL", "WR", "N", "AVG R:R"].map((col) => (
        <span key={col} style={{ fontSize: 8, color: "#2a4a3a", fontFamily: "monospace", textAlign: col !== "SYMBOL" ? "right" : "left" }}>
          {col}
        </span>
      ))}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Summary stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
        {[
          { label: "TOTAL THESES", val: summaryStats.total.toString(), color: "#8aaa9a" as string },
          {
            label: "WIN RATE",
            val: closed.length > 0 ? `${summaryStats.winRate.toFixed(1)}%` : "—",
            color: (closed.length > 0 ? (summaryStats.winRate >= 50 ? "#00ff88" : "#ff4444") : "#3a5a4a") as string,
          },
          {
            label: "AVG R:R",
            val: theses.length > 0 ? `1:${summaryStats.avgRR.toFixed(2)}` : "—",
            color: (theses.length > 0 ? (summaryStats.avgRR >= 2 ? "#00ff88" : "#fbbf24") : "#3a5a4a") as string,
          },
          {
            label: "TOTAL P&L",
            val: closed.length > 0 ? `${summaryStats.totalPnl >= 0 ? "+" : ""}$${Math.abs(summaryStats.totalPnl).toFixed(2)}` : "—",
            color: (closed.length > 0 ? (summaryStats.totalPnl >= 0 ? "#00ff88" : "#ff4444") : "#3a5a4a") as string,
          },
        ].map(({ label, val, color }) => (
          <div key={label} style={cardStyle}>
            <div style={labelStyle}>{label}</div>
            <div style={{ fontFamily: "monospace", fontSize: 22, fontWeight: "bold", color }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Equity curve */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <span style={{ fontFamily: "monospace", fontSize: 10, color: "#00ff88", letterSpacing: "0.1em" }}>◆ EQUITY CURVE</span>
          {equityPoints.length >= 2 && (
            <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: "bold", color: lineColor }}>
              {summaryStats.totalPnl >= 0 ? "+" : ""}${Math.abs(summaryStats.totalPnl).toFixed(2)}
            </span>
          )}
        </div>
        {renderEquityCurve()}
      </div>

      {/* Streak + best/worst markets */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {/* Win streak */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#fbbf24", letterSpacing: "0.1em", marginBottom: 14 }}>◆ WIN STREAK</div>
          <div style={{ marginBottom: 14 }}>
            <div style={labelStyle}>CURRENT STREAK</div>
            <div style={{ fontFamily: "monospace", fontSize: 28, fontWeight: "bold", color: streaks.current > 0 ? "#00ff88" : "#2a4a3a" }}>
              {streaks.current}
              <span style={{ fontFamily: "monospace", fontSize: 12, color: "#3a5a4a", marginLeft: 6 }}>wins</span>
            </div>
          </div>
          <div>
            <div style={labelStyle}>BEST STREAK</div>
            <div style={{ fontFamily: "monospace", fontSize: 22, fontWeight: "bold", color: streaks.best > 0 ? "#00ff88" : "#2a4a3a" }}>
              {streaks.best}
              <span style={{ fontFamily: "monospace", fontSize: 12, color: "#3a5a4a", marginLeft: 6 }}>wins</span>
            </div>
          </div>
        </div>

        {/* Best markets */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 10 }}>◆ BEST MARKETS</div>
          {bestAssets.length === 0 ? (
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#2a4a3a" }}>no closed theses yet</div>
          ) : (
            <>
              {tableHeader()}
              {bestAssets.map((a, i) => assetRow(a, i, bestAssets.length - 1))}
            </>
          )}
        </div>

        {/* Worst markets */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#ff4444", letterSpacing: "0.1em", marginBottom: 10 }}>◆ WORST MARKETS</div>
          {worstAssets.length === 0 ? (
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#2a4a3a" }}>no closed theses yet</div>
          ) : (
            <>
              {tableHeader()}
              {worstAssets.map((a, i) => assetRow(a, i, worstAssets.length - 1))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Thesis View ──────────────────────────────────────────
function ThesisView() {
  const isMobile = useIsMobile();
  const { state: accountState } = useAccount();
  const walletAddress = (accountState as { address?: string })?.address ?? null;
  const { theses: trades, saveTheses } = useLabStorage(walletAddress);
  const { registerOnChain, closeOnChain } = useThesisRegistry();

  // Live prices for all active theses
  const activeSymbols = useMemo(
    () => [...new Set(trades.filter((t) => t.status === "ACTIVE").map((t) => t.symbol))],
    [trades]
  );
  const livePrices = useLivePrices(activeSymbols);

  const [form, setForm] = useState({
    symbol: "",
    direction: "LONG" as "LONG" | "SHORT",
    entryPrice: "",
    stopLoss: "",
    takeProfit1: "",
    takeProfit2: "",
    riskPercent: "1.5",
    accountSize: "",
    fundingRate: "0.01",
    notes: "",
  });


  const [deployed, setDeployed] = useState(false);
  const [filter, setFilter] = useState<ThesisStatus | "ALL">("ALL");

  // ── Live execution ──────────────────────────────────────
  const [doOrder] = useMutation("/v1/order", "POST");
  const [doAlgoOrder] = useMutation("/v1/algo/order", "POST");
  const [liveConfirm, setLiveConfirm] = useState(false);
  const [liveStatus, setLiveStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [liveError, setLiveError] = useState<string | null>(null);
  const isWalletReady = !!(accountState && (accountState as { status?: number }).status !== undefined && (accountState as { status?: number }).status !== 0);

  const calc = useMemo(() => calcThesis(form), [form]);
  const set = (field: string, value: string) => setForm((f) => ({ ...f, [field]: value }));

  const persist = (updated: ThesisTrade[]) => saveTheses(updated);

  const buildThesisTrade = (id?: string): ThesisTrade => ({
    id: id ?? Date.now().toString(),
    symbol: form.symbol.toUpperCase(),
    direction: form.direction,
    entryPrice: parseFloat(form.entryPrice),
    stopLoss: parseFloat(form.stopLoss),
    takeProfit1: parseFloat(form.takeProfit1),
    takeProfit2: parseFloat(form.takeProfit2) || 0,
    riskPercent: parseFloat(form.riskPercent),
    accountSize: parseFloat(form.accountSize),
    fundingRate: parseFloat(form.fundingRate),
    notes: form.notes,
    createdAt: Date.now(),
    positionSize: calc!.positionSize,
    leverage: calc!.leverage,
    riskReward: calc!.riskReward,
    fundingCost8h: calc!.fundingCost8h,
    fundingCost24h: calc!.fundingCost24h,
    fundingCost72h: calc!.fundingCost72h,
    status: "ACTIVE",
    actualPnl: null,
  });

  const resetForm = () =>
    setForm((f) => ({ ...f, symbol: "", entryPrice: "", stopLoss: "", takeProfit1: "", takeProfit2: "", notes: "" }));

  const deployPaper = () => {
    if (!calc || !form.symbol) return;
    persist([buildThesisTrade(), ...trades]);
    setDeployed(true);
    setTimeout(() => setDeployed(false), 2500);
    resetForm();
  };

  const deployLive = async () => {
    if (!calc || !form.symbol) return;
    setLiveConfirm(false);
    setLiveStatus("submitting");
    setLiveError(null);

    const symbol = `PERP_${form.symbol.toUpperCase()}_USDC`;
    const side = form.direction === "LONG" ? "BUY" : "SELL";
    const closeSide = form.direction === "LONG" ? "SELL" : "BUY";

    // Fetch step size and snap quantity to valid increment
    let baseTick = 0.0001;
    try {
      const infoRes = await fetch(`https://api-evm.orderly.org/v1/public/info/${symbol}`);
      const infoJson = await infoRes.json();
      baseTick = infoJson?.data?.base_tick ?? 0.0001;
    } catch { /* fallback to default */ }

    const rawQty = calc.positionSize / parseFloat(form.entryPrice);
    const qty = Math.floor(rawQty / baseTick) * baseTick;
    // Round to avoid floating-point noise
    const precision = Math.max(0, -Math.floor(Math.log10(baseTick)));
    const snappedQty = parseFloat(qty.toFixed(precision));

    if (snappedQty <= 0) {
      setLiveStatus("error");
      setLiveError(`Position too small — minimum order size for ${form.symbol.toUpperCase()} is ${baseTick}`);
      return;
    }

    try {
      // Step 1 — entry limit order
      await (doOrder as (data: unknown) => Promise<unknown>)({
        symbol,
        order_type: "LIMIT",
        side,
        order_price: parseFloat(form.entryPrice),
        order_quantity: snappedQty,
        order_tag: "nexus_thesis",
      });

      // Step 2 — positional TP/SL bracket
      await (doAlgoOrder as (data: unknown) => Promise<unknown>)({
        symbol,
        algo_type: "POSITIONAL_TP_SL",
        side: closeSide,
        quantity: snappedQty,
        tp_trigger_price: String(parseFloat(form.takeProfit1)),
        tp_order_type: "LIMIT",
        tp_order_price: String(parseFloat(form.takeProfit1)),
        sl_trigger_price: String(parseFloat(form.stopLoss)),
        sl_order_type: "MARKET",
      });

      persist([buildThesisTrade(`live_${Date.now()}`), ...trades]);
      setLiveStatus("success");
      resetForm();
      setTimeout(() => setLiveStatus("idle"), 4000);
    } catch (err: unknown) {
      setLiveStatus("error");
      setLiveError(err instanceof Error ? err.message : "order failed — check console");
    }
  };

  const updateTrade = async (id: string, patch: Partial<ThesisTrade>) => {
    const thesis = trades.find((t) => t.id === id);
    if (!thesis) return;

    // Publishing to feed for the first time → register on-chain
    if (patch.isPublic === true && !thesis.isPublic && !thesis.onChainId) {
      console.log("[ThesisRegistry] attempting registerOnChain for thesis:", thesis.id, thesis.symbol);
      const mergedThesis = { ...thesis, ...patch };
      try {
        const result = await registerOnChain(mergedThesis);
        console.log("[ThesisRegistry] registerOnChain result:", result);
        if (result) {
          const { hash, onChainId } = result;
          persist(trades.map((t) => t.id === id ? {
            ...t, ...patch,
            onChainTxHash: hash,
            ...(onChainId !== undefined ? { onChainId } : {}),
          } : t));
          return;
        }
        // User rejected — keep private
        return;
      } catch (err) {
        console.error("[ThesisRegistry] registerOnChain threw:", err);
        // Fall through to save as public in KV even if on-chain fails
        // so the feed still works while we debug
      }
    }

    // Closing a thesis that was registered on-chain → call closeThesis()
    const closingStatuses = ["HIT_TP", "STOPPED_OUT", "INVALIDATED"] as const;
    type ClosingStatus = typeof closingStatuses[number];
    const isClosingStatus = (s: string): s is ClosingStatus => closingStatuses.includes(s as ClosingStatus);

    if (
      patch.status &&
      isClosingStatus(patch.status) &&
      thesis.status === "ACTIVE" &&
      thesis.onChainId !== undefined &&
      thesis.isPublic
    ) {
      await closeOnChain(thesis.onChainId, patch.status as ClosingStatus, "");
    }

    persist(trades.map((t) => t.id === id ? { ...t, ...patch } : t));
  };

  const removeTrade = (id: string) => persist(trades.filter((t) => t.id !== id));

  const fundingIsPositive = parseFloat(form.fundingRate) >= 0;

  const closedTrades = trades.filter((t) => CLOSED_STATUSES.includes(t.status));
  const hits = trades.filter((t) => t.status === "HIT_TP").length;
  const thesisAccuracy = closedTrades.length ? Math.round((hits / closedTrades.length) * 100) : null;
  const filteredTrades = filter === "ALL" ? trades : trades.filter((t) => t.status === filter);

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #1a2e1a", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "monospace", letterSpacing: "0.12em", marginBottom: 4 }}>
            &#9632; THESIS EXECUTOR — PAPER MODE
          </div>
          <div style={{ fontSize: 11, color: "#3a5a4a", fontFamily: "monospace" }}>
          </div>
        </div>
        {thesisAccuracy !== null && (
          <div style={{ ...cardStyle, padding: "8px 16px", display: "flex", gap: 20 }}>
            <div>
              <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>THESIS ACCURACY</div>
              <div style={{ fontSize: 20, color: thesisAccuracy >= 50 ? "#00ff88" : "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>{thesisAccuracy}%</div>
            </div>
            <div style={{ width: 1, background: "#1a2e1a" }} />
            <div>
              <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>CLOSED</div>
              <div style={{ fontSize: 20, color: "#8aaa9a", fontFamily: "monospace", fontWeight: "bold" }}>{closedTrades.length}</div>
            </div>
            <div style={{ width: 1, background: "#1a2e1a" }} />
            <div>
              <div style={{ fontSize: 8, color: "#3a5a4a", fontFamily: "monospace" }}>ACTIVE</div>
              <div style={{ fontSize: 20, color: "#4a9fff", fontFamily: "monospace", fontWeight: "bold" }}>{trades.filter((t) => t.status === "ACTIVE").length}</div>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 320px", gap: 12, alignItems: "start" }}>
        {/* Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#fbbf24", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; INSTRUMENT</div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 160px", gap: 8 }}>
              <div>
                <span style={fieldLabelStyle}>SYMBOL</span>
                <input style={inputStyle} placeholder="BTC, ETH, SOL..." value={form.symbol} onChange={(e) => set("symbol", e.target.value)} />
              </div>
              <div>
                <span style={fieldLabelStyle}>DIRECTION</span>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["LONG", "SHORT"] as const).map((d) => (
                    <button key={d} onClick={() => set("direction", d)} style={{
                      flex: 1, padding: "8px 0", fontFamily: "monospace", fontSize: 11,
                      cursor: "pointer", borderRadius: 3, border: "1px solid",
                      background: form.direction === d ? (d === "LONG" ? "#0a2a0a" : "#2a0a0a") : "#080c08",
                      borderColor: form.direction === d ? (d === "LONG" ? "#00ff88" : "#ff4444") : "#1a2e1a",
                      color: form.direction === d ? (d === "LONG" ? "#00ff88" : "#ff4444") : "#3a5a4a",
                    }}>{d === "LONG" ? "↑ LONG" : "↓ SHORT"}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#4a9fff", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; PRICE LEVELS</div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 8 }}>
              {[
                { key: "entryPrice", label: "ENTRY", placeholder: "95000" },
                { key: "stopLoss", label: "STOP LOSS", placeholder: "93000" },
                { key: "takeProfit1", label: "TP1", placeholder: "98000" },
                { key: "takeProfit2", label: "TP2 (OPT)", placeholder: "102000" },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <span style={fieldLabelStyle}>{label}</span>
                  <input
                    style={{ ...inputStyle, borderColor: key === "stopLoss" ? "#2a1a1a" : key.startsWith("take") ? "#1a2a1a" : "#1a2e1a" }}
                    type="number" placeholder={placeholder}
                    value={form[key as keyof typeof form] as string}
                    onChange={(e) => set(key, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#a855f7", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; RISK + FUNDING</div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr", gap: 8 }}>
              <div>
                <span style={fieldLabelStyle}>ACCOUNT SIZE (USDC)</span>
                <input style={inputStyle} type="number" placeholder="10000" value={form.accountSize} onChange={(e) => set("accountSize", e.target.value)} />
              </div>
              <div>
                <span style={fieldLabelStyle}>RISK %</span>
                <input style={inputStyle} type="number" placeholder="1.5" step="0.1" value={form.riskPercent} onChange={(e) => set("riskPercent", e.target.value)} />
              </div>
              <div>
                <span style={fieldLabelStyle}>FUNDING RATE (% per 8h)</span>
                <input
                  style={{ ...inputStyle, borderColor: fundingIsPositive ? "#1a2a1a" : "#2a1a1a", color: fundingIsPositive ? "#00ff88" : "#ff4444" }}
                  type="number" placeholder="0.01" step="0.001"
                  value={form.fundingRate} onChange={(e) => set("fundingRate", e.target.value)}
                />
                <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace", marginTop: 4 }}>
                  {fundingIsPositive ? "longs pay shorts" : "shorts pay longs"}
                </div>
              </div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 8 }}>&#9632; THESIS / REASONING</div>
            <textarea
              style={{ ...inputStyle, height: 80, resize: "none" }}
              placeholder="Why are you taking this trade? What needs to be true for it to work? What invalidates it?"
              value={form.notes} onChange={(e) => set("notes", e.target.value)}
            />
          </div>
        </div>

        {/* Output Panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, position: isMobile ? "static" : "sticky", top: 16 }}>
          <div style={{ ...cardStyle, border: "1px solid #1a3a2a" }}>
            <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 16 }}>&#9632; CALCULATED OUTPUT</div>
            {!calc ? (
              <div style={{ fontSize: 11, color: "#2a4a3a", fontFamily: "monospace", textAlign: "center", padding: "20px 0" }}>
                fill in entry, stop, tp1,<br />account size + risk %
              </div>
            ) : (
              <>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>POSITION SIZE</div>
                  <div style={{ fontSize: 28, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>${calc.positionSize.toFixed(0)}</div>
                  <div style={{ fontSize: 10, color: "#2a4a3a", fontFamily: "monospace" }}>usdc notional</div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>LEVERAGE REQUIRED</div>
                  <div style={{ fontSize: 22, fontFamily: "monospace", fontWeight: "bold", color: calc.leverage > 25 ? "#ff4444" : calc.leverage > 10 ? "#fbbf24" : "#00ff88" }}>
                    {calc.leverage.toFixed(1)}x
                  </div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>RISK AMOUNT</div>
                  <div style={{ fontSize: 18, color: "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>${calc.riskAmount.toFixed(2)}</div>
                  <div style={{ fontSize: 10, color: "#2a4a3a", fontFamily: "monospace" }}>{form.riskPercent}% of account</div>
                </div>
                <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid #1a2e1a" }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>RISK / REWARD</div>
                  <div style={{ fontSize: 22, fontFamily: "monospace", fontWeight: "bold", color: calc.riskReward >= 2 ? "#00ff88" : calc.riskReward >= 1 ? "#fbbf24" : "#ff4444" }}>
                    1 : {calc.riskReward.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, color: "#2a4a3a", fontFamily: "monospace" }}>
                    {calc.riskReward >= 2 ? "good setup" : calc.riskReward >= 1 ? "marginal" : "unfavorable"}
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em", marginBottom: 8 }}>
                    FUNDING COST ({parseFloat(form.fundingRate) >= 0 ? form.direction : form.direction === "LONG" ? "SHORT" : "LONG"} pays)
                  </div>
                  {[
                    { label: "8h", val: calc.fundingCost8h },
                    { label: "24h", val: calc.fundingCost24h },
                    { label: "72h", val: calc.fundingCost72h },
                  ].map(({ label, val }) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</span>
                      <span style={{ fontSize: 13, color: "#fbbf24", fontFamily: "monospace", fontWeight: "bold" }}>${val.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
                {/* Confirmation overlay */}
                {liveConfirm && calc && (
                  <div style={{ background: "#1a0a00", border: "1px solid #ff6600", borderRadius: 4, padding: "12px 14px", marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: "#ff6600", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 10 }}>
                      &#9632; CONFIRM LIVE ORDER
                    </div>
                    {[
                      { label: "SYMBOL", val: `PERP_${form.symbol.toUpperCase()}_USDC` },
                      { label: "SIDE", val: form.direction, color: form.direction === "LONG" ? "#00ff88" : "#ff4444" },
                      { label: "ENTRY", val: `$${parseFloat(form.entryPrice).toLocaleString()}` },
                      { label: "QTY", val: (calc.positionSize / parseFloat(form.entryPrice)).toFixed(6) },
                      { label: "SIZE", val: `$${calc.positionSize.toFixed(0)} notional` },
                      { label: "STOP", val: `$${parseFloat(form.stopLoss).toLocaleString()}`, color: "#ff4444" },
                      { label: "TP1", val: `$${parseFloat(form.takeProfit1).toLocaleString()}`, color: "#00ff88" },
                    ].map(({ label, val, color }) => (
                      <div key={label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>{label}</span>
                        <span style={{ fontSize: 10, color: color ?? "#8aaa9a", fontFamily: "monospace", fontWeight: "bold" }}>{val}</span>
                      </div>
                    ))}
                    <div style={{ fontSize: 9, color: "#ff4444", fontFamily: "monospace", marginTop: 10, marginBottom: 10, lineHeight: 1.5 }}>
                      ⚠ REAL FUNDS. This places a live order on Orderly<br />
                      with your connected wallet. Cannot be undone.
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => setLiveConfirm(false)} style={{
                        flex: 1, padding: "8px 0", fontFamily: "monospace", fontSize: 11,
                        cursor: "pointer", borderRadius: 3, border: "1px solid #2a2a2a",
                        background: "#0a0a0a", color: "#3a5a4a", letterSpacing: "0.06em",
                      }}>ABORT</button>
                      <button onClick={deployLive} style={{
                        flex: 2, padding: "8px 0", fontFamily: "monospace", fontSize: 11,
                        cursor: "pointer", borderRadius: 3, border: "1px solid #ff6600",
                        background: "#1a0800", color: "#ff6600", letterSpacing: "0.08em", fontWeight: "bold",
                      }}>&#9632; CONFIRM — DEPLOY LIVE</button>
                    </div>
                  </div>
                )}

                {/* Live status feedback */}
                {liveStatus === "submitting" && (
                  <div style={{ padding: "10px 0", textAlign: "center", fontSize: 11, color: "#ff6600", fontFamily: "monospace", letterSpacing: "0.08em" }}>
                    &#9632; SUBMITTING TO ORDERLY...
                  </div>
                )}
                {liveStatus === "success" && (
                  <div style={{ padding: "10px 12px", background: "#0a1a00", border: "1px solid #1a4a00", borderRadius: 4, fontSize: 11, color: "#00ff88", fontFamily: "monospace", marginBottom: 8 }}>
                    &#9632; ORDER LIVE — entry limit + TP/SL bracket set
                  </div>
                )}
                {liveStatus === "error" && (
                  <div style={{ padding: "10px 12px", background: "#1a0a0a", border: "1px solid #4a1a1a", borderRadius: 4, marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: "#ff4444", fontFamily: "monospace" }}>&#9632; ORDER FAILED</div>
                    {liveError && <div style={{ fontSize: 9, color: "#3a2a2a", fontFamily: "monospace", marginTop: 4 }}>{liveError}</div>}
                  </div>
                )}

                {/* Deploy buttons */}
                {!liveConfirm && liveStatus !== "submitting" && (
                  <>
                    <button onClick={deployPaper} disabled={!form.symbol} style={{
                      width: "100%", padding: "9px 0", fontFamily: "monospace", fontSize: 11,
                      cursor: form.symbol ? "pointer" : "not-allowed", borderRadius: 3,
                      border: `1px solid ${deployed ? "#00ff88" : "#1a4a2a"}`,
                      background: deployed ? "#0a2a0a" : "#080c08",
                      color: deployed ? "#00ff88" : form.symbol ? "#4a9fff" : "#2a4a3a",
                      letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      {deployed ? "&#9632; DEPLOYED" : "&#9632; DEPLOY (PAPER)"}
                    </button>
                    <button
                      onClick={() => { if (form.symbol && calc) setLiveConfirm(true); }}
                      disabled={!form.symbol || !isWalletReady}
                      style={{
                        width: "100%", padding: "9px 0", fontFamily: "monospace", fontSize: 11,
                        cursor: form.symbol && isWalletReady ? "pointer" : "not-allowed", borderRadius: 3,
                        border: `1px solid ${!form.symbol || !isWalletReady ? "#2a1a0a" : "#ff6600"}`,
                        background: "#0a0500",
                        color: !form.symbol || !isWalletReady ? "#2a1a0a" : "#ff6600",
                        letterSpacing: "0.08em",
                      }}>
                      &#9632; DEPLOY (LIVE)
                    </button>
                    {!form.symbol && <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace", textAlign: "center", marginTop: 6 }}>enter symbol to deploy</div>}
                    {form.symbol && !isWalletReady && <div style={{ fontSize: 9, color: "#3a2a1a", fontFamily: "monospace", textAlign: "center", marginTop: 6 }}>connect wallet to deploy live</div>}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Analytics Bridge */}
      <ThesisAnalyticsSection trades={trades} />

      {/* Thesis List */}
      {trades.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "monospace", letterSpacing: "0.12em" }}>
              &#9632; THESIS_LOG ({filteredTrades.length}/{trades.length})
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {(["ALL", ...Object.keys(STATUS_CONFIG)] as (ThesisStatus | "ALL")[]).map((f) => {
                const active = filter === f;
                const c = f !== "ALL" ? STATUS_CONFIG[f as ThesisStatus] : null;
                return (
                  <button key={f} onClick={() => setFilter(f)} style={{
                    fontFamily: "monospace", fontSize: 9, padding: "3px 9px",
                    cursor: "pointer", borderRadius: 3, letterSpacing: "0.06em",
                    border: `1px solid ${active ? (c?.border ?? "#1a4a2a") : "#1a2e1a"}`,
                    background: active ? (c?.bg ?? "#0a1a0a") : "transparent",
                    color: active ? (c?.color ?? "#00ff88") : "#2a4a3a",
                  }}>{f === "ALL" ? "ALL" : STATUS_CONFIG[f as ThesisStatus].label}</button>
                );
              })}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filteredTrades.map((t) => (
              <ThesisCard key={t.id} t={t} onUpdate={updateTrade} onRemove={removeTrade} walletAddress={walletAddress} isMobile={isMobile} markPrice={livePrices[t.symbol] ?? null} />
            ))}
          </div>
        </div>
      )}

      {trades.length === 0 && (
        <div style={{ marginTop: 24 }}>
          <EmptyState message="no theses deployed yet — fill the form above and hit deploy" />
        </div>
      )}
    </div>
  );
}

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

// ─── Main Page ───────────────────────────────────────────
export default function TheLabPage() {
  const [activeTab, setActiveTab] = useState<TabId>("analytics");
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const today = new Date();

  // ── Persistence (KV + localStorage) ─────────────────────
  const { state: rootAccountState } = useAccount();
  const rootWalletAddress = (rootAccountState as { address?: string })?.address ?? null;
  const { notes, saveNote, syncing, synced } = useLabStorage(rootWalletAddress);
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
  const handleBack = () => { setSelectedDayKey(null); setSelectedDay(null); setActiveTab("calendar"); };
  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); } else setViewMonth((m) => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); } else setViewMonth((m) => m + 1); };

  const isMobile = useIsMobile();

  const tabs: { id: TabId; label: string; short: string }[] = [
    { id: "analytics", label: "[ ANALYTICS ]", short: "STATS" },
    { id: "calendar", label: "[ CALENDAR ]", short: "CAL" },
    { id: "tradelog", label: "[ TRADE LOG ]", short: "LOG" },
    { id: "thesis", label: "[ THESIS ]", short: "LAB" },
    { id: "intel", label: "[ INTEL ]", short: "INTEL" },
    { id: "copies", label: "[ COPIES ]", short: "COPY" },
    { id: "thesisanalytics", label: "[ T-STATS ]", short: "TSTA" },
  ];

  const calendarProps = { dayGroups, onDayClick: handleDayClick, viewMonth, viewYear, onPrevMonth: prevMonth, onNextMonth: nextMonth, totalPnl };

  return (
    <div style={{ background: "#0a0e0a", minHeight: "100vh", padding: 0 }}>
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
        {activeTab === "analytics" && <AnalyticsView orders={processedTrades} totalPnl={totalPnl} winRate={winRate} collateral={availableBalance ?? 0} />}
        {activeTab === "calendar" && <CalendarView {...calendarProps} />}
        {activeTab === "tradelog" && (
          selectedDayKey && selectedDay !== null && dayGroups[selectedDayKey]
            ? <TradeLogView
                dayKey={selectedDayKey}
                data={dayGroups[selectedDayKey]}
                onBack={handleBack}
                initialNote={notes[selectedDayKey]}
                onSaveNote={saveNote}
              />
            : <CalendarView {...calendarProps} />
        )}
        {activeTab === "thesis" && <ThesisView />}
        {activeTab === "copies" && <CopiesView />}
        {activeTab === "thesisanalytics" && <ThesisAnalyticsView />}
        {activeTab === "intel" && <IntelPage embedded />}
      </div>
    </div>
  );
}
