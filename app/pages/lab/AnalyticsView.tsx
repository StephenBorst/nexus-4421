// Analytics tab + its charts/sections (RadarChart, TradingScore, breakdowns,
// top assets, performance). Extracted from index.tsx (god-file split).
import { useMemo } from "react";
import type { ProcessedTrade, ThesisTrade } from "./types";
import { cardStyle, labelStyle } from "./styles";
import { ProcessSection } from "./ProcessView";
import { OperatorProfileCard } from "./OperatorProfile";
import { TrackedRecordCard } from "@/components/TrackedRecordCard";
import { formatPnl } from "./helpers";
import { PnlChart, PnlBars, EmptyState, CountUp, SectionHeader } from "./components";
import { useIsMobile } from "./useIsMobile";
import { computeEdge } from "@/config/edge";

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
        return <path key={level} d={path} fill="none" stroke="#232327" strokeWidth="1" />;
      })}
      {scores.map((_, i) => {
        const p = getPoint(i, r);
        return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#232327" strokeWidth="1" />;
      })}
      <path d={dataPath} fill="#ededf0" fillOpacity="0.15" stroke="#ededf0" strokeWidth="2" />
      {dataPoints.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="4" fill="#ededf0" />)}
      {scores.map((s, i) => {
        const p = getPoint(i, r + 20);
        return <text key={i} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 10, fill: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{s.label}</text>;
      })}
      {scores.map((s, i) => {
        const p = getPoint(i, r - 16);
        return <text key={i} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 9, fill: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{s.value}</text>;
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

  if (!metrics) return <EmptyState message="no trading score yet" unlock="Your score is computed from closed trades — connect your wallet and it fills in from your real history." />;

  return (
    <div style={{ ...cardStyle, marginTop: 12 }}>
      <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 16, fontFamily: "var(--nx-font-mono)", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#52525b" }}>&#9632;</span> TRADING SCORE
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "280px 1fr", gap: isMobile ? 16 : 24, alignItems: "center", justifyItems: isMobile ? "center" : "stretch" }}>
        <RadarChart scores={metrics.scores} />
        <div style={{ width: isMobile ? "100%" : undefined }}>
          <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.1em", marginBottom: 4 }}>COMPOSITE SCORE</div>
          <div style={{ fontSize: 64, fontWeight: "bold", color: "#ededf0", fontFamily: "var(--nx-font-mono)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}><CountUp value={metrics.composite} format={(v) => `${Math.round(v)}`} /></div>
          <div style={{ height: 4, background: "#232327", borderRadius: 2, margin: "10px 0 16px" }}>
            <div style={{ height: 4, background: "#ededf0", borderRadius: 2, width: `${metrics.composite}%`, transition: "width 700ms var(--nx-ease)" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            {metrics.details.map((d) => (
              <div key={d.label} style={{ background: "#0a0a0b", border: "1px solid #232327", borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 9, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.16em", textTransform: "uppercase" }}>{d.label}</span>
                  <span style={{ fontSize: 8, color: "#33333a", fontFamily: "var(--nx-font-mono)" }}>{d.weight}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontSize: 16, color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{d.score}</span>
                  <span style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>/100 {d.raw}</span>
                </div>
                <div style={{ height: 3, background: "#232327", borderRadius: 2, marginTop: 6 }}>
                  <div style={{ height: 3, background: d.score > 80 ? "#3ecf8e" : d.score > 50 ? "#fbbf24" : "#f7525f", borderRadius: 2, width: `${d.score}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3, padding: "5px 12px", fontSize: 11, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{metrics.traderType}</div>
            <div style={{ background: "#0a0a0b", border: "1px solid #232327", borderRadius: 3, padding: "5px 12px", fontSize: 11, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{metrics.avgLev}X AVG LEV</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Breakdown Row ────────────────────────────────────────
function BreakdownRow({ orders }: { orders: ProcessedTrade[] }) {
  const isMobile = useIsMobile();
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
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginTop: 8 }}>
      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "var(--nx-font-mono)" }}>&#9632; HOLD TIME</div>
        {holdTime.map((b) => (
          <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)", width: 40 }}>{b.label}</div>
            <div style={{ flex: 1, height: 20, background: "#0a0a0b", borderRadius: 3, overflow: "hidden" }}>
              {b.count > 0 && (
                <div style={{ height: "100%", background: "#33333a", width: `${(b.count / orders.length) * 100}%`, display: "flex", alignItems: "center", paddingLeft: 6 }}>
                  <span style={{ fontSize: 9, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{b.count} ({Math.round((b.count / orders.length) * 100)}%)</span>
                </div>
              )}
            </div>
            <div style={{ fontSize: 10, color: b.pnl >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", width: 44, textAlign: "right" }}>
              {b.count > 0 ? formatPnl(b.pnl) : "+$0"}
            </div>
          </div>
        ))}
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "var(--nx-font-mono)" }}>&#9632; WEEKDAY BREAKDOWN</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 80, marginBottom: 12 }}>
          {weekday.days.map((d) => (
            <div key={d.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              {d.trades > 0 && <div style={{ fontSize: 8, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{Math.round((d.wins / d.trades) * 100)}%</div>}
              <div style={{ width: "100%", height: d.trades > 0 ? `${(d.trades / maxDayTrades) * 60}px` : "4px", background: d.trades > 0 ? "#33333a" : "#141416", borderRadius: 3, border: "1px solid #232327" }} />
              <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{d.label}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div><div style={{ fontSize: 9, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.16em", textTransform: "uppercase" }}>WEEKDAY WR</div><div style={{ fontSize: 16, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{weekday.weekdayWR}%</div></div>
          <div style={{ textAlign: "right" }}><div style={{ fontSize: 9, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.16em", textTransform: "uppercase" }}>WEEKEND WR</div><div style={{ fontSize: 16, color: parseFloat(weekday.weekendWR) > 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)" }}>{weekday.weekendWR}%</div></div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "var(--nx-font-mono)" }}>&#9632; LEVERAGE ANALYSIS</div>
        {leverage.buckets.length === 0
          ? <div style={{ fontSize: 11, color: "#33333a", fontFamily: "var(--nx-font-mono)" }}>no leverage data available</div>
          : leverage.buckets.map((b) => (
            <div key={b.label} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: "#fff", fontFamily: "var(--nx-font-mono)" }}>{b.label}</span>
                <span style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{b.trades} trades {b.trades ? `${Math.round((b.wins / b.trades) * 100)}%` : ""}</span>
              </div>
              <div style={{ height: 4, background: "#232327", borderRadius: 2 }}>
                <div style={{ height: 4, background: "#71717a", borderRadius: 2, width: `${(b.trades / orders.length) * 100}%` }} />
              </div>
              <div style={{ fontSize: 10, color: b.pnl >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", marginTop: 3 }}>{formatPnl(b.pnl)}</div>
            </div>
          ))
        }
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #232327", display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>AVG LEVERAGE</span>
          <span style={{ fontSize: 16, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{leverage.avgLev}x</span>
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
      <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "var(--nx-font-mono)" }}>&#9632; TOP ASSETS</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))", gap: 8 }}>
        {assets.map(([sym, data]) => {
          const wr = Math.round((data.wins / data.trades) * 100);
          return (
            <div key={sym} style={{ background: "#0a0a0b", border: "1px solid #232327", borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: "#fff", fontWeight: "bold", fontFamily: "var(--nx-font-mono)" }}>{sym}</span>
                <span style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{data.trades}</span>
              </div>
              <div style={{ fontSize: 16, color: data.pnl >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", fontWeight: "bold", marginBottom: 8 }}>{formatPnl(data.pnl)}</div>
              <div style={{ height: 3, background: "#232327", borderRadius: 2, marginBottom: 4 }}>
                <div style={{ height: 3, background: wr > 50 ? "#3ecf8e" : "#f7525f", borderRadius: 2, width: `${wr}%` }} />
              </div>
              <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{wr}% WR</div>
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
  if (!trades) return "#141416";
  if (wr >= 60) return "#33333a";
  if (wr >= 40) return "#4a3a00";
  return "#4a1e22";
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
    // TRUE per-trade risk-adjusted ratios (mean ÷ volatility). NOT × √n — that's a
    // t-statistic, which grows with sample size and would show a 100-trade record ~3×
    // the "Sharpe" of a 10-trade one at identical risk-adjusted returns (the vanity
    // inflation this card exists to avoid). Sample confidence is the GATE, not the value.
    const sharpe = std > 0 ? mean / std : 0;
    const sortino = downside > 0 ? mean / downside : 0;
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
        <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 14, fontFamily: "var(--nx-font-mono)" }}>&#9632; STREAKS</div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>CURRENT</div>
          <div style={{ fontSize: 28, fontWeight: "bold", fontFamily: "var(--nx-font-mono)", color: stats.current >= 0 ? "#3ecf8e" : "#f7525f" }}>
            {Math.abs(stats.current)} {stats.current >= 0 ? "W" : "L"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>BEST WIN</div>
            <div style={{ fontSize: 18, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{stats.bestWin}</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>WORST LOSS</div>
            <div style={{ fontSize: 18, color: "#f7525f", fontFamily: "var(--nx-font-mono)" }}>{stats.worstLoss}</div>
          </div>
        </div>
      </div>

      {/* Risk-adjusted (gated) */}
      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 14, fontFamily: "var(--nx-font-mono)" }}>&#9632; RISK-ADJUSTED</div>
        {gated ? (
          <div style={{ fontSize: 11, color: "#52525b", fontFamily: "var(--nx-font-ui)", lineHeight: 1.7 }}>
            need <span style={{ color: "#ededf0" }}>{RISK_SAMPLE_GATE - stats.n}</span> more closed trades<br />
            <span style={{ color: "#33333a" }}>ratios are meaningless under {RISK_SAMPLE_GATE} samples — we won&apos;t fake them</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              { label: "SHARPE", num: stats.sharpe, value: stats.sharpe.toFixed(2) },
              { label: "SORTINO", num: stats.sortino, value: stats.sortino.toFixed(2) },
              { label: "EXPECTANCY", num: stats.expectancy, value: formatPnl(stats.expectancy) },
            ].map((r) => (
              <div key={r.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.06em" }}>{r.label}</span>
                <span style={{ fontSize: 18, color: r.num >= 0 ? "#ededf0" : "#f7525f", fontFamily: "var(--nx-font-mono)" }}>{r.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Peak hours + heatmap */}
      <div style={{ ...cardStyle, gridColumn: isMobile ? "auto" : "span 2" }}>
        <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "var(--nx-font-mono)" }}>&#9632; PEAK HOURS <span style={{ color: "#33333a" }}>(local)</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(24, 1fr)", gap: 2, marginBottom: 12 }}>
          {stats.hours.map((b) => {
            const wr = b.trades ? Math.round((b.wins / b.trades) * 100) : 0;
            return (
              <div key={b.h} title={`${fmtHr(b.h)} — ${b.trades} trades, ${wr}% WR`} style={{
                height: 22, borderRadius: 2, background: hourWinColor(wr, b.trades),
                border: "1px solid #141416", opacity: b.trades ? Math.max(0.4, b.trades / maxHourTrades) : 1,
              }} />
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {stats.peak.length === 0
            ? <span style={{ fontSize: 11, color: "#33333a", fontFamily: "var(--nx-font-mono)" }}>no timing data</span>
            : stats.peak.map((b) => (
              <div key={b.h} style={{ background: "#141416", border: "1px solid #232327", borderRadius: 6, padding: "6px 10px" }}>
                <div style={{ fontSize: 12, color: "#fff", fontFamily: "var(--nx-font-mono)" }}>{fmtHr(b.h)}-{fmtHr((b.h + 1) % 24)}</div>
                <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{b.trades} trades · <span style={{ color: "#ededf0" }}>{Math.round((b.wins / b.trades) * 100)}%</span></div>
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
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8, marginTop: 8 }}>
      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "var(--nx-font-mono)" }}>&#9632; PERFORMANCE ANALYSIS</div>
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 9, color: "#ededf0", fontFamily: "var(--nx-font-mono)", marginBottom: 4 }}>Best Trade</div>
          <div style={{ background: "#141416", border: "1px solid #232327", borderRadius: 6, padding: "10px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 14, color: "#fff", fontWeight: "bold", fontFamily: "var(--nx-font-mono)" }}>{bestSym} {data.best.direction.toLowerCase()}</span>
              <span style={{ fontSize: 16, color: "#ededf0", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{formatPnl(data.best.pnl)}</span>
            </div>
            {data.best.leverage && <div style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginTop: 4 }}>{data.best.leverage}x leverage</div>}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: "#f7525f", fontFamily: "var(--nx-font-mono)", marginBottom: 4 }}>Worst Trade</div>
          <div style={{ background: "#241012", border: "1px solid #4a1e22", borderRadius: 6, padding: "10px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 14, color: "#fff", fontWeight: "bold", fontFamily: "var(--nx-font-mono)" }}>{worstSym} {data.worst.direction.toLowerCase()}</span>
              <span style={{ fontSize: 16, color: "#f7525f", fontFamily: "var(--nx-font-mono)", fontWeight: "bold" }}>{formatPnl(data.worst.pnl)}</span>
            </div>
            {data.worst.leverage && <div style={{ fontSize: 10, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginTop: 4 }}>{data.worst.leverage}x leverage</div>}
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "var(--nx-font-mono)" }}>&#9632; LONG vs SHORT</div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)" }}>Long Trades</span>
            <span style={{ fontSize: 12, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{data.longs.length} trades</span>
          </div>
          <div style={{ height: 6, background: "#232327", borderRadius: 3, marginBottom: 4 }}>
            <div style={{ height: 6, background: data.longs.length ? "#d4d4d8" : "#232327", borderRadius: 3, width: `${data.longs.length ? (data.longWins / data.longs.length) * 100 : 0}%` }} />
          </div>
          <div style={{ fontSize: 11, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{data.longs.length ? `${Math.round((data.longWins / data.longs.length) * 100)}%` : "0%"}</div>
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)" }}>Short Trades</span>
            <span style={{ fontSize: 12, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{data.shorts.length} trades</span>
          </div>
          <div style={{ height: 6, background: "#232327", borderRadius: 3, marginBottom: 4 }}>
            <div style={{ height: 6, background: data.shorts.length ? "#ededf0" : "#232327", borderRadius: 3, width: `${data.shorts.length ? (data.shortWins / data.shorts.length) * 100 : 0}%` }} />
          </div>
          <div style={{ fontSize: 11, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{data.shorts.length ? `${Math.round((data.shortWins / data.shorts.length) * 100)}%` : "0%"}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Analytics View ──────────────────────────────────────
// ─── Your Edge — the makes-you-a-better-trader synthesis ─────────────────────
// Turns the user's OWN realized record into a coach's read (strongest/weakest
// symbol, long-vs-short, ready strengths/leaks) via the shared computeEdge, and
// hands it to the copilot for the human synthesis. Same edge the get_my_edge tool
// reads — one source of truth. Renders nothing until there are closed trades.
function YourEdgeCard({ orders }: { orders: ProcessedTrade[] }) {
  const isMobile = useIsMobile();
  const edge = useMemo(
    () => computeEdge(orders.map((o) => ({ symbol: o.symbol, pnl: o.pnl, side: o.side || o.direction }))),
    [orders]
  );
  if (!edge) return null;
  const { by_side, best_symbol, worst_symbol, better_side, strengths, weaknesses, sample_note } = edge;

  const symTile = (title: string, s: typeof best_symbol, tone: "pos" | "neg") => (
    <div style={{ flex: 1, minWidth: 0, border: "1px solid #232327", borderRadius: 6, padding: "10px 12px" }}>
      <div style={{ fontSize: 9, color: "#52525b", letterSpacing: "0.08em", fontFamily: "var(--nx-font-mono)" }}>{title}</div>
      {s ? (
        <>
          <div style={{ fontSize: 18, color: "#f4f4f5", fontFamily: "var(--nx-font-mono)", marginTop: 2 }}>{s.symbol}</div>
          <div style={{ fontSize: 11, color: tone === "pos" ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", marginTop: 2 }}>
            {s.winRatePct}% · {s.pnl >= 0 ? "+" : "-"}${Math.abs(s.pnl)} · {s.trades} trades
          </div>
        </>
      ) : <div style={{ fontSize: 13, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginTop: 4 }}>—</div>}
    </div>
  );

  const sideTile = (label: "LONG" | "SHORT") => {
    const se = by_side[label];
    const on = better_side === label && se.trades > 0;
    return (
      <div style={{ flex: 1, minWidth: 0, border: `1px solid ${on ? "#33333a" : "#232327"}`, borderRadius: 6, padding: "10px 12px", background: on ? "rgba(237,237,240,0.03)" : "transparent" }}>
        <div style={{ fontSize: 9, color: on ? "#ededf0" : "#52525b", letterSpacing: "0.08em", fontFamily: "var(--nx-font-mono)" }}>{label}{on ? " ◂ stronger" : ""}</div>
        <div style={{ fontSize: 18, color: "#f4f4f5", fontFamily: "var(--nx-font-mono)", marginTop: 2 }}>{se.trades ? `${se.winRatePct}%` : "—"}</div>
        <div style={{ fontSize: 11, color: se.pnl >= 0 ? "#3ecf8e" : "#f7525f", fontFamily: "var(--nx-font-mono)", marginTop: 2 }}>{se.trades ? `${se.pnl >= 0 ? "+" : "-"}$${Math.abs(se.pnl)} · ${se.trades} trades` : "no data"}</div>
      </div>
    );
  };

  return (
    <div className="nx-fade-in nx-spotlight" style={{ ...cardStyle, marginBottom: 8 }}>
      <div style={labelStyle}>&#9670; YOUR EDGE</div>
      <div style={{ fontSize: 10, color: "#71717a", fontFamily: "var(--nx-font-mono)", marginTop: -2, marginBottom: 10 }}>where you actually make money — from your own graded record</div>
      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 8, marginBottom: 8 }}>
        {symTile("STRONGEST SYMBOL", best_symbol, "pos")}
        {symTile("WEAKEST SYMBOL", worst_symbol, "neg")}
        {sideTile("LONG")}
        {sideTile("SHORT")}
      </div>
      {(strengths.length > 0 || weaknesses.length > 0) && (
        <div style={{ borderTop: "1px solid #232327", paddingTop: 8, marginTop: 2, display: "flex", flexDirection: "column", gap: 4 }}>
          {strengths.map((s, i) => (
            <div key={`s${i}`} style={{ fontSize: 11, color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", lineHeight: 1.5 }}><span style={{ color: "#3ecf8e" }}>▲</span> {s}</div>
          ))}
          {weaknesses.map((w, i) => (
            <div key={`w${i}`} style={{ fontSize: 11, color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", lineHeight: 1.5 }}><span style={{ color: "#f7525f" }}>▼</span> {w}</div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 10 }}>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("nexus:assistant-ask", { detail: { prompt: "Use get_my_edge — break down my edge, tell me exactly what to trade more of, what to cut, and how to fix my weak spots." } }))}
          style={{ background: "transparent", border: "1px solid #232327", borderRadius: 6, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 11, letterSpacing: "0.04em", padding: "7px 11px", cursor: "pointer" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#ededf0"; e.currentTarget.style.borderColor = "#33333a"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "#a1a1aa"; e.currentTarget.style.borderColor = "#232327"; }}
        >◆ ask nexus ai to coach my edge</button>
        <span style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>{sample_note}</span>
      </div>
    </div>
  );
}

export function AnalyticsView({ orders, totalPnl, winRate, collateral, theses = [], wallet = null }: { orders: ProcessedTrade[]; totalPnl: number; winRate: number; collateral: number; theses?: ThesisTrade[]; wallet?: string | null; }) {
  const volume = useMemo(() => orders.reduce((s, o) => s + o.qty * o.price, 0), [orders]);
  const avgWin = useMemo(() => { const w = orders.filter((o) => o.pnl > 0); return w.length ? w.reduce((s, o) => s + o.pnl, 0) / w.length : 0; }, [orders]);
  const avgLoss = useMemo(() => { const l = orders.filter((o) => o.pnl < 0); return l.length ? Math.abs(l.reduce((s, o) => s + o.pnl, 0) / l.length) : 0; }, [orders]);
  const bestTrade = useMemo(() => Math.max(0, ...orders.map((o) => o.pnl)), [orders]);
  const worstTrade = useMemo(() => Math.min(0, ...orders.map((o) => o.pnl)), [orders]);
  const cumulativePnl = useMemo(() => { let r = 0; return [0, ...orders.map((o) => { r += o.pnl; return r; })]; }, [orders]);
  const isMobile = useIsMobile();

  return (
    <div className="nx-stagger" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <SectionHeader
        eyebrow="Grade · Analytics"
        title="Performance Analytics"
        note={<a href="/analyze" style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10, letterSpacing: "0.08em", textDecoration: "none", border: "1px solid #232327", borderRadius: 6, padding: "5px 10px" }}>▶ X-RAY ANY WALLET</a>}
      />
      {/* SYNTHESIS FIRST — one point of view, before the instrument panel. Everything
          below is the evidence for it. */}
      <OperatorProfileCard wallet={wallet} theses={theses} orders={orders} />

      {/* Your OWN on-chain Tracked Record — graded by the exact same methodology the
          Smart Money x-ray applies to any wallet (realized-PnL consistency over time).
          "We grade every wallet, including yours." Hidden until a wallet is connected. */}
      {wallet && <TrackedRecordCard address={wallet} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 8 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>TOTAL PNL</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "var(--nx-font-mono)", color: totalPnl >= 0 ? "#3ecf8e" : "#f7525f", fontVariantNumeric: "tabular-nums" }}>{orders.length ? <CountUp value={totalPnl} format={formatPnl} /> : "—"}</div>
          <div style={{ fontSize: 10, color: "#52525b", marginTop: 4, fontFamily: "var(--nx-font-mono)" }}>realized</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>WIN RATE</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "var(--nx-font-mono)", color: "#d4d4d8", fontVariantNumeric: "tabular-nums" }}>{orders.length ? <CountUp value={winRate} format={(v) => `${v.toFixed(1)}%`} /> : "—"}</div>
          <div style={{ height: 4, background: "#232327", borderRadius: 2, marginTop: 8 }}><div style={{ height: 4, background: "#d4d4d8", borderRadius: 2, width: `${winRate}%`, transition: "width 620ms var(--nx-ease)" }} /></div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>TRADES</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "var(--nx-font-mono)", color: "#f4f4f5", fontVariantNumeric: "tabular-nums" }}>{orders.length ? <CountUp value={orders.length} format={(v) => `${Math.round(v)}`} /> : 0}</div>
          <div style={{ fontSize: 10, color: "#52525b", marginTop: 4, fontFamily: "var(--nx-font-mono)" }}>closed</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>BALANCE</div>
          <div style={{ fontSize: 22, fontWeight: "bold", fontFamily: "var(--nx-font-mono)", color: "#f4f4f5", fontVariantNumeric: "tabular-nums" }}>{collateral > 0 ? <CountUp value={collateral} format={(v) => `$${v.toFixed(2)}`} /> : "—"}</div>
          <div style={{ fontSize: 10, color: "#52525b", marginTop: 4, fontFamily: "var(--nx-font-mono)" }}>usdc</div>
        </div>
      </div>

      <YourEdgeCard orders={orders} />

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 240px", gap: 8, marginBottom: 8 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>&#9632; P&amp;L OVER TIME</div>
          {orders.length ? <PnlChart points={cumulativePnl} /> : <EmptyState message="no equity curve yet" unlock="This draws itself from your closed trades. Nothing to plot until the first one settles." />}
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.1em", marginBottom: 14, fontFamily: "var(--nx-font-mono)" }}>PERFORMANCE</div>
          {[
            // Tone by meaning: wins green, losses red, neutral bright — NOT all green
            // (which mislabeled AVG LOSS / WORST TRADE as if they were positive).
            { label: "AVG WIN", value: orders.length ? `$${avgWin.toFixed(2)}` : "—", tone: "pos" },
            { label: "AVG LOSS", value: orders.length ? `$${avgLoss.toFixed(2)}` : "—", tone: "neg" },
            { label: "BEST TRADE", value: orders.length ? `$${bestTrade.toFixed(2)}` : "—", tone: "pos" },
            { label: "WORST TRADE", value: orders.length ? `$${Math.abs(worstTrade).toFixed(2)}` : "—", tone: "neg" },
            { label: "VOLUME", value: volume > 0 ? `$${volume.toFixed(0)}` : "—", tone: "neutral" },
          ].map((r) => (
            <div key={r.label} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: "#52525b", letterSpacing: "0.08em", fontFamily: "var(--nx-font-mono)" }}>{r.label}</div>
              <div style={{ fontSize: 18, color: r.tone === "pos" ? "#3ecf8e" : r.tone === "neg" ? "#f7525f" : "#f4f4f5", fontFamily: "var(--nx-font-mono)" }}>{r.value}</div>
            </div>
          ))}
        </div>
      </div>

      {orders.length > 0 && (
        <div style={{ ...cardStyle, marginBottom: 8 }}>
          <div style={labelStyle}>&#9632; PER-TRADE P&amp;L</div>
          <PnlBars
            values={orders.map((o) => o.pnl)}
            labels={orders.map((o) => {
              const sym = o.symbol.replace("PERP_", "").replace("_USDC", "");
              const d = o.timestamp ? new Date(o.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
              return `${sym} ${o.direction}${d ? ` · ${d}` : ""} · ${o.pnl >= 0 ? "+" : "-"}$${Math.abs(o.pnl).toFixed(2)}`;
            })}
          />
          <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)", marginTop: 4 }}>
            <span style={{ color: "#3ecf8e" }}>■</span> win · <span style={{ color: "#f7525f" }}>■</span> loss · oldest → newest · {orders.length} trades
          </div>
        </div>
      )}

      <TradingScoreSection orders={orders} winRate={winRate} />
      <BreakdownRow orders={orders} />
      <TimingAndRisk orders={orders} />
      <PerformanceAnalysis orders={orders} />
      <TopAssets orders={orders} />

      {/* PROCESS — outcome analytics say how you did; these say how to get better. */}
      <ProcessSection wallet={wallet} theses={theses} orders={orders} />

      {orders.length === 0 && <EmptyState message="no closed trades found" unlock="Connect the wallet you trade with — the Lab reads your Orderly history directly, nothing to import." />}
    </div>
  );
}
