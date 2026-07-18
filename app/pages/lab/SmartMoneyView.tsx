// Smart Money (Phase 1) — graded top Hyperliquid traders + a live signal feed of
// their opens/closes, with one-click ⚡ TRADE → directive (the agent then manages
// the exit and grades the result on-chain). Data comes from lab-api /smart/*
// (server-side HL indexing, KV-cached). Discovery + context — NOT "front-run the
// whale": copy is directional (their symbol + side), executed on Nexus/Orderly.
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "@orderly.network/hooks";
import { useIsMobile } from "./useIsMobile";
import { agentCardStyle, agentLabelStyle } from "./styles";
import { deployDirectiveFromThesis } from "@/utils/agentPrefill";
import { EmptyState, Coachmark } from "./components";
import { SharePoster, type PosterData } from "./SharePoster";
import { TraderDetail } from "./TraderDetail";
import { THESIS_DRAFT_KEY } from "@/config/assistantTools";

interface SmConsensus { sym: string; side: "LONG" | "SHORT"; count: number; netUsd: number; refPrice: number; }

const AGENT_API = "https://og.nexustradinglabs.com";

interface SmPosition { coin: string; sym: string | null; tradeable: boolean; side: "LONG" | "SHORT"; szUsd: number; entry: number; lev: number | null; uPnl: number; }
interface SmTrader { source: "orderly" | "hl"; address: string; accountId?: string; pnl: number; pnlLabel: string; roi?: number | null; accountValue?: number; positions: SmPosition[]; }

const WATCH_KEY = "nexus_sm_watchlist";
const loadWatch = (): string[] => { try { return JSON.parse(localStorage.getItem(WATCH_KEY) || "[]"); } catch { return []; } };
interface SmEvent { source?: "orderly" | "hl"; addr: string; coin: string; sym: string; side: "LONG" | "SHORT"; type: "OPEN" | "CLOSE"; price: number; szUsd: number; closedPnl: number | null; ts: number; }

const SKY = "#6cb6ff"; // info/tracked accent (amber reserved for caution only)
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

