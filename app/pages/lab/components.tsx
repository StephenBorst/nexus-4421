// Shared presentational primitives for The Lab.
// Extracted from index.tsx (god-file split) — pure, prop-driven, no behavior change.

// ─── PnL Chart ───────────────────────────────────────────
export function PnlChart({ points }: { points: number[] }) {
  if (points.length < 2) {
    return (
      <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: "#2a4a3a", fontFamily: "var(--nx-font-mono)", fontSize: 11 }}>
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
export function EmptyState({ message }: { message: string }) {
  return (
    <div style={{ padding: "40px 0", textAlign: "center", color: "#2a4a3a", fontFamily: "var(--nx-font-mono)", fontSize: 12 }}>
      <div style={{ fontSize: 20, marginBottom: 8 }}>&#9632;</div>
      {message}
    </div>
  );
}
