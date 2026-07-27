// ── Agent leaf components ──
// Extracted from AgentView.tsx (god-file split). Self-contained, prop-driven pieces
// with no dependency on AgentView's state — they were the easy 100 lines to lift out
// of a 2.4k-line file, and lifting them makes both independently readable.
//
// ⚠️ Mechanical move: markup and behavior are unchanged from what shipped.
import { useEffect, useState } from "react";
import type { AgentTrade } from "./types";
import { agentCardStyle, agentLabelStyle, agentInputStyle, navBtnStyle } from "./styles";

/**
 * Number input that holds its own text state so you can clear/edit freely
 * (empty, "0.", "1.2" mid-type) without the controlled value snapping back to 0
 * or fighting the cursor. Commits a valid number as you type; normalizes on blur.
 */
export function NumberField({ value, onCommit, min, max, step }: {
  value: number; onCommit: (n: number) => void; min?: number; max?: number; step?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      value={text}
      min={min} max={max} step={step}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseFloat(e.target.value);
        if (!isNaN(n)) onCommit(n);
      }}
      onBlur={() => {
        const n = parseFloat(text);
        const final = isNaN(n) ? (min ?? 0) : n;
        onCommit(final);
        setText(String(final));
      }}
      style={{ ...agentInputStyle, width: "70%" }}
    />
  );
}

/**
 * An opt-in agent guardrail: label, explanation, ON/OFF. Three of these were
 * copy-pasted in the config tab (tape filter, smart-money filter, volatility-scaled
 * stops) — identical markup differing only in copy and accent, which is how the
 * fourth one would have been written too.
 *
 * ⚠️ `accent` is a parameter only because the smart-money toggle shipped green while
 * the others are bone. That's inherited, and this refactor preserves it rather than
 * silently restyling live UI — but green is supposed to be reserved for P&L, so the
 * right end state is one accent here and no prop at all.
 */
export function AgentToggleCard({ label, description, on, onToggle, accent = "#ededf0" }: {
  label: string;
  description: React.ReactNode;
  on: boolean;
  onToggle: () => void;
  accent?: string;
}) {
  return (
    <div style={agentCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <div style={agentLabelStyle}>{label}</div>
          <div style={{ ...agentLabelStyle, fontSize: 9, marginTop: 6, color: "#71717a", letterSpacing: 0 }}>
            {description}
          </div>
        </div>
        <button onClick={onToggle}
          style={{
            flexShrink: 0, cursor: "pointer", fontFamily: "var(--nx-font-mono)", fontSize: 11, borderRadius: 4, padding: "6px 16px",
            background: on ? `${accent}15` : "#0a0a0b",
            border: `1px solid ${on ? accent : "#232327"}`,
            color: on ? accent : "#71717a",
          }}>
          {on ? "ON" : "OFF"}
        </button>
      </div>
    </div>
  );
}

// ─── Agent Track Record (shared by live + paper) ─────────
export function AgentTrackRecord({ title, accent, trades, paper, onReset, summary }: {
  title: string;
  accent: string;
  trades: AgentTrade[];
  paper?: boolean;
  onReset?: () => void;
  // Server-side FULL aggregate (all trades, not the last-50 the GET ships). When
  // present it drives the headline numbers so a long-running agent's record isn't
  // undercounted; falls back to computing from `trades` (paper has no server side).
  summary?: { trades: number; winRate: number; netPnl: number; avgWin: number; avgLoss: number; firstTradeAt?: number } | null;
}) {
  const useSummary = !!summary && (summary.trades ?? 0) > 0;
  const tr = useSummary ? summary!.trades : trades.length;
  const wr = useSummary ? summary!.winRate : (trades.length ? (trades.filter((t) => t.pnl > 0).length / trades.length) * 100 : 0);
  const net = useSummary ? summary!.netPnl : trades.reduce((s, t) => s + t.pnl, 0);
  const winsArr = trades.filter((t) => t.pnl > 0);
  const lossArr = trades.filter((t) => t.pnl <= 0);
  const avgWin = useSummary ? summary!.avgWin : (winsArr.length ? winsArr.reduce((s, t) => s + t.pnl, 0) / winsArr.length : 0);
  const avgLoss = useSummary ? summary!.avgLoss : (lossArr.length ? lossArr.reduce((s, t) => s + Math.abs(t.pnl), 0) / lossArr.length : 0);
  const sinceMs = useSummary && summary!.firstTradeAt
    ? summary!.firstTradeAt
    : (trades.length ? Math.min(...trades.map((t) => new Date(t.opened_at).getTime() || Date.now())) : 0);
  const since = sinceMs ? new Date(sinceMs).toLocaleDateString() : null;

  return (
    <div style={{ ...agentCardStyle, borderColor: tr > 0 ? (net >= 0 ? "#33333a" : "#4a1e22") : "#232327" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ ...agentLabelStyle, color: accent }}>{title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {since && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>since {since}</span>}
          {onReset && tr > 0 && (
            <button onClick={onReset} style={{ ...navBtnStyle, fontSize: 9, padding: "3px 10px", color: "#d4d4d8", borderColor: "#33333a" }}>RESET</button>
          )}
        </div>
      </div>
      {tr === 0 ? (
        <div style={{ color: "#71717a", fontFamily: "var(--nx-font-ui)", fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
          {paper
            ? <>No paper trades yet — switch to 🧪 PAPER and activate to build a simulated track record against live prices. Risk-free.</>
            : <>No live track record yet — this agent hasn&apos;t traded for you. Stats build here transparently from its first trade. <strong style={{ color: "#a1a1aa" }}>Start small.</strong></>}
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))", gap: 12, marginTop: 8 }}>
            {[
              { label: "NET P&L", value: `${net >= 0 ? "+" : "-"}$${Math.abs(net).toFixed(2)}`, color: net >= 0 ? "#3ecf8e" : "#f7525f" },
              { label: "WIN RATE", value: `${wr.toFixed(1)}%`, color: wr >= 50 ? "#3ecf8e" : "#f7525f" },
              { label: "TRADES", value: String(tr), color: "#d4d4d8" },
              { label: "AVG WIN", value: `$${avgWin.toFixed(2)}`, color: "#ededf0" },
              { label: "AVG LOSS", value: `$${avgLoss.toFixed(2)}`, color: "#f7525f" },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div style={{ ...agentLabelStyle, fontSize: 9 }}>{label}</div>
                <div style={{ color, fontFamily: "var(--nx-font-mono)", fontSize: 16, fontWeight: 600 }}>{value}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, fontFamily: "var(--nx-font-ui)", fontSize: 9, color: "#52525b", lineHeight: 1.5 }}>
            {paper
              ? "🧪 Simulated results — paper trades never touch the exchange. A great paper record is encouraging, not a guarantee."
              : "⚠ Past performance does not guarantee future results. Markets are risky — only deploy capital you can afford to lose, and start small."}
          </div>
        </>
      )}
    </div>
  );
}
