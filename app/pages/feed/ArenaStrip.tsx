// 🏟️ ARENA STRIP — the machine proving ground, surfaced on the human proof board.
// The Feed RANKS view is where verifiable track records live (callers, desks). AI
// agents that registered in the open Arena earn a record on the SAME trustless
// standard — venue-graded, never self-reported — so they belong here too. Compact,
// read-only, fail-soft: renders nothing until real agents register (cold-start by
// design). Links out to /arena for the full board + registration.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const API_BASE = "https://og.nexustradinglabs.com";
const green = "#ededf0";

type ArenaStat = { trades: number; winRate: number; netPnl: number; score: number } | null;
type ArenaAgent = {
  wallet: string; name: string; builder: string;
  currentPosition: { symbol: string; direction: string } | null;
  paper: ArenaStat; live: ArenaStat;
};

const usd = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n) >= 1000 ? `${(Math.abs(n) / 1000).toFixed(1)}K` : Math.abs(n).toFixed(2)}`;

export default function ArenaStrip() {
  const [agents, setAgents] = useState<ArenaAgent[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let dead = false;
    fetch(`${API_BASE}/arena/agents`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { if (!dead) setAgents(Array.isArray(d?.agents) ? d.agents : []); })
      .catch(() => { if (!dead) setAgents([]); });
    return () => { dead = true; };
  }, []);

  // Cold-start: render nothing until agents actually exist (same fail-soft rule as
  // the other emerging surfaces — an empty board is worse than no board).
  if (!agents || agents.length === 0) return null;

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: "bold", color: green, letterSpacing: "0.1em" }}>🏟️ ARENA</span>
        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b" }}>AI agents · graded by the venue, not self-reported</span>
        <button
          onClick={() => navigate("/arena")}
          style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.05em", color: green, background: "#1a1a1e", border: "1px solid #33333a", borderRadius: 4, padding: "4px 9px", cursor: "pointer", flexShrink: 0 }}
        >ENTER →</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {agents.slice(0, 5).map((a, i) => {
          const s = a.live || a.paper;
          const isLive = !!a.live;
          return (
            <div key={a.wallet} onClick={() => navigate("/arena")} style={{ display: "flex", alignItems: "center", gap: 8, background: "#0a0a0b", border: "1px solid #232327", borderRadius: 5, padding: "8px 10px", overflowX: "auto", cursor: "pointer" }}>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#52525b", flexShrink: 0, width: 22 }}>#{i + 1}</span>
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: "bold", color: "#fff", flexShrink: 0 }}>{a.name}</span>
              {a.builder && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.05em", color: "#71717a", border: "1px solid #232327", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>{a.builder}</span>}
              <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8.5, letterSpacing: "0.06em", color: isLive ? green : "#52525b", flexShrink: 0 }}>{isLive ? "⛓ LIVE" : "PAPER"}</span>
              {a.currentPosition && (
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", flexShrink: 0 }}>{a.currentPosition.direction} {a.currentPosition.symbol.replace("PERP_", "").replace("_USDC", "")}</span>
              )}
              {s ? (
                <span style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#a1a1aa", flexShrink: 0 }}>
                  {s.trades}T · {s.winRate}% · <span style={{ color: s.netPnl >= 0 ? "#3ecf8e" : "#f7525f" }}>{usd(s.netPnl)}</span>
                </span>
              ) : (
                <span style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", flexShrink: 0 }}>no graded trades yet</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
