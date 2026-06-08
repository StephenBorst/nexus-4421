// Market Regime — a light, computed (not hand-authored) read of the crypto tape,
// derived from the same public futures feed the rest of the app uses. Breadth +
// BTC trend + funding skew → a RISK-ON / NEUTRAL / RISK-OFF score, with an
// agent-linked readout (act on it, don't just display it). No content treadmill.
import { useEffect, useMemo, useState } from "react";
import { cardStyle } from "./styles";

const PROXY = "https://orderly-proxy.stephenpatrick24.workers.dev";

interface Row { symbol: string; "24h_open"?: string | number; "24h_close"?: string | number; last_funding_rate?: string | number; }

function pct(open?: string | number, close?: string | number): number {
  const o = parseFloat(String(open ?? 0)); const c = parseFloat(String(close ?? 0));
  if (!o || !c) return 0;
  const p = ((c - o) / o) * 100;
  return Math.abs(p) > 50 ? 0 : p; // guard bad ticks
}

export function MarketRegime() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(PROXY);
        const j = await r.json();
        if (alive) setRows(j?.data?.rows ?? []);
      } catch { /* fail soft */ }
    };
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const regime = useMemo(() => {
    if (!rows || !rows.length) return null;
    const changes = rows.map((m) => pct(m["24h_open"], m["24h_close"]));
    const up = changes.filter((c) => c > 0).length;
    const breadth = Math.round((up / changes.length) * 100);
    const btc = rows.find((m) => m.symbol === "PERP_BTC_USDC");
    const btcChg = btc ? pct(btc["24h_open"], btc["24h_close"]) : 0;
    const fundings = rows.map((m) => parseFloat(String(m.last_funding_rate ?? 0))).filter((f) => !isNaN(f));
    const fundPos = fundings.filter((f) => f > 0).length;
    const fundSkew = fundings.length ? Math.round((fundPos / fundings.length) * 100) : 50;
    // composite: breadth 50%, BTC trend 40%, funding crowding 10% (crowded longs = mild caution)
    const btcScore = Math.max(0, Math.min(100, 50 + btcChg * 6));
    const fundScore = 100 - Math.abs(fundSkew - 50) * 2; // extreme one-sided funding = lower
    const score = Math.round(breadth * 0.5 + btcScore * 0.4 + fundScore * 0.1);
    const label = score >= 60 ? "RISK-ON" : score >= 42 ? "NEUTRAL" : "RISK-OFF";
    const color = score >= 60 ? "#00ff88" : score >= 42 ? "#fbbf24" : "#ff4c6a";
    const agentNote =
      label === "RISK-ON"
        ? "Broad strength — momentum/trend presets favored; funding fades are riskier into strength."
        : label === "RISK-OFF"
        ? "Broad weakness — mean-reversion fades + tighter stops; consider cutting agent size."
        : "Rangebound tape — confluence / funding-harvest presets fit best.";
    return { score, label, color, breadth, btcChg, fundSkew, agentNote };
  }, [rows]);

  if (!regime) return null;

  return (
    <div style={{ ...cardStyle, marginBottom: 14 }}>
      <div style={{ fontSize: 10, color: "#00ff88", letterSpacing: "0.1em", marginBottom: 12, fontFamily: "monospace" }}>
        &#9632; MARKET REGIME <span style={{ color: "#3a6a4a" }}>— live, computed</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 16, alignItems: "center" }}>
        <div style={{ textAlign: "center", minWidth: 120 }}>
          <div style={{ fontSize: 40, fontWeight: "bold", fontFamily: "monospace", color: regime.color, lineHeight: 1 }}>{regime.score}</div>
          <div style={{ fontSize: 12, fontFamily: "monospace", color: regime.color, letterSpacing: "0.1em", marginTop: 4 }}>{regime.label}</div>
          <div style={{ height: 4, background: "#1a2e1a", borderRadius: 2, marginTop: 8 }}>
            <div style={{ height: 4, background: regime.color, borderRadius: 2, width: `${regime.score}%` }} />
          </div>
        </div>
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>BREADTH</div>
              <div style={{ fontSize: 16, color: regime.breadth >= 50 ? "#00ff88" : "#ff4c6a", fontFamily: "monospace" }}>{regime.breadth}% up</div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>BTC 24H</div>
              <div style={{ fontSize: 16, color: regime.btcChg >= 0 ? "#00ff88" : "#ff4c6a", fontFamily: "monospace" }}>{regime.btcChg >= 0 ? "+" : ""}{regime.btcChg.toFixed(2)}%</div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#3a5a4a", fontFamily: "monospace" }}>FUNDING SKEW</div>
              <div style={{ fontSize: 16, color: "#fbbf24", fontFamily: "monospace" }}>{regime.fundSkew}% long</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "#6a8a7a", fontFamily: "monospace", lineHeight: 1.5, borderTop: "1px solid #1a2e1a", paddingTop: 8 }}>
            <span style={{ color: "#3a6a4a" }}>▶ agent:</span> {regime.agentNote}
          </div>
        </div>
      </div>
    </div>
  );
}
