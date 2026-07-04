// Shared presentational primitives for The Lab.
// Extracted from index.tsx (god-file split) — prop-driven presentational pieces.
import { useLayoutEffect, useRef, useState } from "react";

// ─── PnL Chart ───────────────────────────────────────────
// Cumulative-P&L equity curve. Measures its container so the line draws to the
// FULL width (a fixed-viewBox svg stretched to 100% just letterboxes a ~500px
// line in dead space). Gradient area fill + soft glow + zero baseline for depth.
export function PnlChart({ points }: { points: number[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length < 2) {
    return (
      <div style={{ height: 190, display: "flex", alignItems: "center", justifyContent: "center", color: "#2a4a3a", fontFamily: "var(--nx-font-mono)", fontSize: 11 }}>
        no data yet
      </div>
    );
  }

  const h = 190, padY = 20, padX = 2;
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points) || 1;
  const range = max - min || 1;
  const iw = Math.max(1, w - padX * 2);
  const x = (i: number) => padX + (i / (points.length - 1)) * iw;
  const y = (v: number) => padY + (1 - (v - min) / range) * (h - padY * 2);
  const up = points[points.length - 1] >= 0;
  const stroke = up ? "#00ff88" : "#ff5555";
  const line = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const linePath = "M" + line.join(" L");
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${h} L${x(0).toFixed(1)},${h} Z`;
  const zeroY = y(0);
  const showZero = min < 0 && max > 0;
  const lastX = x(points.length - 1), lastY = y(points[points.length - 1]);
  const grid = [0.25, 0.5, 0.75].map((f) => padY + f * (h - padY * 2));
  const gid = "nx-pnl-fill", fid = "nx-pnl-glow";

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block", overflow: "visible" }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="55%" stopColor={stroke} stopOpacity="0.06" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
          <filter id={fid} x="-10%" y="-40%" width="120%" height="180%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {grid.map((gy, i) => (
          <line key={i} x1={0} y1={gy} x2={w} y2={gy} stroke="#12201a" strokeWidth="1" />
        ))}
        {showZero && (
          <line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke="#2a3a2a" strokeWidth="1" strokeDasharray="2 4" />
        )}
        <path d={areaPath} fill={`url(#${gid})`} />
        <path d={linePath} fill="none" stroke={stroke} strokeOpacity="0.92" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" filter={`url(#${fid})`} />
        <circle cx={lastX} cy={lastY} r="6" fill={stroke} fillOpacity="0.18" />
        <circle cx={lastX} cy={lastY} r="3.2" fill={stroke} />
        <circle cx={lastX} cy={lastY} r="3.2" fill="none" stroke="#0a0e0a" strokeWidth="1" />
      </svg>
    </div>
  );
}

// ─── Empty State ─────────────────────────────────────────
export function EmptyState({ message }: { message: string }) {
  return (
    <div style={{ padding: "40px 0", textAlign: "center", color: "#2a4a3a", fontFamily: "var(--nx-font-mono)", fontSize: 12 }}>
      <div style={{ fontSize: 20, marginBottom: 8 }}>&#9632;</div>
      {message}
    </div>
  );
}
