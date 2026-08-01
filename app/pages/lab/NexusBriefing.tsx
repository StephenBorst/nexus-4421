// ◆ THE BRIEFING — the Lab's intelligence layer, made visible.
// Opens the OBSERVE tab with a personalized, deterministic read of YOUR terminal:
// what your record says, what the tape is doing to your open risk, and the one or
// two things worth acting on right now. No LLM required (works for everyone, free,
// instant) — with a one-tap hand-off to NEXUS AI when you want it to go deeper.
import { useEffect, useMemo, useState } from "react";
import type { TabId, ProcessedTrade } from "./types";
import { buildBriefing, computeTape, type BriefingTrade, type Insight } from "./briefing";

const PROXY = "https://orderly-proxy.stephenpatrick24.workers.dev";
const AGENT_API = "https://og.nexustradinglabs.com";
const COLLAPSE_KEY = "nexus_briefing_collapsed";

const TONE: Record<Insight["tone"], { bar: string; dot: string }> = {
  positive: { bar: "#3ecf8e", dot: "#3ecf8e" },
  caution: { bar: "#fbbf24", dot: "#fbbf24" },
  info: { bar: "#33333a", dot: "#71717a" },
};

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
  const [tape, setTape] = useState<{ label: string; score: number } | null>(null);
  const [agentActive, setAgentActive] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });

  // Live tape (public futures) — fail-soft; the personal insights stand without it.
  useEffect(() => {
    let alive = true;
    fetch(PROXY).then((r) => r.json())
      .then((j) => { if (alive) setTape(computeTape(j?.data?.rows ?? [])); })
      .catch(() => { /* no tape context this render */ });
    return () => { alive = false; };
  }, []);

  // Agent status — powers the "proven record, no agent running" nudge. Fail-soft.
  useEffect(() => {
    if (!wallet) { setAgentActive(null); return; }
    let alive = true;
    fetch(`${AGENT_API}/agent/${wallet}`).then((r) => r.json())
      .then((d) => { if (alive) setAgentActive(!!d?.state?.active); })
      .catch(() => { /* leave null → nudge simply won't fire */ });
    return () => { alive = false; };
  }, [wallet]);

  const insights = useMemo(() => {
    const bt: BriefingTrade[] = trades.map((t) => ({ symbol: t.symbol, direction: t.direction, pnl: t.pnl, timestamp: t.timestamp }));
    return buildBriefing({
      trades: bt, winRate, totalPnl, openPositions,
      tape,
      agent: agentActive == null ? null : { active: agentActive },
    }).slice(0, 4);
  }, [trades, winRate, totalPnl, openPositions, tape, agentActive]);

  if (!insights.length) return null; // nothing honest to say yet → render nothing

  const toggle = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(COLLAPSE_KEY, n ? "1" : "0"); } catch { /* ignore */ } return n; });

  const askAi = () => window.dispatchEvent(new CustomEvent("nexus:assistant-ask", {
    detail: { prompt: "Use get_my_edge and get_market_regime together: given my graded record and the current tape, what is my single highest-quality play right now, and the one habit that's costing me the most? Be specific and blunt." },
  }));

  return (
    <div className="nx-fade-in" style={{ border: "1px solid #232327", borderRadius: 8, background: "linear-gradient(180deg,#111113,#0d0d0f)", marginBottom: 16, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: collapsed ? "none" : "1px solid #1c1c20" }}>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", color: "#ededf0" }}>◆ THE BRIEFING</span>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", letterSpacing: "0.06em" }}>
          your terminal, read · {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </span>
        {tape && (
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: tape.label === "RISK-OFF" ? "#f7525f" : tape.label === "RISK-ON" ? "#ededf0" : "#a1a1aa", letterSpacing: "0.06em" }}>
            · {tape.label} {tape.score}
          </span>
        )}
        <button onClick={toggle} style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", background: "none", border: "1px solid #232327", borderRadius: 3, padding: "3px 8px", cursor: "pointer", letterSpacing: "0.05em" }}>
          {collapsed ? `SHOW (${insights.length})` : "HIDE"}
        </button>
      </div>

      {!collapsed && (
        <div>
          {insights.map((ins) => (
            <div key={ins.id} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", borderBottom: "1px solid #131316", borderLeft: `2px solid ${TONE[ins.tone].bar}` }}>
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
          ))}
          {/* Deep-dive hand-off to the copilot */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "9px 14px" }}>
            <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", letterSpacing: "0.05em" }}>deterministic — no AI, no key, just your record</span>
            <button onClick={askAi} style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9.5, letterSpacing: "0.05em", color: "#6cb6ff", background: "none", border: "1px solid #23303f", borderRadius: 4, padding: "5px 10px", cursor: "pointer", whiteSpace: "nowrap" }}>
              ◆ Ask NEXUS AI to go deeper →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
