// Market TAPE — a light, computed (not hand-authored) read of the whole crypto tape,
// derived from the same public futures feed the rest of the app uses. Breadth +
// BTC trend + funding skew → a RISK-ON / NEUTRAL / RISK-OFF score, with an
// agent-linked readout (act on it, don't just display it). No content treadmill.
//
// ⚠️ NAMING — this is the TAPE (market-wide), NOT a "regime". The Lab uses "regime"
// for exactly one thing: the PER-SYMBOL trend/volatility classification that grades
// and attributes calls (classifyRegime in lab-api logic.mjs → Regime Edge, the thesis
// advisor). Both used to be called "regime" in adjacent tabs, which made the word
// meaningless. Market-wide risk appetite = TAPE; per-symbol character = REGIME.
// Keep it that way.
import { useEffect, useMemo, useState } from "react";
import { cardStyle } from "./styles";
import { CountUp } from "./components";

const PROXY = "https://orderly-proxy.stephenpatrick24.workers.dev";

interface Row { symbol: string; "24h_open"?: string | number; "24h_close"?: string | number; last_funding_rate?: string | number; }

function pct(open?: string | number, close?: string | number): number {
  const o = parseFloat(String(open ?? 0)); const c = parseFloat(String(close ?? 0));
  if (!o || !c) return 0;
  const p = ((c - o) / o) * 100;
  return Math.abs(p) > 50 ? 0 : p; // guard bad ticks
}

export function MarketTape() {
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

  const tape = useMemo(() => {
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
    // NEUTRAL is a neutral GREY, not blue — blue is reserved for teaching copy only.
    // Red uses the canonical loss token (was a drifted near-duplicate before).
    const color = score >= 60 ? "#ededf0" : score >= 42 ? "#a1a1aa" : "#f7525f";
    const agentNote =
      label === "RISK-ON"
        ? "Broad strength — momentum/trend presets favored; funding fades are riskier into strength."
        : label === "RISK-OFF"
        ? "Broad weakness — mean-reversion fades + tighter stops; consider cutting agent size."
        : "Rangebound tape — confluence / funding-harvest presets fit best.";
    return { score, label, color, breadth, btcChg, fundSkew, agentNote };
  }, [rows]);

  if (!tape) return null;

  return (
    <div style={{ ...cardStyle, marginBottom: 14 }}>
      {/* Editorial header — mono eyebrow + serif headline + amber rule (Noodles-style). */}
      <div style={{ fontSize: 9, color: "#71717a", letterSpacing: "0.18em", fontFamily: "var(--nx-font-mono)", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 7 }}>
        <span className="nx-live-dot" style={{ width: 5, height: 5 }} /> Market Tape · Live
      </div>
      <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: 30, fontWeight: 400, color: tape.color, lineHeight: 1.15, marginTop: 6, textTransform: "capitalize" }}>
        {tape.label.toLowerCase()}
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg, #ededf0 0%, rgba(237,237,240,0) 55%)", margin: "12px 0 18px", maxWidth: 340 }} />
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 16, alignItems: "center" }}>
        <div style={{ textAlign: "center", minWidth: 120 }}>
          <div style={{ fontSize: 40, fontWeight: "bold", fontFamily: "var(--nx-font-mono)", color: tape.color, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}><CountUp value={tape.score} format={(v) => `${Math.round(v)}`} /></div>
          <div style={{ fontSize: 9, fontFamily: "var(--nx-font-mono)", color: "#52525b", letterSpacing: "0.12em", marginTop: 4 }}>SCORE / 100</div>
          <div style={{ height: 4, background: "#232327", borderRadius: 2, marginTop: 8 }}>
            <div style={{ height: 4, background: tape.color, borderRadius: 2, width: `${tape.score}%` }} />
          </div>
        </div>
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>BREADTH</div>
              <div style={{ fontSize: 16, color: tape.breadth >= 50 ? "#ededf0" : "#f7525f", fontFamily: "var(--nx-font-mono)" }}>{tape.breadth}% up</div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>BTC 24H</div>
              <div style={{ fontSize: 16, color: tape.btcChg >= 0 ? "#ededf0" : "#f7525f", fontFamily: "var(--nx-font-mono)" }}>{tape.btcChg >= 0 ? "+" : ""}{tape.btcChg.toFixed(2)}%</div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#52525b", fontFamily: "var(--nx-font-mono)" }}>FUNDING SKEW</div>
              <div style={{ fontSize: 16, color: "#ededf0", fontFamily: "var(--nx-font-mono)" }}>{tape.fundSkew}% long</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "#a1a1aa", fontFamily: "var(--nx-font-ui)", lineHeight: 1.5, borderTop: "1px solid #232327", paddingTop: 8 }}>
            <span style={{ color: "#71717a" }}>▶ agent:</span> {tape.agentNote}
          </div>
        </div>
      </div>
      {/* Observation → plan: hand the tape + the user's own edge to the copilot. */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent("nexus:assistant-ask", { detail: { prompt: `The market tape is ${tape.label} (score ${tape.score}/100). Use get_market_regime and get_my_edge — what's my best play right now given my strengths, and what should I avoid?` } }))}
        style={{ marginTop: 14, width: "100%", background: "transparent", border: "1px solid #232327", borderRadius: 6, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 11, letterSpacing: "0.04em", padding: "8px 10px", cursor: "pointer", textAlign: "left" }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "#ededf0"; e.currentTarget.style.borderColor = "#33333a"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "#a1a1aa"; e.currentTarget.style.borderColor = "#232327"; }}
      >
        ◆ ask nexus ai — what's my play in this tape?
      </button>
    </div>
  );
}
