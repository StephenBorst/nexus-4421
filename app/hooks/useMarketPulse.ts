import { useEffect, useState } from "react";

// ── Market pulse ─────────────────────────────────────────────────────────────
// A single 0–100 "heat" score for the whole tape (breadth + BTC trend + funding
// crowding), computed from the same public futures feed the Lab's Market Regime
// uses. Drives ambient data-reactivity: the terminal quietly gets livelier when
// the market is risk-on, calmer when risk-off. Cosmetic only — never a trading
// signal — so a lean recompute here (mirroring MarketTape) is fine. Fail-soft:
// returns null until it resolves, and the ambient holds its neutral default.
const PROXY = "https://orderly-proxy.stephenpatrick24.workers.dev";

function pct(open?: unknown, close?: unknown): number {
  const o = parseFloat(String(open ?? 0)), c = parseFloat(String(close ?? 0));
  if (!o || !c) return 0;
  const p = ((c - o) / o) * 100;
  return Math.abs(p) > 50 ? 0 : p; // guard bad ticks
}

interface Row { symbol: string; "24h_open"?: string | number; "24h_close"?: string | number; last_funding_rate?: string | number; }

export function useMarketPulse(): number | null {
  const [score, setScore] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const j = await (await fetch(PROXY)).json();
        const rows: Row[] = j?.data?.rows ?? [];
        if (!rows.length) return;
        const changes = rows.map((m) => pct(m["24h_open"], m["24h_close"]));
        const breadth = Math.round((changes.filter((c) => c > 0).length / changes.length) * 100);
        const btc = rows.find((m) => m.symbol === "PERP_BTC_USDC");
        const btcChg = btc ? pct(btc["24h_open"], btc["24h_close"]) : 0;
        const fundings = rows.map((m) => parseFloat(String(m.last_funding_rate ?? 0))).filter((f) => !isNaN(f));
        const fundSkew = fundings.length ? Math.round((fundings.filter((f) => f > 0).length / fundings.length) * 100) : 50;
        const btcScore = Math.max(0, Math.min(100, 50 + btcChg * 6));
        const fundScore = 100 - Math.abs(fundSkew - 50) * 2;
        const s = Math.round(breadth * 0.5 + btcScore * 0.4 + fundScore * 0.1);
        if (alive) setScore(Math.max(0, Math.min(100, s)));
      } catch { /* fail soft — hold neutral */ }
    };
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return score;
}
