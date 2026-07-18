// Smart Money (Phase 1) — graded top Hyperliquid traders + a live signal feed of
// their opens/closes, with one-click ⚡ TRADE → directive (the agent then manages
// the exit and grades the result on-chain). Data comes from lab-api /smart/*
// (server-side HL indexing, KV-cached). Discovery + context — NOT "front-run the
// whale": copy is directional (their symbol + side), executed on Nexus/Orderly.
import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useIsMobile } from "./useIsMobile";
import { agentCardStyle, agentLabelStyle } from "./styles";
import { deployDirectiveFromThesis } from "@/utils/agentPrefill";
import { EmptyState } from "./components";

const AGENT_API = "https://og.nexustradinglabs.com";

interface SmPosition { coin: string; sym: string | null; tradeable: boolean; side: "LONG" | "SHORT"; szUsd: number; entry: number; lev: number | null; uPnl: number; }
interface SmTrader { address: string; roiMonth: number; pnlMonth: number; vlmMonth: number; accountValue: number; positions: SmPosition[]; }
interface SmEvent { addr: string; coin: string; sym: string; side: "LONG" | "SHORT"; type: "OPEN" | "CLOSE"; price: number; szUsd: number; closedPnl: number | null; ts: number; }

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : `${a.toFixed(0)}`;
  return `${n < 0 ? "-" : ""}$${s}`;
};
const ago = (ts: number) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${(m / 60).toFixed(0)}h` : `${(m / 1440).toFixed(0)}d`;
};

export function SmartMoneyView() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [board, setBoard] = useState<SmTrader[] | null>(null);
  const [events, setEvents] = useState<SmEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, e] = await Promise.all([
        fetch(`${AGENT_API}/smart/board`).then((r) => r.json()).catch(() => null),
        fetch(`${AGENT_API}/smart/events`).then((r) => r.json()).catch(() => null),
      ]);
      if (b?.traders) setBoard(b.traders);
      if (e?.events) setEvents(e.events);
      if (!b?.traders && !e?.events) setError("Couldn't reach the Smart Money feed. Try again shortly.");
    } catch {
      setError("Couldn't reach the Smart Money feed. Try again shortly.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 45000); // near-real-time via poll (Phase 2 = stream)
    return () => clearInterval(t);
  }, [load]);

  // ⚡ Copy a move → directive draft (agent manages exit + grades on-chain). `sym`
  // is the Orderly-copyable coin (already gated tradeable). Default stop 3% /
  // target 6% off the observed price; user reviews + edits in the arm panel.
  const copy = (sym: string, side: "LONG" | "SHORT", refPrice: number, lev?: number | null) => {
    const p = refPrice > 0 ? refPrice : 0;
    const isLong = side === "LONG";
    deployDirectiveFromThesis({
      symbol: sym, direction: side, entryPrice: p,
      stopLoss: p > 0 ? (isLong ? p * 0.97 : p * 1.03) : 0,
      takeProfit1: p > 0 ? (isLong ? p * 1.06 : p * 0.94) : 0,
      leverage: lev && lev > 0 ? Math.min(20, Math.round(lev)) : undefined,
    }, navigate);
  };

  const tradeBtn = (onClick: () => void) => (
    <button onClick={onClick} title="Copy this move — the agent enters your direction and manages the exit (PAPER-first, graded on-chain)"
      style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.04em", color: "#3ecf8e", background: "none", border: "1px solid #1e3a2a", borderRadius: 3, padding: "3px 8px", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
      ⚡ TRADE
    </button>
  );

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 9, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 5 }}>Scout</div>
        <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: 24, fontWeight: 700, color: "#f4f4f5", lineHeight: 1.1 }}>Smart Money</div>
        <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 11, color: "#71717a", marginTop: 6, lineHeight: 1.5, maxWidth: 640 }}>
          Top Hyperliquid traders by 30-day realized PnL — and what they're holding right now.
          Turn any move into a <strong style={{ color: "#a1a1aa" }}>risk-managed directive</strong> the agent runs and grades on-chain.
          Discovery + context, not front-running — copies execute on Nexus in <strong style={{ color: "#a1a1aa" }}>your</strong> direction.
        </div>
      </div>

      {loading && !board && !events && (
        <div style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 12, padding: 24, textAlign: "center" }}>// indexing Hyperliquid…</div>
      )}
      {error && !board && !events && <EmptyState message={error} />}

      {/* ── LIVE SIGNAL FEED ── */}
      {events && events.length > 0 && (
        <div style={{ ...agentCardStyle, marginBottom: 12 }}>
          <div style={{ ...agentLabelStyle, display: "flex", alignItems: "center", gap: 8 }}>
            // LIVE SIGNAL FEED
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3ecf8e", boxShadow: "0 0 6px #3ecf8e" }} />
          </div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column" }}>
            {events.slice(0, 20).map((e, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid #0d1117", minWidth: 0, flexWrap: "nowrap", overflowX: "auto" }}>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", width: 34, flexShrink: 0 }}>{ago(e.ts)}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", width: 90, flexShrink: 0 }}>{short(e.addr)}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, fontWeight: 700, color: e.type === "OPEN" ? "#3ecf8e" : "#a1a1aa", width: 42, flexShrink: 0 }}>{e.type}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", width: 56, flexShrink: 0 }}>{e.sym}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: e.side === "LONG" ? "#3ecf8e" : "#f7525f", width: 46, flexShrink: 0 }}>{e.side === "LONG" ? "↑ L" : "↓ S"}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa", width: 64, flexShrink: 0, textAlign: "right" }}>{usd(e.szUsd)}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: e.closedPnl == null ? "#52525b" : e.closedPnl >= 0 ? "#3ecf8e" : "#f7525f", width: 72, flexShrink: 0, textAlign: "right" }}>
                  {e.closedPnl == null ? "" : `${e.closedPnl >= 0 ? "+" : ""}${usd(e.closedPnl)}`}
                </span>
                <span style={{ marginLeft: "auto", flexShrink: 0 }}>{e.type === "OPEN" && tradeBtn(() => copy(e.sym, e.side, e.price))}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── SMART MONEY BOARD ── */}
      {board && board.length > 0 && (
        <div style={agentCardStyle}>
          <div style={agentLabelStyle}>// SMART MONEY BOARD <span style={{ color: "#52525b" }}>— ranked by 30d PnL · graded on Hyperliquid</span></div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {board.map((t, i) => (
              <div key={t.address} style={{ border: "1px solid #1a1a1e", borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#52525b", width: 24, flexShrink: 0 }}>#{i + 1}</span>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", flexShrink: 0 }}>{short(t.address)}</span>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#3ecf8e", flexShrink: 0 }}>{usd(t.pnlMonth)} <span style={{ color: "#52525b" }}>30d</span></span>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa", flexShrink: 0 }}>{(t.roiMonth * 100).toFixed(0)}% ROI</span>
                  {t.accountValue > 0 && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", flexShrink: 0 }}>{usd(t.accountValue)} acct</span>}
                  <a href={`/analyze?address=${t.address}`} target="_blank" rel="noopener noreferrer"
                    style={{ marginLeft: isMobile ? 0 : "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", textDecoration: "none", border: "1px solid #232327", borderRadius: 3, padding: "3px 8px", flexShrink: 0 }}>
                    x-ray ↗
                  </a>
                </div>
                {t.positions.length > 0 && (
                  <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                    {t.positions.slice(0, 5).map((p, j) => (
                      <div key={j} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", flexWrap: "nowrap", overflowX: "auto" }}>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#c0c0c0", width: 56, flexShrink: 0 }}>{p.coin}</span>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: p.side === "LONG" ? "#3ecf8e" : "#f7525f", width: 46, flexShrink: 0 }}>{p.side === "LONG" ? "↑ L" : "↓ S"}{p.lev ? ` ${p.lev}x` : ""}</span>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#a1a1aa", width: 64, flexShrink: 0, textAlign: "right" }}>{usd(p.szUsd)}</span>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: p.uPnl >= 0 ? "#3ecf8e" : "#f7525f", width: 68, flexShrink: 0, textAlign: "right" }}>{p.uPnl >= 0 ? "+" : ""}{usd(p.uPnl)}</span>
                        <span style={{ marginLeft: "auto", flexShrink: 0 }}>
                          {p.tradeable && p.sym
                            ? tradeBtn(() => copy(p.sym as string, p.side, p.entry, p.lev))
                            : <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#3f3f46", whiteSpace: "nowrap" }}>HL-only</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#3f3f46", marginTop: 10, lineHeight: 1.5 }}>
            Sourced from the public Hyperliquid leaderboard. Copies execute on Nexus/Orderly in your direction — prices differ; the agent manages the exit. Not financial advice.
          </div>
        </div>
      )}
    </div>
  );
}
