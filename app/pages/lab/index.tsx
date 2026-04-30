import { useState, useMemo } from "react";
import { useCollateral, usePrivateQuery } from "@orderly.network/hooks";

// ─── Types ───────────────────────────────────────────────
type TabId = "analytics" | "calendar" | "tradelog" | "thesis";

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

// ─── Thesis Types ─────────────────────────────────────────
interface ThesisTrade {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskPercent: number;
  accountSize: number;
  fundingRate: number;
  notes: string;
  createdAt: number;
  // calculated
  positionSize: number;
  leverage: number;
  riskReward: number;
  fundingCost8h: number;
  fundingCost24h: number;
  fundingCost72h: number;
}

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

// ─── Thesis Styles ────────────────────────────────────────
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
        <span style={{ color: "#3a5a4a" }}>&#9632;</span> SYSTEM/TRADING_SCORE
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
        <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; SYSTEM/PERFORMANCE_ANALYSIS</div>
        <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace", marginBottom: 12 }}>$ ./analyze_best_worst.sh --detailed</div>
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
          <div style={{ fontSize: 10, color: "#2a4a3a", marginBottom: 4, fontFamily: "monospace" }}>$ ./calculate_pnl.sh</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "monospace", color: totalPnl >= 0 ? "#00ff88" : "#ff4444" }}>{formatPnl(totalPnl)}</div>
          <div style={{ fontSize: 10, color: "#3a5a4a", marginTop: 4, fontFamily: "monospace" }}>realized</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>WIN RATE</div>
          <div style={{ fontSize: 10, color: "#2a4a3a", marginBottom: 4, fontFamily: "monospace" }}>$ ./analyze_performance.sh</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "monospace", color: "#4a9fff" }}>{orders.length ? `${winRate.toFixed(1)}%` : "—"}</div>
          <div style={{ height: 4, background: "#1a2e1a", borderRadius: 2, marginTop: 8 }}><div style={{ height: 4, background: "#4a9fff", borderRadius: 2, width: `${winRate}%` }} /></div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>TRADES</div>
          <div style={{ fontSize: 10, color: "#2a4a3a", marginBottom: 4, fontFamily: "monospace" }}>$ ./count_trades.sh</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "monospace", color: "#a855f7" }}>{orders.length}</div>
          <div style={{ fontSize: 10, color: "#3a5a4a", marginTop: 4, fontFamily: "monospace" }}>closed</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>ACCOUNT EQUITY</div>
          <div style={{ fontSize: 10, color: "#2a4a3a", marginBottom: 4, fontFamily: "monospace" }}>$ ./get_balance.sh</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "monospace", color: "#fbbf24" }}>{collateral > 0 ? `$${collateral.toFixed(2)}` : "—"}</div>
          <div style={{ fontSize: 10, color: "#3a5a4a", marginTop: 4, fontFamily: "monospace" }}>usdc</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 240px", gap: 8, marginBottom: 8 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>&#9632; SYSTEM/PNL_OVER_TIME</div>
          <div style={{ fontSize: 10, color: "#2a4a3a", marginBottom: 10, fontFamily: "monospace" }}>$ ./plot_cumulative_pnl.sh --live</div>
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
function TradeLogView({ dayKey, data, onBack }: { dayKey: string; data: DayGroup; onBack: () => void }) {
  const storageKey = `lab_note_${dayKey}`;
  const [note, setNote] = useState(() => localStorage.getItem(storageKey) || "");
  const [saved, setSaved] = useState(false);
  const saveNote = () => { localStorage.setItem(storageKey, note); setSaved(true); setTimeout(() => setSaved(false), 2000); };

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

// ─── Thesis Calculator (pure math, no side effects) ───────
function calcThesis(form: {
  entryPrice: string; stopLoss: string; takeProfit1: string; takeProfit2: string;
  riskPercent: string; accountSize: string; fundingRate: string; direction: "LONG" | "SHORT";
}) {
  const entry = parseFloat(form.entryPrice);
  const stop = parseFloat(form.stopLoss);
  const tp1 = parseFloat(form.takeProfit1);
  const account = parseFloat(form.accountSize);
  const riskPct = parseFloat(form.riskPercent);
  const funding = parseFloat(form.fundingRate); // % per 8h

  if (!entry || !stop || !tp1 || !account || !riskPct) return null;

  const riskAmount = account * (riskPct / 100);
  const stopDistancePct = Math.abs((entry - stop) / entry);
  if (stopDistancePct === 0) return null;

  const positionSize = riskAmount / stopDistancePct;
  const leverage = positionSize / account;
  const rewardDistance = Math.abs((tp1 - entry) / entry);
  const riskReward = rewardDistance / stopDistancePct;

  // Funding cost = positionSize * fundingRate% per 8h
  const fundingPerPeriod = positionSize * (Math.abs(funding) / 100);
  const fundingCost8h = fundingPerPeriod;
  const fundingCost24h = fundingPerPeriod * 3;
  const fundingCost72h = fundingPerPeriod * 9;

  return {
    positionSize: Math.min(positionSize, account * 100), // cap at 100x
    leverage: Math.min(leverage, 100),
    riskReward,
    riskAmount,
    fundingCost8h,
    fundingCost24h,
    fundingCost72h,
  };
}

// ─── Thesis View ──────────────────────────────────────────
function ThesisView() {
  const STORAGE_KEY = "lab_thesis_trades";

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

  const [trades, setTrades] = useState<ThesisTrade[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
  });

  const [deployed, setDeployed] = useState(false);

  const calc = useMemo(() => calcThesis(form), [form]);

  const set = (field: string, value: string) => setForm((f) => ({ ...f, [field]: value }));

  const deployPaper = () => {
    if (!calc || !form.symbol) return;
    const trade: ThesisTrade = {
      id: Date.now().toString(),
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
      positionSize: calc.positionSize,
      leverage: calc.leverage,
      riskReward: calc.riskReward,
      fundingCost8h: calc.fundingCost8h,
      fundingCost24h: calc.fundingCost24h,
      fundingCost72h: calc.fundingCost72h,
    };
    const updated = [trade, ...trades];
    setTrades(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    setDeployed(true);
    setTimeout(() => setDeployed(false), 2500);
    // reset form fields except account size and funding rate
    setForm((f) => ({ ...f, symbol: "", entryPrice: "", stopLoss: "", takeProfit1: "", takeProfit2: "", notes: "" }));
  };

  const removeTrade = (id: string) => {
    const updated = trades.filter((t) => t.id !== id);
    setTrades(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const fundingIsPositive = parseFloat(form.fundingRate) >= 0;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #1a2e1a" }}>
        <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "monospace", letterSpacing: "0.12em", marginBottom: 4 }}>
          &#9632; SYSTEM/THESIS_EXECUTOR — PAPER MODE
        </div>
        <div style={{ fontSize: 11, color: "#3a5a4a", fontFamily: "monospace" }}>
          $ ./compile_thesis.sh --mode=paper --risk-managed
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 12, alignItems: "start" }}>

        {/* ── LEFT: Form ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

          {/* Symbol + Direction */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#fbbf24", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; INSTRUMENT</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 8 }}>
              <div>
                <span style={fieldLabelStyle}>SYMBOL</span>
                <input
                  style={inputStyle}
                  placeholder="BTC, ETH, SOL..."
                  value={form.symbol}
                  onChange={(e) => set("symbol", e.target.value)}
                />
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

          {/* Price Levels */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#4a9fff", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; PRICE LEVELS</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
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
                    type="number"
                    placeholder={placeholder}
                    value={form[key as keyof typeof form] as string}
                    onChange={(e) => set(key, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Risk + Funding */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#a855f7", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 12 }}>&#9632; RISK + FUNDING</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
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
                  type="number"
                  placeholder="0.01"
                  step="0.001"
                  value={form.fundingRate}
                  onChange={(e) => set("fundingRate", e.target.value)}
                />
                <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace", marginTop: 4 }}>
                  {fundingIsPositive ? "longs pay shorts" : "shorts pay longs"}
                </div>
              </div>
            </div>
          </div>

          {/* Thesis Notes */}
          <div style={cardStyle}>
            <div style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 8 }}>&#9632; THESIS / REASONING</div>
            <textarea
              style={{ ...inputStyle, height: 80, resize: "none" }}
              placeholder="Why are you taking this trade? What needs to be true for it to work? What invalidates it?"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>
        </div>

        {/* ── RIGHT: Output Panel ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, position: "sticky", top: 16 }}>
          <div style={{ ...cardStyle, border: "1px solid #1a3a2a" }}>
            <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 16 }}>&#9632; CALCULATED OUTPUT</div>

            {!calc ? (
              <div style={{ fontSize: 11, color: "#2a4a3a", fontFamily: "monospace", textAlign: "center", padding: "20px 0" }}>
                fill in entry, stop, tp1,<br />account size + risk %
              </div>
            ) : (
              <>
                {/* Position Size */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>POSITION SIZE</div>
                  <div style={{ fontSize: 28, color: "#00ff88", fontFamily: "monospace", fontWeight: "bold" }}>
                    ${calc.positionSize.toFixed(0)}
                  </div>
                  <div style={{ fontSize: 10, color: "#2a4a3a", fontFamily: "monospace" }}>usdc notional</div>
                </div>

                {/* Leverage */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>LEVERAGE REQUIRED</div>
                  <div style={{ fontSize: 22, fontFamily: "monospace", fontWeight: "bold", color: calc.leverage > 25 ? "#ff4444" : calc.leverage > 10 ? "#fbbf24" : "#00ff88" }}>
                    {calc.leverage.toFixed(1)}x
                  </div>
                </div>

                {/* Risk Amount */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>RISK AMOUNT</div>
                  <div style={{ fontSize: 18, color: "#ff4444", fontFamily: "monospace", fontWeight: "bold" }}>
                    ${calc.riskAmount.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, color: "#2a4a3a", fontFamily: "monospace" }}>{form.riskPercent}% of account</div>
                </div>

                {/* R:R */}
                <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid #1a2e1a" }}>
                  <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.08em" }}>RISK / REWARD</div>
                  <div style={{ fontSize: 22, fontFamily: "monospace", fontWeight: "bold", color: calc.riskReward >= 2 ? "#00ff88" : calc.riskReward >= 1 ? "#fbbf24" : "#ff4444" }}>
                    1 : {calc.riskReward.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, color: "#2a4a3a", fontFamily: "monospace" }}>
                    {calc.riskReward >= 2 ? "good setup" : calc.riskReward >= 1 ? "marginal" : "unfavorable"}
                  </div>
                </div>

                {/* Funding Costs */}
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
                      <span style={{ fontSize: 13, color: "#fbbf24", fontFamily: "monospace", fontWeight: "bold" }}>
                        ${val.toFixed(3)}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Deploy Button */}
                <button
                  onClick={deployPaper}
                  disabled={!form.symbol}
                  style={{
                    width: "100%", padding: "10px 0", fontFamily: "monospace", fontSize: 12,
                    cursor: form.symbol ? "pointer" : "not-allowed", borderRadius: 3,
                    border: `1px solid ${deployed ? "#00ff88" : "#1a4a2a"}`,
                    background: deployed ? "#0a2a0a" : "#080c08",
                    color: deployed ? "#00ff88" : form.symbol ? "#4a9fff" : "#2a4a3a",
                    letterSpacing: "0.08em",
                  }}
                >
                  {deployed ? "&#9632; THESIS DEPLOYED" : "&#9632; DEPLOY (PAPER)"}
                </button>
                {!form.symbol && (
                  <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace", textAlign: "center", marginTop: 6 }}>enter symbol to deploy</div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Active Theses ── */}
      {trades.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 10, color: "#00ff88", fontFamily: "monospace", letterSpacing: "0.12em", marginBottom: 10 }}>
            &#9632; ACTIVE_THESES ({trades.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {trades.map((t) => (
              <div key={t.id} style={{ ...cardStyle, border: "1px solid #1a3a2a" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {/* Symbol + direction */}
                    <div>
                      <div style={{ fontSize: 16, color: "#fff", fontWeight: "bold", fontFamily: "monospace" }}>{t.symbol}</div>
                      <div style={{ fontSize: 10, color: t.direction === "LONG" ? "#00ff88" : "#ff4444", fontFamily: "monospace" }}>
                        {t.direction === "LONG" ? "↑" : "↓"} {t.direction} · {t.leverage.toFixed(1)}x
                      </div>
                    </div>

                    {/* Key stats */}
                    <div style={{ display: "flex", gap: 16, marginLeft: 8 }}>
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

                  {/* Right side: timestamp + remove */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                    <div style={{ fontSize: 9, color: "#2a4a3a", fontFamily: "monospace" }}>
                      {new Date(t.createdAt).toLocaleString()}
                    </div>
                    <button onClick={() => removeTrade(t.id)} style={{ ...navBtnStyle, fontSize: 10, color: "#ff4444", borderColor: "#2a1a1a" }}>
                      CLOSE
                    </button>
                  </div>
                </div>

                {/* Notes */}
                {t.notes && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #1a2e1a", fontSize: 11, color: "#3a5a4a", fontFamily: "monospace", fontStyle: "italic" }}>
                    &quot;{t.notes}&quot;
                  </div>
                )}
              </div>
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

// ─── Main Page ───────────────────────────────────────────
export default function TheLabPage() {
  const [activeTab, setActiveTab] = useState<TabId>("analytics");
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const today = new Date();
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

  const tabs: { id: TabId; label: string }[] = [
    { id: "analytics", label: "[ ANALYTICS ]" },
    { id: "calendar", label: "[ CALENDAR ]" },
    { id: "tradelog", label: "[ TRADE LOG ]" },
    { id: "thesis", label: "[ THESIS ]" },
  ];

  const calendarProps = { dayGroups, onDayClick: handleDayClick, viewMonth, viewYear, onPrevMonth: prevMonth, onNextMonth: nextMonth, totalPnl };

  return (
    <div style={{ background: "#0a0e0a", minHeight: "100vh", padding: 0 }}>
      <div style={{ display: "flex", gap: 2, padding: "8px 16px", borderBottom: "1px solid #1a2e1a", background: "#080c08" }}>
        {tabs.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            background: activeTab === tab.id ? "#0a1a0a" : "none",
            border: `1px solid ${activeTab === tab.id ? "#00ff88" : "transparent"}`,
            color: activeTab === tab.id ? "#00ff88" : "#4a7a5a",
            fontFamily: "monospace", fontSize: 11, padding: "5px 12px", cursor: "pointer", letterSpacing: "0.05em", borderRadius: 3,
          }}>{tab.label}</button>
        ))}
      </div>
      <div style={{ padding: 16 }}>
        {activeTab === "analytics" && <AnalyticsView orders={processedTrades} totalPnl={totalPnl} winRate={winRate} collateral={availableBalance ?? 0} />}
        {activeTab === "calendar" && <CalendarView {...calendarProps} />}
        {activeTab === "tradelog" && (
          selectedDayKey && selectedDay !== null && dayGroups[selectedDayKey]
            ? <TradeLogView dayKey={selectedDayKey} data={dayGroups[selectedDayKey]} onBack={handleBack} />
            : <CalendarView {...calendarProps} />
        )}
        {activeTab === "thesis" && <ThesisView />}
      </div>
    </div>
  );
}