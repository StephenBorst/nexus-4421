// ◆ THE BRIEFING — the Lab's intelligence layer, made visible.
// Two lenses, one voice:
//   • THE MARKET — a general, wallet-free read of what's going on right now (tape,
//     crowded funding, confluence setups, movers, live agents). So the Lab feels
//     intelligent to ANYONE, connected or not.
//   • YOUR TERMINAL — a personalized read of your graded record + open risk (only
//     when connected with trades).
// Deterministic (no LLM, no key, instant), with a one-tap hand-off to NEXUS AI to
// go deeper. Renders nothing when there's genuinely nothing to say (cold-start safe).
import { useEffect, useMemo, useState } from "react";
import type { TabId, ProcessedTrade } from "./types";
import { buildBriefing, buildMarketRead, computeTape, type BriefingTrade, type Insight, type MarketSignal } from "./briefing";

const PROXY = "https://orderly-proxy.stephenpatrick24.workers.dev";
const AGENT_API = "https://og.nexustradinglabs.com";
const COLLAPSE_KEY = "nexus_briefing_collapsed";

const TONE: Record<Insight["tone"], { bar: string; dot: string }> = {
  positive: { bar: "#3ecf8e", dot: "#3ecf8e" },
  caution: { bar: "#fbbf24", dot: "#fbbf24" },
  info: { bar: "#33333a", dot: "#71717a" },
};

function InsightRow({ ins, onSelectTab }: { ins: Insight; onSelectTab: (t: TabId) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", borderBottom: "1px solid #131316", borderLeft: `2px solid ${TONE[ins.tone].bar}` }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: TONE[ins.tone].dot, flexShrink: 0, marginTop: 5 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12.5, color: "#f4f4f5", fontWeight: 600, lineHeight: 1.35 }}>{ins.title}</div>
        <div style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: 12, color: "#a1a1aa", lineHeight: 1.55, marginTop: 3 }}>{ins.detail}</div>
      </div>
      {ins.action?.tab && (
        <button
          onClick={() => onSelectTab(ins.action!.tab as TabId)}
          className="nx-btn"
          style={{ flexShrink: 0, fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.05em", color: "#ededf0", background: "#1a1a1e", border: "1px solid #33333a", borderRadius: 4, padding: "5px 10px", cursor: "pointer", whiteSpace: "nowrap" }}
        >{ins.action.label} →</button>
      )}
    </div>
  );
}

function GroupLabel({ text }: { text: string }) {
  return (
    <div style={{ padding: "9px 14px 5px", fontFamily: "var(--nx-font-mono)", fontSize: 8.5, letterSpacing: "0.2em", color: "#52525b", textTransform: "uppercase", background: "#0d0d0f" }}>{text}</div>
  );
}

