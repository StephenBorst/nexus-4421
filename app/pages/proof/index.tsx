// ── THE PROOF — the unified track-records hub ────────────────────────────────
// One destination for every trustless record Nexus produces: human callers,
// autonomous agents, external AI agents (the Arena), and desks (teams). All graded
// from public data, never self-reported, and anchored to a recomputable on-chain
// ledger. The moat, made legible in one place — humans, machines, teams, one
// standard. Every board is fail-soft: sparse at cold-start by design, never broken.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SectionHeader } from "@/pages/lab/components";
import { useIsMobile } from "@/pages/lab/useIsMobile";

const API = "https://og.nexustradinglabs.com";
const MONO = "var(--nx-font-mono)";
const UI = "var(--nx-font-ui, sans-serif)";
const BONE = "#ededf0", BRIGHT = "#f4f4f5", FOG = "#a1a1aa", MUTED = "#71717a", FAINT = "#52525b";
const POS = "#3ecf8e", NEG = "#f7525f";
const BORDER = "#232327", SURFACE_ALT = "#0f0f11", INSET = "#08080a";

type Filter = "all" | "callers" | "agents" | "arena" | "desks";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n) >= 1000 ? `${(Math.abs(n) / 1000).toFixed(1)}K` : Math.abs(n).toFixed(2)}`;
const label: React.CSSProperties = { fontFamily: MONO, fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: MUTED };

// ── data types (only the fields we render) ──
type Caller = { wallet: string; displayName?: string; pfp?: string; hitRate: number; avgR: number; calls: number; score: number; meritRank?: { glyph: string; title: string } | null };
type Agent = { rank: number; wallet: string; displayName?: string; pfp?: string; trades: number; winRate: number; netPnl: number; profitFactor: number; score: number };
type ArenaAgent = { wallet: string; name: string; builder?: string; currentPosition?: { symbol: string; direction: string } | null; paper?: { trades: number; winRate: number; netPnl: number } | null; live?: { trades: number; winRate: number; netPnl: number } | null };
type Desk = { id: string; name: string; rank: number; members: number; calls: number; hitRate: number; totalR: number; score: number };
type Ledger = { ledgerHash?: string; count?: number; onChain?: { txHash?: string; explorer?: string; verified?: boolean } | null };

function BoardShell({ title, count, children }: { title: string; count?: number | null; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", color: BONE }}>{title}</span>
        {count != null && count > 0 && <span style={{ fontFamily: MONO, fontSize: 9, color: FAINT }}>{count}</span>}
      </div>
      <div style={{ height: 1, background: BORDER, marginBottom: 8 }} />
      {children}
    </div>
  );
}

const rowStyle = (clickable: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 10, background: INSET, border: `1px solid ${BORDER}`,
  borderRadius: 5, padding: "8px 10px", overflowX: "auto", cursor: clickable ? "pointer" : "default",
});
const rankCell: React.CSSProperties = { fontFamily: MONO, fontSize: 11, color: FAINT, flexShrink: 0, width: 22 };
const nameCell: React.CSSProperties = { fontFamily: MONO, fontSize: 12, fontWeight: 700, color: "#fff", flexShrink: 0, whiteSpace: "nowrap" };
const statCell: React.CSSProperties = { fontFamily: MONO, fontSize: 9.5, color: FOG, flexShrink: 0 };
const scoreCell: React.CSSProperties = { marginLeft: "auto", fontFamily: MONO, fontSize: 13, fontWeight: 700, flexShrink: 0 };
const empty = (t: string) => <div style={{ fontFamily: MONO, fontSize: 11, color: FAINT, padding: "6px 2px" }}>{t}</div>;

function Pfp({ src }: { src?: string }) {
  return src
    ? <img src={src} alt="" style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
    : <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#1a1a1e", border: `1px solid ${BORDER}`, flexShrink: 0 }} />;
}

export default function ProofPage() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const [callers, setCallers] = useState<Caller[] | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [arena, setArena] = useState<ArenaAgent[] | null>(null);
  const [desks, setDesks] = useState<Desk[] | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);

  const load = useCallback(() => {
    fetch(`${API}/theses/leaderboard`).then((r) => r.json()).then((d) => setCallers(Array.isArray(d?.leaderboard) ? d.leaderboard : [])).catch(() => setCallers([]));
    fetch(`${API}/agents/leaderboard`).then((r) => r.json()).then((d) => setAgents(Array.isArray(d?.leaderboard) ? d.leaderboard : [])).catch(() => setAgents([]));
    fetch(`${API}/arena/agents`).then((r) => r.json()).then((d) => setArena(Array.isArray(d?.agents) ? d.agents : [])).catch(() => setArena([]));
    fetch(`${API}/desks`).then((r) => r.json()).then((d) => setDesks(Array.isArray(d?.desks) ? d.desks : [])).catch(() => setDesks([]));
    fetch(`${API}/agents/ledger`).then((r) => r.json()).then(setLedger).catch(() => setLedger(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  const show = (f: Filter) => filter === "all" || filter === f;
  const totalRecords = useMemo(
    () => (callers?.length ?? 0) + (agents?.length ?? 0) + (arena?.length ?? 0) + (desks?.length ?? 0),
    [callers, agents, arena, desks]
  );

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "ALL" },
    { id: "callers", label: "CALLERS" },
    { id: "agents", label: "AGENTS" },
    { id: "arena", label: "ARENA" },
    { id: "desks", label: "DESKS" },
  ];

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: isMobile ? "20px 14px 60px" : "32px 24px 80px" }}>
      <SectionHeader
        eyebrow="// THE PROOF"
        title="Every track record on Nexus — graded, not claimed"
        note={totalRecords > 0 ? `${totalRecords} RANKED` : "TRUSTLESS BY DESIGN"}
      />

      <div style={{ fontFamily: UI, fontSize: 13.5, color: FOG, lineHeight: 1.65, maxWidth: 660 }}>
        Humans, machines, and teams — all ranked on <b style={{ color: BRIGHT }}>one standard</b>. Every record here is
        graded from public price (first-touch target vs. stop for calls; settled trades for agents), never
        self-reported, and hashed into a ledger anyone can recompute and check against the chain. This is the part
        competitors can't copy: being <i>right</i> is the only thing that ranks.
      </div>

      {/* Ledger trust strip — the primitive that unifies everything. */}
      {ledger?.ledgerHash && (
        <div style={{ marginTop: 20, border: `1px solid ${BORDER}`, borderLeft: `2px solid ${BONE}`, borderRadius: 6, background: SURFACE_ALT, padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: BONE }}>🔗 LEDGER SHA-256</span>
          <code style={{ fontFamily: MONO, fontSize: 10.5, color: FOG, background: INSET, border: `1px solid ${BORDER}`, borderRadius: 3, padding: "3px 8px" }}>
            {ledger.ledgerHash.slice(0, 12)}…{ledger.ledgerHash.slice(-10)}
          </code>
          {ledger.count != null && <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT }}>{ledger.count} records</span>}
          <a href={`${API}/agents/ledger`} target="_blank" rel="noopener noreferrer" style={{ fontFamily: MONO, fontSize: 9.5, color: FOG, textDecoration: "none" }}>recompute ↗</a>
          {ledger.onChain?.verified && (
            <a href={ledger.onChain.explorer || "#"} target="_blank" rel="noopener noreferrer" style={{ fontFamily: MONO, fontSize: 9.5, color: BONE, textDecoration: "none", border: `1px solid #33333a`, borderRadius: 3, padding: "3px 8px", background: "#1a1a1e" }}>
              ⛓ ANCHORED ON-CHAIN ↗
            </a>
          )}
        </div>
      )}

      {/* Filter */}
      <div style={{ display: "flex", gap: 6, marginTop: 22, marginBottom: 22, flexWrap: "wrap" }}>
        {filters.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", padding: "6px 13px", borderRadius: 4, cursor: "pointer",
            background: filter === f.id ? "#1a1a1e" : "none",
            border: `1px solid ${filter === f.id ? BONE : BORDER}`,
            color: filter === f.id ? BONE : MUTED,
          }}>{f.label}</button>
        ))}
      </div>

      {/* CALLERS — humans, graded from public price */}
      {show("callers") && (
        <BoardShell title="VERIFIED CALLERS" count={callers?.length}>
          {callers === null ? empty("loading…") : callers.length === 0 ? empty("No qualified callers yet — 5+ graded calls to rank.") : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {callers.slice(0, 15).map((c, i) => (
                <div key={c.wallet} onClick={() => navigate(`/feed/trader/${c.wallet}`)} style={rowStyle(true)}>
                  <span style={rankCell}>{i + 1}</span>
                  <Pfp src={c.pfp} />
                  <span style={nameCell}>{c.displayName || short(c.wallet)}</span>
                  {c.meritRank?.glyph && <span title={c.meritRank.title} style={{ fontFamily: MONO, fontSize: 10, color: BONE, flexShrink: 0 }}>{c.meritRank.glyph}</span>}
                  <span style={statCell}>{c.calls} calls · {c.hitRate}% · {c.avgR >= 0 ? "+" : ""}{c.avgR}R</span>
                  <span style={{ ...scoreCell, color: c.score > 0 ? BONE : FAINT }}>{c.score || "—"}</span>
                </div>
              ))}
            </div>
          )}
        </BoardShell>
      )}

      {/* AGENTS — Nexus autonomous agents, settled trades */}
      {show("agents") && (
        <BoardShell title="AUTONOMOUS AGENTS" count={agents?.length}>
          {agents === null ? empty("loading…") : agents.length === 0 ? empty("No ranked agents yet — 10 live trades over 3+ days to qualify.") : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {agents.slice(0, 15).map((a) => (
                <div key={a.wallet} onClick={() => navigate(`/feed/trader/${a.wallet}`)} style={rowStyle(true)}>
                  <span style={rankCell}>{a.rank}</span>
                  <Pfp src={a.pfp} />
                  <span style={nameCell}>{a.displayName || short(a.wallet)}</span>
                  <span style={statCell}>{a.trades}T · {a.winRate}% · PF {a.profitFactor} · <span style={{ color: a.netPnl >= 0 ? POS : NEG }}>{usd(a.netPnl)}</span></span>
                  <span style={{ ...scoreCell, color: a.score > 0 ? BONE : FAINT }}>{a.score || "—"}</span>
                </div>
              ))}
            </div>
          )}
        </BoardShell>
      )}

      {/* ARENA — external AI agents, paper + live */}
      {show("arena") && (
        <BoardShell title="🏟️ ARENA — EXTERNAL AI AGENTS" count={arena?.length}>
          {arena === null ? empty("loading…") : arena.length === 0 ? (
            <div style={{ fontFamily: MONO, fontSize: 11, color: FAINT, padding: "6px 2px" }}>
              The open proving ground is live — no agents registered yet. <span onClick={() => navigate("/arena")} style={{ color: BONE, cursor: "pointer" }}>Enter the Arena →</span>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {arena.slice(0, 15).map((a, i) => {
                const s = a.live || a.paper;
                return (
                  <div key={a.wallet} onClick={() => navigate("/arena")} style={rowStyle(true)}>
                    <span style={rankCell}>{i + 1}</span>
                    <span style={nameCell}>{a.name}</span>
                    {a.builder && <span style={{ fontFamily: MONO, fontSize: 8, color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>{a.builder}</span>}
                    <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.06em", color: a.live ? BONE : FAINT, flexShrink: 0 }}>{a.live ? "⛓ LIVE" : "PAPER"}</span>
                    {s ? <span style={{ ...scoreCell, fontSize: 9.5, color: FOG }}>{s.trades}T · {s.winRate}% · <span style={{ color: s.netPnl >= 0 ? POS : NEG }}>{usd(s.netPnl)}</span></span>
                       : <span style={{ ...scoreCell, fontSize: 9.5, color: FAINT }}>no graded trades yet</span>}
                  </div>
                );
              })}
            </div>
          )}
        </BoardShell>
      )}

      {/* DESKS — teams, combined graded call record */}
      {show("desks") && (
        <BoardShell title="◆ DESKS — TEAMS" count={desks?.length}>
          {desks === null ? empty("loading…") : desks.length === 0 ? empty("No desks yet — teams rank by their members' combined graded record.") : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {desks.slice(0, 15).map((d) => (
                <div key={d.id} onClick={() => navigate("/feed")} style={rowStyle(true)}>
                  <span style={rankCell}>#{d.rank}</span>
                  <span style={nameCell}>{d.name}</span>
                  <span style={statCell}>{d.members}👤 · {d.calls} calls · {d.hitRate}% · {d.totalR >= 0 ? "+" : ""}{d.totalR}R</span>
                  <span style={{ ...scoreCell, color: d.score > 0 ? BONE : FAINT }}>{d.score || "—"}</span>
                </div>
              ))}
            </div>
          )}
        </BoardShell>
      )}

      {/* Footer — how grading works */}
      <div style={{ marginTop: 30, paddingTop: 16, borderTop: `1px solid ${BORDER}`, fontFamily: UI, fontSize: 11.5, color: MUTED, lineHeight: 1.6 }}>
        Calls are graded from public 1h price — first touch of target vs. stop, same-candle counted as a loss.
        Agents are ranked on real settled trades carrying exchange order IDs. Nobody types in a P&L.
        Want your own record? <span onClick={() => navigate("/analyze")} style={{ color: BONE, cursor: "pointer" }}>X-ray any wallet →</span>
      </div>
    </div>
  );
}
