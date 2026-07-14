/**
 * MiniPriceChart — lightweight SVG price sparkline for a perp symbol.
 *
 * Pulls public OHLC from Orderly's /tv/history (the same endpoint call-grading
 * uses) and draws a single line — no heavy TradingView widget. 24h @ 15m by
 * default. Fail-soft: renders a thin placeholder if the fetch hiccups.
 */

import { useEffect, useRef, useState } from "react";

const ORDERLY_API = "https://api-evm.orderly.org";

export function MiniPriceChart({ symbol, height = 96 }: { symbol: string; height?: number }) {
  const [closes, setCloses] = useState<number[] | null>(null);
  const [failed, setFailed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(420);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 420));
    ro.observe(el);
    setWidth(el.clientWidth || 420);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCloses(null);
    setFailed(false);
    const now = Math.floor(Date.now() / 1000);
    const from = now - 24 * 3600; // 24h
    fetch(`${ORDERLY_API}/tv/history?symbol=${symbol}&resolution=15&from=${from}&to=${now}`, { headers: { accept: "application/json" } })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.s === "ok" && Array.isArray(j.c) && j.c.length > 1) setCloses(j.c.map(Number));
        else setFailed(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [symbol]);

  const pad = 6;
  let path = "";
  let up = true;
  let changePct: number | null = null;
  let min = 0, max = 0, lastX = 0, lastY = 0;
  const fmtPx = (v: number) => v >= 1000 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(4)}`;
  if (closes && closes.length > 1) {
    min = Math.min(...closes);
    max = Math.max(...closes);
    const span = max - min || 1;
    const stepX = (width - pad * 2) / (closes.length - 1);
    const yOf = (c: number) => pad + (1 - (c - min) / span) * (height - pad * 2);
    path = closes.map((c, i) => `${i === 0 ? "M" : "L"}${(pad + i * stepX).toFixed(1)},${yOf(c).toFixed(1)}`).join(" ");
    up = closes[closes.length - 1] >= closes[0];
    changePct = closes[0] ? ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100 : null;
    lastX = pad + (closes.length - 1) * stepX;
    lastY = yOf(closes[closes.length - 1]);
  }
  const color = up ? "#3ecf8e" : "#f7525f";
  const gid = `mpc-${up ? "u" : "d"}`;

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "#71717a" }}>24H · 15m</span>
        {changePct != null && (
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: "bold", color }}>
            {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
          </span>
        )}
      </div>
      <svg width={width} height={height} style={{ display: "block", background: "#0a0a0b", border: "1px solid #232327", borderRadius: 6 }}>
        {path ? (
          <>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            {/* faint reference grid */}
            {[0.5].map((f) => (
              <line key={f} x1={pad} x2={width - pad} y1={pad + f * (height - pad * 2)} y2={pad + f * (height - pad * 2)} stroke="#ffffff" strokeOpacity={0.05} strokeDasharray="2 3" />
            ))}
            <path d={`${path} L${lastX.toFixed(1)},${height - pad} L${pad},${height - pad} Z`} fill={`url(#${gid})`} />
            <path d={path} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
            {/* emphasized endpoint */}
            <circle cx={lastX} cy={lastY} r={5} fill={color} opacity={0.18} />
            <circle cx={lastX} cy={lastY} r={2.4} fill={color} />
            {/* high / low reference labels */}
            <text x={width - pad} y={pad + 9} textAnchor="end" fontFamily="var(--nx-font-mono)" fontSize={8.5} fill="#52525b">{fmtPx(max)}</text>
            <text x={width - pad} y={height - pad - 3} textAnchor="end" fontFamily="var(--nx-font-mono)" fontSize={8.5} fill="#52525b">{fmtPx(min)}</text>
          </>
        ) : (
          <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" fontFamily="monospace" fontSize={10} fill="#33333a">
            {failed ? "chart unavailable" : "loading chart…"}
          </text>
        )}
      </svg>
    </div>
  );
}
