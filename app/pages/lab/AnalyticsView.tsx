// Analytics tab + its charts/sections (RadarChart, TradingScore, breakdowns,
// top assets, performance). Extracted from index.tsx (god-file split).
import { useMemo } from "react";
import type { ProcessedTrade } from "./types";
import { cardStyle, labelStyle } from "./styles";
import { formatPnl } from "./helpers";
import { PnlChart, EmptyState } from "./components";
import { useIsMobile } from "./useIsMobile";

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
  const isMobile = useIsMobile();
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
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "280px 1fr", gap: isMobile ? 16 : 24, alignItems: "center", justifyItems: isMobile ? "center" : "stretch" }}>
        <RadarChart scores={metrics.scores} />
        <div style={{ width: isMobile ? "100%" : undefined }}>
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
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginTop: 8 }}>
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))", gap: 8 }}>
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

// ─── Timing & Risk (peak hours, streaks, sample-gated ratios) ─
// ⚠️ Risk ratios are gated behind a minimum sample size — small-sample Sharpe/
// Sortino are statistically meaningless (the "Sharpe 16 on 7 trades" vanity trap).
// We show the honest "need N more trades" state instead of an inflated number.
const RISK_SAMPLE_GATE = 20;
function hourWinColor(wr: number, trades: number) {
  if (!trades) return "#0a150a";
  if (wr >= 60) return "#1a4a2a";
  if (wr >= 40) return "#3a3a1a";
  return "#3a1a1a";
}
function TimingAndRisk({ orders }: { orders: ProcessedTrade[] }) {
  const isMobile = useIsMobile();
  const stats = useMemo(() => {
    if (!orders.length) return null;
    const sorted = [...orders].sort((a, b) => a.timestamp - b.timestamp);
    let run = 0, sign = 0, bestWin = 0, worstLoss = 0;
    for (const o of sorted) {
      const s = o.pnl > 0 ? 1 : o.pnl < 0 ? -1 : 0;
      if (s === 0) continue;
      if (s === sign) run += 1; else { sign = s; run = 1; }
      if (sign === 1) bestWin = Math.max(bestWin, run);
      if (sign === -1) worstLoss = Math.max(worstLoss, run);
    }
    const current = run * sign; // signed: + win streak, - loss streak
    const hours = Array.from({ length: 24 }, (_, h) => ({ h, trades: 0, wins: 0, pnl: 0 }));
    for (const o of orders) {
      const h = new Date(o.timestamp).getHours();
      hours[h].trades++; hours[h].pnl += o.pnl; if (o.pnl > 0) hours[h].wins++;
    }
    const peak = hours.filter((b) => b.trades > 0)
      .sort((a, b) => (b.wins / b.trades) - (a.wins / a.trades) || b.trades - a.trades)
      .slice(0, 3);
    const pnls = orders.map((o) => o.pnl);
    const n = pnls.length;
    const mean = pnls.reduce((s, v) => s + v, 0) / n;
    const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const downside = Math.sqrt(pnls.filter((v) => v < 0).reduce((s, v) => s + v * v, 0) / n);
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(n) : 0;
    const sortino = downside > 0 ? (mean / downside) * Math.sqrt(n) : 0;
    return { current, bestWin, worstLoss, hours, peak, sharpe, sortino, expectancy: mean, n };
  }, [orders]);

  if (!stats) return null;
  const maxHourTrades = Math.max(...stats.hours.map((h) => h.trades), 1);
  const gated = stats.n < RISK_SAMPLE_GATE;
  const fmtHr = (h: number) => `${String(h).padStart(2, "0")}:00`;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginTop: 8 }}>
      {/* Streaks */}
      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#fbbf24", letterSpacing: "0.1em", marginBottom: 14, fontFamily: "monospace" }}>&#9632; STREAKS</div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>CURRENT</div>
          <div style={{ fontSize: 28, fontWeight: "bold", fontFamily: "monospace", color: stats.current >= 0 ? "#00ff88" : "#ff4444" }}>
            {Math.abs(stats.current)} {stats.current >= 0 ? "W" : "L"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>BEST WIN</div>
            <div style={{ fontSize: 18, color: "#00ff88", fontFamily: "monospace" }}>{stats.bestWin}</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>WORST LOSS</div>
            <div style={{ fontSize: 18, color: "#ff4444", fontFamily: "monospace" }}>{stats.worstLoss}</div>
          </div>
        </div>
      </div>

      {/* Risk-adjusted (gated) */}
      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#a855f7", letterSpacing: "0.1em", marginBottom: 14, fontFamily: "monospace" }}>&#9632; RISK-ADJUSTED</div>
        {gated ? (
          <div style={{ fontSize: 11, color: "#3a5a4a", fontFamily: "monospace", lineHeight: 1.7 }}>
            need <span style={{ color: "#fbbf24" }}>{RISK_SAMPLE_GATE - stats.n}</span> more closed trades<br />
            <span style={{ color: "#2a4a3a" }}>ratios are meaningless under {RISK_SAMPLE_GATE} samples — we won&apos;t fake them</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              { label: "SHARPE", num: stats.sharpe, value: stats.sharpe.toFixed(2) },
              { label: "SORTINO", num: stats.sortino, value: stats.sortino.toFixed(2) },
              { label: "EXPECTANCY", num: stats.expectancy, value: formatPnl(stats.expectancy) },
            ].map((r) => (
              <div key={r.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 10, color: "#3a5a4a", fontFamily: "monospace", letterSpacing: "0.06em" }}>{r.label}</span>
                <span style={{ fontSize: 18, color: r.num >= 0 ? "#00ff88" : "#ff4c6a", fontFamily: "monospace" }}>{r.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Peak hours + heatmap */}
      <div style={{ ...cardStyle, gridColumn: isMobile ? "auto" : "span 2" }}>
        <div style={{ fontSize: 10, color: "#4a9fff", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>&#9632; PEAK HOURS <span style={{ color: "#2a4a3a" }}>(local)</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(24, 1fr)", gap: 2, marginBottom: 12 }}>
          {stats.hours.map((b) => {
            const wr = b.trades ? Math.round((b.wins / b.trades) * 100) : 0;
            return (
              <div key={b.h} title={`${fmtHr(b.h)} — ${b.trades} trades, ${wr}% WR`} style={{
                height: 22, borderRadius: 2, background: hourWinColor(wr, b.trades),
                border: "1px solid #0e1a0e", opacity: b.trades ? Math.max(0.4, b.trades / maxHourTrades) : 1,
              }} />
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {stats.peak.length === 0
            ? <span style={{ fontSize: 11, color: "#2a4a3a", fontFamily: "monospace" }}>no timing data</span>
            : stats.peak.map((b) => (
              <div key={b.h} style={{ background: "#0a150a", border: "1px solid #1a3a1a", borderRadius: 4, padding: "6px 10px" }}>
                <div style={{ fontSize: 12, color: "#fff", fontFamily: "monospace" }}>{fmtHr(b.h)}-{fmtHr((b.h + 1) % 24)}</div>
                <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>{b.trades} trades · <span style={{ color: "#00ff88" }}>{Math.round((b.wins / b.trades) * 100)}%</span></div>
              </div>
            ))}
        </div>
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
export function AnalyticsView({ orders, totalPnl, winRate, collateral }: { orders: ProcessedTrade[]; totalPnl: number; winRate: number; collateral: number; }) {
  const volume = useMemo(() => orders.reduce((s, o) => s + o.qty * o.price, 0), [orders]);
  const avgWin = useMemo(() => { const w = orders.filter((o) => o.pnl > 0); return w.length ? w.reduce((s, o) => s + o.pnl, 0) / w.length : 0; }, [orders]);
  const avgLoss = useMemo(() => { const l = orders.filter((o) => o.pnl < 0); return l.length ? Math.abs(l.reduce((s, o) => s + o.pnl, 0) / l.length) : 0; }, [orders]);
  const bestTrade = useMemo(() => Math.max(0, ...orders.map((o) => o.pnl)), [orders]);
  const worstTrade = useMemo(() => Math.min(0, ...orders.map((o) => o.pnl)), [orders]);
  const cumulativePnl = useMemo(() => { let r = 0; return [0, ...orders.map((o) => { r += o.pnl; return r; })]; }, [orders]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 8 }}>
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
      <TimingAndRisk orders={orders} />
      <PerformanceAnalysis orders={orders} />
      <TopAssets orders={orders} />

      {orders.length === 0 && <EmptyState message="no closed trades found — connect wallet to load your data" />}
    </div>
  );
}