export function SmartMoneyView({ myPositions = [] }: { myPositions?: { symbol?: string; position_qty?: number | string }[] }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [board, setBoard] = useState<SmTrader[] | null>(null);
  const [events, setEvents] = useState<SmEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [poster, setPoster] = useState<PosterData | null>(null);
  const [detail, setDetail] = useState<{ source: "orderly" | "hl"; address: string; accountId?: string } | null>(null);
  const [watch, setWatch] = useState<string[]>(loadWatch);
  const [watchOnly, setWatchOnly] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { state: acct } = useAccount();
  const wallet = (acct as { address?: string })?.address?.toLowerCase() ?? null;
  const seenRef = useRef<Set<string> | null>(null); // alert dedup across polls

  // Persist watchlist locally + best-effort to the server (cross-device). Server
  // write needs the cached wallet signature (from agent/trade use) — if absent we
  // stay local-only rather than prompting for a signature just to star a wallet.
  const persistWatch = useCallback((next: string[]) => {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(next)); } catch { /* private */ }
    if (!wallet) return;
    let sig: string | null = null;
    try { sig = sessionStorage.getItem(`nexus_agent_sig_${wallet}`); } catch { /* ignore */ }
    if (!sig) return; // no cached auth → local-only (no forced prompt)
    fetch(`${AGENT_API}/smart/watchlist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletSig: sig, watch: next }) }).catch(() => {});
  }, [wallet]);

  const toggleWatch = (addr: string) => {
    setWatch((w) => { const next = w.includes(addr) ? w.filter((x) => x !== addr) : [...w, addr]; persistWatch(next); return next; });
  };

  // Pull the server watchlist once on connect and union it with local (cross-device).
  useEffect(() => {
    if (!wallet) return;
    fetch(`${AGENT_API}/smart/watchlist/${wallet}`).then((r) => r.json()).then((d) => {
      if (!Array.isArray(d?.watch)) return;
      setWatch((local) => { const merged = [...new Set([...local, ...d.watch])]; try { localStorage.setItem(WATCH_KEY, JSON.stringify(merged)); } catch { /* ignore */ } return merged; });
    }).catch(() => {});
  }, [wallet]);

  // Smart-money CONSENSUS — coins where ≥2 tracked traders hold the same side.
  // The highest-conviction signal: not one whale, but agreement. Derived free
  // from the board data we already have.
  const consensus = useMemo<SmConsensus[]>(() => {
    if (!board) return [];
    const map = new Map<string, { sym: string; side: "LONG" | "SHORT"; traders: Set<string>; netUsd: number; refPrice: number; maxSz: number }>();
    for (const t of board) {
      for (const p of t.positions) {
        if (!p.tradeable || !p.sym) continue;
        const key = `${p.sym}|${p.side}`;
        const e = map.get(key) || { sym: p.sym, side: p.side, traders: new Set<string>(), netUsd: 0, refPrice: 0, maxSz: 0 };
        e.traders.add(t.address); e.netUsd += p.szUsd;
        if (p.szUsd > e.maxSz && p.entry > 0) { e.maxSz = p.szUsd; e.refPrice = p.entry; } // ref = biggest holder's entry
        map.set(key, e);
      }
    }
    return [...map.values()]
      .filter((e) => e.traders.size >= 2)
      .map((e) => ({ sym: e.sym, side: e.side, count: e.traders.size, netUsd: e.netUsd, refPrice: e.refPrice }))
      .sort((a, b) => b.count - a.count || b.netUsd - a.netUsd)
      .slice(0, 6);
  }, [board]);

  // Net smart-money bias per coin (all board positions, both sources) → the side
  // with more $ behind it. Powers "You vs Smart Money".
  const smartBias = useMemo(() => {
    const m = new Map<string, { longUsd: number; shortUsd: number; traders: number }>();
    if (!board) return m;
    for (const t of board) for (const p of t.positions) {
      if (!p.sym) continue;
      const e = m.get(p.sym) || { longUsd: 0, shortUsd: 0, traders: 0 };
      if (p.side === "LONG") e.longUsd += p.szUsd; else e.shortUsd += p.szUsd;
      e.traders += 1;
      m.set(p.sym, e);
    }
    return m;
  }, [board]);

  // #1 You vs Smart Money — your live positions vs the net smart bias per coin.
  const alignment = useMemo(() => {
    const out: { coin: string; yourSide: "LONG" | "SHORT"; smartSide: "LONG" | "SHORT"; aligned: boolean; traders: number }[] = [];
    for (const p of (myPositions || [])) {
      const qty = parseFloat(String(p.position_qty ?? 0));
      if (!p.symbol || Math.abs(qty) < 1e-9) continue;
      const coin = p.symbol.replace("PERP_", "").replace("_USDC", "");
      const bias = smartBias.get(coin);
      if (!bias || (bias.longUsd === 0 && bias.shortUsd === 0)) continue;
      const smartSide: "LONG" | "SHORT" = bias.longUsd >= bias.shortUsd ? "LONG" : "SHORT";
      const yourSide: "LONG" | "SHORT" = qty > 0 ? "LONG" : "SHORT";
      out.push({ coin, yourSide, smartSide, aligned: yourSide === smartSide, traders: bias.traders });
    }
    return out;
  }, [myPositions, smartBias]);

  // address → accountId (board traders carry it) so any address in the feed can
  // open the same unified trader detail.
  const accountIdByAddr = useMemo(() => {
    const m = new Map<string, { source: "orderly" | "hl"; accountId?: string }>();
    if (board) for (const t of board) m.set(t.address, { source: t.source, accountId: t.accountId });
    return m;
  }, [board]);
  const openDetail = (address: string, source?: "orderly" | "hl", accountId?: string) => {
    const meta = accountIdByAddr.get(address);
    setDetail({ source: source || meta?.source || "hl", address, accountId: accountId || meta?.accountId });
  };

  // #3 Turn a smart-money move into a reasoned thesis (prefill the Thesis Engine).
  const openThesis = (sym: string, side: "LONG" | "SHORT", refPrice: number, note: string) => {
    const p = refPrice > 0 ? refPrice : 0;
    const isLong = side === "LONG";
    try {
      localStorage.setItem(THESIS_DRAFT_KEY, JSON.stringify({
        symbol: sym, direction: side,
        entryPrice: p || undefined,
        stopLoss: p > 0 ? Number((isLong ? p * 0.97 : p * 1.03).toFixed(6)) : undefined,
        takeProfit1: p > 0 ? Number((isLong ? p * 1.06 : p * 0.94).toFixed(6)) : undefined,
        notes: note,
      }));
    } catch { /* ignore */ }
    navigate("/lab?tab=thesis");
  };

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

  // Watchlist alert — toast when a NEW feed event comes from a watched wallet.
  // First load seeds the seen-set so we don't alert the whole backlog.
  useEffect(() => {
    if (!events) return;
    const watchSet = new Set(watch);
    if (seenRef.current === null) { seenRef.current = new Set(events.map((e) => `${e.addr}|${e.sym}|${e.type}|${e.ts}`)); return; }
    for (const e of events) {
      const k = `${e.addr}|${e.sym}|${e.type}|${e.ts}`;
      if (seenRef.current.has(k)) continue;
      seenRef.current.add(k);
      if (watchSet.has(e.addr)) { setToast(`★ ${short(e.addr)} ${e.type === "OPEN" ? "opened" : "closed"} ${e.sym} ${e.side}`); setTimeout(() => setToast(null), 6000); }
    }
  }, [events, watch]);

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

  const thesisBtn = (onClick: () => void) => (
    <button onClick={onClick} title="Turn this into a reasoned thesis — sized, R:R'd, and gradeable in the Thesis Engine"
      style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#a1a1aa", background: "none", border: "1px solid #232327", borderRadius: 3, padding: "3px 7px", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
      ◆
    </button>
  );

  // ↗ Share a smart-money signal as a branded card (the viral loop on our most
  // alive surface). Consensus cards carry the trader count.
  const shareBtn = (d: PosterData) => (
    <button onClick={() => setPoster(d)} title="Share this signal"
      style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", background: "none", border: "1px solid #232327", borderRadius: 3, padding: "3px 7px", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
      ↗
    </button>
  );

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      {poster && <SharePoster data={poster} onClose={() => setPoster(null)} />}
      {detail && <TraderDetail source={detail.source} address={detail.address} accountId={detail.accountId} onClose={() => setDetail(null)} />}
      {toast && (
        <div className="nx-fade-in" style={{ position: "fixed", bottom: 20, left: 20, zIndex: 8000, background: "#0f0f11", border: "1px solid #2a3f52", borderLeft: `3px solid ${SKY}`, borderRadius: 6, padding: "10px 14px", fontFamily: "var(--nx-font-mono)", fontSize: 11, color: SKY, boxShadow: "0 8px 30px rgba(0,0,0,0.5)" }}>
          {toast}
        </div>
      )}
      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 9, color: "#71717a", fontFamily: "var(--nx-font-mono)", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 5 }}>Scout</div>
        <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: 24, fontWeight: 700, color: "#f4f4f5", lineHeight: 1.1 }}>Smart Money</div>
        <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 11, color: "#71717a", marginTop: 6, lineHeight: 1.5, maxWidth: 660 }}>
          The top traders on <strong style={{ color: "#a1a1aa" }}>Orderly</strong> and Hyperliquid, and what they're holding right now —
          indexed live from public on-chain data. Copy any move into a <strong style={{ color: "#a1a1aa" }}>risk-managed trade</strong> the
          agent manages and grades on-chain, or star ★ the wallets you trust to track them.
        </div>
      </div>

      {/* #3 convert-loop framing — one-time */}
      <Coachmark storageKey="nexus_coach_smart_v1" badge="THE LOOP" title="From watcher to ranked trader">
        Copy any move → the agent manages the exit → every close joins <strong style={{ color: "#d4d4d8" }}>your</strong> on-chain track record.
        That's how you go from watching smart money to <strong style={{ color: "#d4d4d8" }}>being</strong> graded next to them — a record nobody can fake.
      </Coachmark>

      {loading && !board && !events && (
        <div style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 12, padding: 24, textAlign: "center" }}>// indexing Hyperliquid…</div>
      )}
      {error && !board && !events && <EmptyState message={error} />}

      {/* ── #1 YOU vs SMART MONEY — your positions vs the crowd ── */}
      {alignment.length > 0 && (
        <div style={{ ...agentCardStyle, marginBottom: 12 }}>
          <div style={agentLabelStyle}>◎ YOU vs SMART MONEY <span style={{ color: "#52525b" }}>— your open positions vs where the smart money sits</span></div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {alignment.map((a) => (
              <div key={a.coin} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 4, border: `1px solid ${a.aligned ? "#1e3a2a" : "#3a1e1e"}`, background: a.aligned ? "#0d140f" : "#140d0d", flexWrap: "wrap" }}>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", width: 56, flexShrink: 0 }}>{a.coin}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", flexShrink: 0 }}>you <span style={{ color: a.yourSide === "LONG" ? "#3ecf8e" : "#f7525f" }}>{a.yourSide}</span></span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", flexShrink: 0 }}>smart money <span style={{ color: a.smartSide === "LONG" ? "#3ecf8e" : "#f7525f" }}>{a.smartSide}</span> <span style={{ color: "#52525b" }}>({a.traders})</span></span>
                <span style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 10, fontWeight: 700, color: a.aligned ? "#3ecf8e" : "#fbbf24", flexShrink: 0 }}>
                  {a.aligned ? "✓ ALIGNED" : "⚠ FIGHTING THE CROWD"}
                </span>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#3f3f46", marginTop: 8 }}>
            Context, not a signal — smart money is often early AND often wrong. Know which side you're on.
          </div>
        </div>
      )}

      {/* ── SMART MONEY CONSENSUS — the highest-conviction signal ── */}
      {consensus.length > 0 && (
        <div style={{ ...agentCardStyle, marginBottom: 12, borderColor: "#1e3a2a" }}>
          <div style={agentLabelStyle}>◆ SMART MONEY CONSENSUS <span style={{ color: "#52525b" }}>— coins multiple tracked traders agree on</span></div>
          <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
            {consensus.map((c) => (
              <div key={`${c.sym}${c.side}`} style={{ display: "flex", alignItems: "center", gap: 10, rowGap: 6, flexWrap: "wrap", padding: "8px 10px", border: "1px solid #1a1a1e", borderRadius: 6, background: "#0d140f" }}>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#ededf0", flexShrink: 0 }}>{c.sym}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700, color: c.side === "LONG" ? "#3ecf8e" : "#f7525f", flexShrink: 0 }}>{c.side === "LONG" ? "↑ LONG" : "↓ SHORT"}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#3ecf8e", flexShrink: 0 }}>{c.count} traders</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", flexShrink: 0 }}>{usd(c.netUsd)}</span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
                  {shareBtn({ kind: "smart", symbol: c.sym, direction: c.side, szUsd: c.netUsd, consensus: c.count })}
                  {thesisBtn(() => openThesis(c.sym, c.side, c.refPrice, `Smart-money consensus: ${c.count} top traders are ${c.side} ${c.sym}.`))}
                  {tradeBtn(() => copy(c.sym, c.side, c.refPrice))}
                </span>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#3f3f46", marginTop: 8 }}>
            Agreement across independent top traders — stronger than any single whale. ⚡ opens the copy at market (set your own levels).
          </div>
        </div>
      )}

      {/* ── LIVE SIGNAL FEED ── */}
      {events && events.length > 0 && (
        <div style={{ ...agentCardStyle, marginBottom: 12 }}>
          <div style={{ ...agentLabelStyle, display: "flex", alignItems: "center", gap: 8 }}>
            // LIVE SIGNAL FEED
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3ecf8e", boxShadow: "0 0 6px #3ecf8e" }} />
          </div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column" }}>
            {events.slice(0, 20).map((e, i) => {
              const watched = watch.includes(e.addr);
              return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 6px", borderBottom: "1px solid #0d1117", minWidth: 0, flexWrap: "nowrap", overflowX: "auto", background: watched ? "#6cb6ff10" : "transparent", borderLeft: watched ? `2px solid ${SKY}` : "2px solid transparent" }}>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", width: 34, flexShrink: 0 }}>{ago(e.ts)}</span>
                <span title={e.source === "orderly" ? "Orderly (native)" : "Hyperliquid"} style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: e.source === "orderly" ? "#3ecf8e" : "#52525b", width: 12, flexShrink: 0 }}>{e.source === "orderly" ? "◆" : "H"}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 3, width: 96, flexShrink: 0 }}>
                  {watched && <span style={{ color: SKY, fontSize: 9 }}>★</span>}
                  <span onClick={() => openDetail(e.addr, e.source)} title="View trader detail" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: watched ? SKY : "#71717a", cursor: "pointer", textDecoration: "underline", textDecorationColor: "#232327" }}>{short(e.addr)}</span>
                </span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, fontWeight: 700, color: e.type === "OPEN" ? "#3ecf8e" : "#a1a1aa", width: 42, flexShrink: 0 }}>{e.type}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", width: 56, flexShrink: 0 }}>{e.sym}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: e.side === "LONG" ? "#3ecf8e" : "#f7525f", width: 46, flexShrink: 0 }}>{e.side === "LONG" ? "↑ L" : "↓ S"}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa", width: 64, flexShrink: 0, textAlign: "right" }}>{usd(e.szUsd)}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: e.closedPnl == null ? "#52525b" : e.closedPnl >= 0 ? "#3ecf8e" : "#f7525f", width: 72, flexShrink: 0, textAlign: "right" }}>
                  {e.closedPnl == null ? "" : `${e.closedPnl >= 0 ? "+" : ""}${usd(e.closedPnl)}`}
                </span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
                  {e.type === "OPEN" && shareBtn({ kind: "smart", symbol: e.sym, direction: e.side, szUsd: e.szUsd, trader: short(e.addr) })}
                  {e.type === "OPEN" && thesisBtn(() => openThesis(e.sym, e.side, e.price, `${short(e.addr)} (smart money) opened ${e.side} ${e.sym}.`))}
                  {e.type === "OPEN" && tradeBtn(() => copy(e.sym, e.side, e.price))}
                </span>
              </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── SMART MONEY BOARD ── */}
      {board && board.length > 0 && (() => {
        const shown = watchOnly ? board.filter((t) => watch.includes(t.address)) : board;
        return (
        <div style={agentCardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={agentLabelStyle}>// SMART MONEY BOARD <span style={{ color: "#52525b" }}>— ◆ Orderly (native) + Hyperliquid</span></div>
            <button onClick={() => setWatchOnly((v) => !v)} disabled={watch.length === 0}
              title={watch.length === 0 ? "Star traders below to build a watchlist" : "Show only your watchlist"}
              style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.04em", color: watchOnly ? SKY : "#71717a", background: watchOnly ? "#0a1420" : "none", border: `1px solid ${watchOnly ? "#2a3f52" : "#232327"}`, borderRadius: 3, padding: "4px 9px", cursor: watch.length === 0 ? "default" : "pointer", opacity: watch.length === 0 ? 0.5 : 1 }}>
              ★ WATCHLIST{watch.length > 0 ? ` (${watch.length})` : ""}
            </button>
          </div>
          {watchOnly && shown.length === 0 && (
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#71717a", padding: "16px 0", textAlign: "center" }}>No watched traders in the current board. Star ★ any trader to track them.</div>
          )}
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {shown.map((t, i) => {
              const starred = watch.includes(t.address);
              return (
              <div key={t.address} style={{ border: "1px solid #1a1a1e", borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#52525b", width: 24, flexShrink: 0 }}>#{i + 1}</span>
                  <button onClick={() => toggleWatch(t.address)} title={starred ? "Unwatch" : "Add to watchlist"}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 13, color: starred ? SKY : "#3f3f46", flexShrink: 0, lineHeight: 1 }}>
                    {starred ? "★" : "☆"}
                  </button>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.05em", color: t.source === "orderly" ? "#3ecf8e" : "#71717a", border: `1px solid ${t.source === "orderly" ? "#1e3a2a" : "#232327"}`, borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>{t.source === "orderly" ? "◆ ORDERLY" : "HL"}</span>
                  <span onClick={() => openDetail(t.address, t.source, t.accountId)} title="View trader detail" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", flexShrink: 0, cursor: "pointer", textDecoration: "underline", textDecorationColor: "#33333a" }}>{short(t.address)}</span>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: t.pnl >= 0 ? "#3ecf8e" : "#f7525f", flexShrink: 0 }}>{usd(t.pnl)} <span style={{ color: "#52525b" }}>{t.pnlLabel}</span></span>
                  {t.roi != null && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa", flexShrink: 0 }}>{(t.roi * 100).toFixed(0)}% ROI</span>}
                  {t.accountValue != null && t.accountValue > 0 && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", flexShrink: 0 }}>{usd(t.accountValue)} acct</span>}
                  <a href={t.source === "hl" ? `/analyze?address=${t.address}` : `https://orderly-dashboard.orderly.network/address/${t.address}`} target="_blank" rel="noopener noreferrer"
                    style={{ marginLeft: isMobile ? 0 : "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", textDecoration: "none", border: "1px solid #232327", borderRadius: 3, padding: "3px 8px", flexShrink: 0 }}>
                    {t.source === "hl" ? "x-ray ↗" : "explorer ↗"}
                  </a>
                </div>
                {t.positions.length > 0 && (
                  <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                    {t.positions.slice(0, 5).map((p, j) => (
                      <div key={j} style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0", flexWrap: "nowrap", overflowX: "auto" }}>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#e4e4e7", width: 72, flexShrink: 0 }}>{p.coin}</span>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 600, color: p.side === "LONG" ? "#3ecf8e" : "#f7525f", width: 60, flexShrink: 0 }}>{p.side === "LONG" ? "↑ LONG" : "↓ SHORT"}{p.lev ? ` ${p.lev}x` : ""}</span>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#a1a1aa", width: 88, flexShrink: 0, textAlign: "right" }}>{usd(p.szUsd)}</span>
                        {p.entry > 0 && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#52525b", flexShrink: 0 }}>@ ${p.entry.toLocaleString(undefined, { maximumFractionDigits: p.entry < 10 ? 4 : 2 })}</span>}
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 600, color: p.uPnl >= 0 ? "#3ecf8e" : "#f7525f", width: 88, flexShrink: 0, textAlign: "right" }}>{p.uPnl >= 0 ? "+" : ""}{usd(p.uPnl)}</span>
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
              );
            })}
          </div>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#3f3f46", marginTop: 10, lineHeight: 1.5 }}>
            ◆ Orderly traders (public settlement indexer) copy natively; Hyperliquid traders copy directionally on Nexus. The agent manages the exit. Not financial advice.
          </div>
        </div>
        );
      })()}
    </div>
  );
}