export function NexusBriefing({
  trades, winRate, totalPnl, openPositions, wallet, onSelectTab,
}: {
  trades: ProcessedTrade[];
  winRate: number;
  totalPnl: number;
  openPositions: { symbol: string; direction: "LONG" | "SHORT" }[];
  wallet: string | null;
  onSelectTab: (t: TabId) => void;
}) {
  const [rows, setRows] = useState<{ symbol: string; "24h_open"?: string | number; "24h_close"?: string | number }[] | null>(null);
  const [signals, setSignals] = useState<MarketSignal[] | null>(null);
  const [liveAgents, setLiveAgents] = useState<number | null>(null);
  const [agentActive, setAgentActive] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });

  // Market context — all public, all fail-soft. Any that fails simply drops the
  // insights that depend on it; the rest still render.
  useEffect(() => {
    let alive = true;
    fetch(PROXY).then((r) => r.json()).then((j) => { if (alive) setRows(j?.data?.rows ?? []); }).catch(() => { /* no tape/movers */ });
    fetch(`${AGENT_API}/signals`).then((r) => r.json()).then((j) => { if (alive) setSignals(Array.isArray(j?.signals) ? j.signals : []); }).catch(() => { /* no setups */ });
    fetch(`${AGENT_API}/agents/live`).then((r) => r.json()).then((j) => { if (alive) setLiveAgents(Array.isArray(j?.rows) ? j.rows.length : (Array.isArray(j) ? j.length : 0)); }).catch(() => { /* no live count */ });
    return () => { alive = false; };
  }, []);

  // Agent status — powers the "proven record, no agent running" personal nudge.
  useEffect(() => {
    if (!wallet) { setAgentActive(null); return; }
    let alive = true;
    fetch(`${AGENT_API}/agent/${wallet}`).then((r) => r.json())
      .then((d) => { if (alive) setAgentActive(!!d?.state?.active); })
      .catch(() => { /* nudge just won't fire */ });
    return () => { alive = false; };
  }, [wallet]);

  const tape = useMemo(() => computeTape(rows), [rows]);

  const personal = useMemo(() => {
    if (!wallet || !trades.length) return [];
    const bt: BriefingTrade[] = trades.map((t) => ({ symbol: t.symbol, direction: t.direction, pnl: t.pnl, timestamp: t.timestamp }));
    return buildBriefing({
      trades: bt, winRate, totalPnl, openPositions, tape,
      agent: agentActive == null ? null : { active: agentActive },
    }).slice(0, 3);
  }, [wallet, trades, winRate, totalPnl, openPositions, tape, agentActive]);

  const market = useMemo(
    () => buildMarketRead({ rows, signals, liveAgents, tape }).slice(0, personal.length ? 3 : 4),
    [rows, signals, liveAgents, tape, personal.length]
  );

  if (!personal.length && !market.length) return null;

  const toggle = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(COLLAPSE_KEY, n ? "1" : "0"); } catch { /* ignore */ } return n; });

  const total = personal.length + market.length;
  const askAi = () => window.dispatchEvent(new CustomEvent("nexus:assistant-ask", {
    detail: {
      prompt: personal.length
        ? "Use get_my_edge and get_market_regime together: given my graded record and the current tape, what is my single highest-quality play right now, and the one habit that's costing me the most? Be specific and blunt."
        : "Use get_market_regime and get_smart_money: read the tape and what the top traders are doing, then tell me the two setups worth watching right now and why. Be specific.",
    },
  }));

  return (
    <div className="nx-fade-in" style={{ border: "1px solid #232327", borderRadius: 8, background: "linear-gradient(180deg,#111113,#0d0d0f)", marginBottom: 16, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: collapsed ? "none" : "1px solid #1c1c20" }}>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", color: "#ededf0" }}>◆ THE BRIEFING</span>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", letterSpacing: "0.06em" }}>
          {personal.length ? "your terminal + the market, read" : "the market, right now"} · {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </span>
        {tape && (
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: tape.label === "RISK-OFF" ? "#f7525f" : tape.label === "RISK-ON" ? "#ededf0" : "#a1a1aa", letterSpacing: "0.06em" }}>
            · {tape.label} {tape.score}
          </span>
        )}
        <button onClick={toggle} style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", background: "none", border: "1px solid #232327", borderRadius: 3, padding: "3px 8px", cursor: "pointer", letterSpacing: "0.05em" }}>
          {collapsed ? `SHOW (${total})` : "HIDE"}
        </button>
      </div>

      {!collapsed && (
        <div>
          {/* Personal lens first when present, labeled only when both lenses show. */}
          {personal.length > 0 && (
            <>
              {market.length > 0 && <GroupLabel text="Your terminal" />}
              {personal.map((ins) => <InsightRow key={ins.id} ins={ins} onSelectTab={onSelectTab} />)}
            </>
          )}
          {market.length > 0 && (
            <>
              {personal.length > 0 && <GroupLabel text="The market" />}
              {market.map((ins) => <InsightRow key={ins.id} ins={ins} onSelectTab={onSelectTab} />)}
            </>
          )}
          {/* Deep-dive hand-off to the copilot */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "9px 14px" }}>
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", letterSpacing: "0.05em" }}>deterministic — no AI, no key, just the data</span>
            <button onClick={askAi} style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9.5, letterSpacing: "0.05em", color: "#6cb6ff", background: "none", border: "1px solid #23303f", borderRadius: 4, padding: "5px 10px", cursor: "pointer", whiteSpace: "nowrap" }}>
              ◆ Ask NEXUS AI to go deeper →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
