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

  const pad = 4;
  let path = "";
  let up = true;
  let changePct: number | null = null;
  if (closes && closes.length > 1) {
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const stepX = (width - pad * 2) / (closes.length - 1);
    path = closes
      .map((c, i) => {
        const x = pad + i * stepX;
        const y = pad + (1 - (c - min) / span) * (height - pad * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    up = closes[closes.length - 1] >= closes[0];
    changePct = closes[0] ? ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100 : null;
  }
  const color = up ? "#00ff88" : "#ff4444";

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: "0.1em", color: "#3a6a4a" }}>24H · 15m</span>
        {changePct != null && (
          <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: "bold", color }}>
            {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
          </span>
        )}
      </div>
      <svg width={width} height={height} style={{ display: "block", background: "#0a0e0a", border: "1px solid #1a2e1a", borderRadius: 4 }}>
        {path ? (
          <>
            <path d={`${path} L${width - pad},${height} L${pad},${height} Z`} fill={color} opacity={0.07} />
            <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
          </>
        ) : (
          <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" fontFamily="monospace" fontSize={10} fill="#2a4a3a">
            {failed ? "chart unavailable" : "loading chart…"}
          </text>
        )}
      </svg>
    </div>
  );
}
