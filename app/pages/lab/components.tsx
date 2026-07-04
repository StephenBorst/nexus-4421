// Shared presentational primitives for The Lab.
// Extracted from index.tsx (god-file split) — prop-driven presentational pieces.
import { useCallback, useRef, useState } from "react";

// ─── PnL Chart ───────────────────────────────────────────
// Cumulative-P&L equity curve. Measures its container so the line draws to the
// FULL width (a fixed-viewBox svg stretched to 100% just letterboxes a ~500px
// line in dead space). Gradient area fill + soft glow + zero baseline for depth.
export function PnlChart({ points }: { points: number[] }) {
  const [w, setW] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);
  // Callback ref: fires the moment the chart div attaches (which only happens once
  // data is present), so we measure the real container width deterministically. A
  // plain effect + observer bailed here — it ran during the no-data render while the
  // ref was still null and never re-attached, leaving the chart stuck at a default.
  const measureRef = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!node) return;
    const read = () => { const cw = node.getBoundingClientRect().width; if (cw > 0) setW(cw); };
    read();
    if (typeof ResizeObserver !== "undefined") {
      roRef.current = new ResizeObserver(read);
      roRef.current.observe(node);
    }
  }, []);

  if (points.length < 2) {
    return (
      <div style={{ height: 190, display: "flex", alignItems: "center", justifyContent: "center", color: "#2a4a3a", fontFamily: "var(--nx-font-mono)", fontSize: 11 }}>
        no data yet
      </div>
    );
  }

  const cw = w || 720; // fallback width for the first paint, before the ref measures
  const h = 190, padY = 20, padX = 8;
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points) || 1;
  const range = max - min || 1;
  const iw = Math.max(1, cw - padX * 2);
  const x = (i: number) => padX + (i / (points.length - 1)) * iw;
  const y = (v: number) => padY + (1 - (v - min) / range) * (h - padY * 2);
  const up = points[points.length - 1] >= 0;
  const stroke = up ? "#00ff88" : "#ff5555";
  const line = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const linePath = "M" + line.join(" L");
  // Close the fill to the ZERO baseline (not the chart bottom) so a losing curve
  // reads as a band below breakeven, not a giant block filling the whole panel.
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const zeroY = y(0);
  const showZero = min < 0 && max > 0;
  const lastX = x(points.length - 1), lastY = y(points[points.length - 1]);
  const grid = [0.25, 0.5, 0.75].map((f) => padY + f * (h - padY * 2));
  const gid = "nx-pnl-fill";

  return (
    <div ref={measureRef} style={{ width: "100%", overflow: "hidden" }}>
      <svg width={cw} height={h} viewBox={`0 0 ${cw} ${h}`} style={{ display: "block", maxWidth: "100%", overflow: "hidden" }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="55%" stopColor={stroke} stopOpacity="0.06" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {grid.map((gy, i) => (
          <line key={i} x1={0} y1={gy} x2={cw} y2={gy} stroke="#12201a" strokeWidth="1" />
        ))}
        {showZero && (
          <line x1={0} y1={zeroY} x2={cw} y2={zeroY} stroke="#2a3a2a" strokeWidth="1" strokeDasharray="2 4" />
        )}
        <path d={areaPath} fill={`url(#${gid})`} />
        {/* glow = a wider, faint underlay stroke (pure paint, NOT an svg filter —
            older wallet-webview WebKit doesn't clip filter output to the box). */}
        <path d={linePath} fill="none" stroke={stroke} strokeOpacity="0.18" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" />
        <path d={linePath} fill="none" stroke={stroke} strokeOpacity="0.95" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
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
