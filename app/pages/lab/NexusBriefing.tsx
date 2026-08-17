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
import { SectionHeader } from "./components";
import type { TabId, ProcessedTrade } from "./types";
import { buildBriefing, buildMarketRead, buildFusion, buildForecastRead, computeTape, type BriefingTrade, type Insight, type MarketSignal, type ForecastRead } from "./briefing";
import { recordFlag, coachingInsight } from "@/lib/coaching.mjs";

const FLAGS_KEY = "nexus_flagged_setups";
const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n) >= 1000 ? `${(Math.abs(n) / 1000).toFixed(1)}K` : Math.abs(n).toFixed(2)}`;

type Consensus = Record<string, { side: "LONG" | "SHORT" | "SPLIT"; lean: number; participants: number }>;

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
    <div style={{ display: "flex", alignItems: "flex-start", gap: 11, padding: "8px 14px", borderBottom: "1px solid #131316", borderLeft: `2px solid ${TONE[ins.tone].bar}` }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: TONE[ins.tone].dot, flexShrink: 0, marginTop: 5 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#f4f4f5", fontWeight: 600, lineHeight: 1.3 }}>{ins.title}</div>
        <div style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: 11.5, color: "#a1a1aa", lineHeight: 1.5, marginTop: 2 }}>{ins.detail}</div>
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
  const [consensus, setConsensus] = useState<Consensus | null>(null);
  const [myContrarian, setMyContrarian] = useState<{ calls: number; avgR: number } | null>(null);
  const [myAlignEdge, setMyAlignEdge] = useState<{ best: { bucket: string; avgR: number } } | null>(null);
  const [forecasts, setForecasts] = useState<ForecastRead[] | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });

  // Market context — all public, all fail-soft. Any that fails simply drops the
  // insights that depend on it; the rest still render.
  useEffect(() => {
    let alive = true;
    fetch(PROXY).then((r) => r.json()).then((j) => { if (alive) setRows(j?.data?.rows ?? []); }).catch(() => { /* no tape/movers */ });
    fetch(`${AGENT_API}/signals`).then((r) => r.json()).then((j) => { if (alive) setSignals(Array.isArray(j?.signals) ? j.signals : []); }).catch(() => { /* no setups */ });
    // /agents/live returns { count, positions:[...] } — count is authoritative.
    fetch(`${AGENT_API}/agents/live`).then((r) => r.json()).then((j) => { if (alive) setLiveAgents(typeof j?.count === "number" ? j.count : (Array.isArray(j?.positions) ? j.positions.length : 0)); }).catch(() => { /* no live count */ });
    // The merit-weighted caller lean per symbol — the graded crowd, for the fusion.
    fetch(`${AGENT_API}/theses/consensus`).then((r) => r.json()).then((j) => { if (alive) setConsensus(j?.consensus ?? null); }).catch(() => { /* no crowd lean */ });
    // Prediction-market forecast divergences — the forecasting crowd vs the tape.
    fetch(`${AGENT_API}/intel/forecasts`).then((r) => r.json()).then((j) => { if (alive) setForecasts(Array.isArray(j?.markets) ? j.markets : []); }).catch(() => { /* no forecast read */ });
    return () => { alive = false; };
  }, []);

  // Agent status — powers the "proven record, no agent running" personal nudge.
  useEffect(() => {
    if (!wallet) { setAgentActive(null); setMyContrarian(null); setMyAlignEdge(null); return; }
    let alive = true;
    fetch(`${AGENT_API}/agent/${wallet}`).then((r) => r.json())
      .then((d) => { if (alive) setAgentActive(!!d?.state?.active); })
      .catch(() => { /* nudge just won't fire */ });
    // My own crowd-fading record + align (with/counter-trend) edge — both feed the fusion.
    fetch(`${AGENT_API}/theses/process/${wallet}`).then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setMyContrarian(d?.contrarian ? { calls: d.contrarian.calls, avgR: d.contrarian.avgR } : null);
        setMyAlignEdge(d?.regimeEdges?.align?.best ? { best: { bucket: d.regimeEdges.align.best.bucket, avgR: d.regimeEdges.align.best.avgR } } : null);
      })
      .catch(() => { /* fusion still fires without it */ });
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

  // ⭐ THE FUSION — is the market's setup MINE? Intersects the crowded-fade signal,
  // the graded caller lean, and my own edge. Leads the briefing when it fires.
  const fusion = useMemo(() => {
    const bt: BriefingTrade[] = trades.map((t) => ({ symbol: t.symbol, direction: t.direction, pnl: t.pnl, timestamp: t.timestamp }));
    return buildFusion({ trades: bt, signals, consensus, tape, contrarian: myContrarian, alignEdge: myAlignEdge }).slice(0, 2);
  }, [trades, signals, consensus, tape, myContrarian, myAlignEdge]);

  // Coaching loop — remember every "your setup" the fusion flags, so follow-through
  // can be measured against your actual trades. Continuity, not a goldfish.
  useEffect(() => {
    const yourSetup = fusion.find((f) => f.id === "fusion-your-setup" && f.meta);
    if (!yourSetup?.meta) return;
    try {
      const cur = JSON.parse(localStorage.getItem(FLAGS_KEY) || "[]");
      localStorage.setItem(FLAGS_KEY, JSON.stringify(recordFlag(cur, yourSetup.meta, Date.now())));
    } catch { /* private mode */ }
  }, [fusion]);

  const coaching = useMemo<Insight | null>(() => {
    if (!wallet || !trades.length) return null;
    let flags: { symbol: string; direction: "LONG" | "SHORT"; ts: number }[] = [];
    try { flags = JSON.parse(localStorage.getItem(FLAGS_KEY) || "[]"); } catch { /* ignore */ }
    const bt = trades.map((t) => ({ symbol: t.symbol, direction: t.direction, pnl: t.pnl, timestamp: t.timestamp }));
    const c = coachingInsight(flags, bt, Date.now());
    if (!c) return null;
    return {
      id: "coaching-followthrough",
      priority: 58,
      tone: c.taken === 0 ? "caution" : "info",
      title: `You acted on ${c.taken} of your last ${c.flags} flagged setups`,
      detail: c.taken === 0
        ? `The Briefing flagged ${c.flags} setups on your side and you took none — the edge only pays if you pull the trigger on it.`
        : `${c.rate}% follow-through${c.takenPnl !== 0 ? `, netting ${money(c.takenPnl)} on the ones you took` : ""}.${c.skipped > 0 ? ` ${c.skipped} you let go by.` : " Discipline on your own signal."}`,
      action: { label: "Your log", tab: "tradelog" },
    };
  }, [wallet, trades, fusion]); // fusion dep → recompute after a fresh flag records

  const market = useMemo(
    () => buildMarketRead({ rows, signals, liveAgents, tape })
      .filter((m) => !fusion.some((f) => f.detail.startsWith(m.title.split(" ")[0]))) // avoid echoing the fusion's symbol read
      .slice(0, (personal.length ? 3 : 3) - Math.min(fusion.length, 1)),
    [rows, signals, liveAgents, tape, personal.length, fusion]
  );

  // Forecast divergence — surfaced when a near-money prediction-market read is
  // offside the tape. De-duped against the fusion's symbol so we don't echo it.
  const forecast = useMemo(
    () => buildForecastRead(forecasts).filter((f) => !fusion.some((x) => x.meta?.symbol === f.meta?.symbol)).slice(0, 1),
    [forecasts, fusion]
  );

  if (!fusion.length && !personal.length && !market.length && !forecast.length) return null;

  const toggle = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(COLLAPSE_KEY, n ? "1" : "0"); } catch { /* ignore */ } return n; });

  const total = fusion.length + personal.length + market.length + forecast.length + (coaching ? 1 : 0);
  const askAi = () => window.dispatchEvent(new CustomEvent("nexus:assistant-ask", {
    detail: {
      prompt: personal.length
        ? "Use get_my_edge and get_market_regime together: given my graded record and the current tape, what is my single highest-quality play right now, and the one habit that's costing me the most? Be specific and blunt."
        : "Use get_market_regime and get_smart_money: read the tape and what the top traders are doing, then tell me the two setups worth watching right now and why. Be specific.",
    },
  }));

  return (
    <div className="nx-fade-in" style={{ marginBottom: 24 }}>
      {/* Editorial header — congruent with THE BOARD + The Market Terminal (eyebrow →
          serif headline → amber rule). The live meta (read type · date · tape) and the
          collapse control ride in the note slot. */}
      <SectionHeader
        eyebrow="// THE BRIEFING"
        title="What matters right now"
        note={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span>
              {personal.length ? "your terminal + the market" : "the market, right now"} · {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              {tape && <span style={{ color: tape.label === "RISK-OFF" ? "#f7525f" : tape.label === "RISK-ON" ? "#ededf0" : "#a1a1aa" }}> · {tape.label} {tape.score}</span>}
            </span>
            <button onClick={toggle} style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", background: "none", border: "1px solid #232327", borderRadius: 3, padding: "3px 8px", cursor: "pointer", letterSpacing: "0.05em" }}>
              {collapsed ? `SHOW (${total})` : "HIDE"}
            </button>
          </span>
        }
      />

      {!collapsed && (
        <div style={{ border: "1px solid #1c1c20", borderRadius: 8, overflow: "hidden", background: "#0c0c0e", marginTop: -6 }}>
          {/* ⭐ The fusion leads — "is this setup mine". Labeled only when other lenses show. */}
          {fusion.length > 0 && (
            <>
              {(personal.length > 0 || market.length > 0) && <GroupLabel text="The read · your edge × the market" />}
              {fusion.map((ins) => <InsightRow key={ins.id} ins={ins} onSelectTab={onSelectTab} />)}
            </>
          )}
          {/* Personal lens next when present, labeled only when other lenses show. */}
          {(personal.length > 0 || coaching) && (
            <>
              {(fusion.length > 0 || market.length > 0) && <GroupLabel text="Your terminal" />}
              {coaching && <InsightRow key={coaching.id} ins={coaching} onSelectTab={onSelectTab} />}
              {personal.map((ins) => <InsightRow key={ins.id} ins={ins} onSelectTab={onSelectTab} />)}
            </>
          )}
          {market.length > 0 && (
            <>
              {(fusion.length > 0 || personal.length > 0) && <GroupLabel text="The market" />}
              {market.map((ins) => <InsightRow key={ins.id} ins={ins} onSelectTab={onSelectTab} />)}
            </>
          )}
          {forecast.length > 0 && (
            <>
              {(fusion.length > 0 || personal.length > 0 || market.length > 0) && <GroupLabel text="Forecasters vs the tape" />}
              {forecast.map((ins) => <InsightRow key={ins.id} ins={ins} onSelectTab={onSelectTab} />)}
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
