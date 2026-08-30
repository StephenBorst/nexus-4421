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
import type { XrayTrack } from "@/components/TrackedRecordCard";
import { THESIS_DRAFT_KEY } from "@/config/assistantTools";
import { ConvictionScanner } from "./ConvictionScanner";

interface SmConsensus { sym: string; side: "LONG" | "SHORT"; count: number; netUsd: number; refPrice: number; }

const AGENT_API = "https://og.nexustradinglabs.com";

interface SmPosition { coin: string; sym: string | null; tradeable: boolean; side: "LONG" | "SHORT"; szUsd: number; entry: number; lev: number | null; uPnl: number; }
interface SmTrader { source: "orderly" | "hl"; address: string; accountId?: string; pnl: number; pnlLabel: string; roi?: number | null; accountValue?: number; positions: SmPosition[]; }
// Compact graded Tracked Record per wallet (from /smart/xray/tracked) — turns the
// board from a raw-single-number leaderboard into a graded-consistency one.
interface TrackChip { operatorScore: number | null; tier: { tier: string; title: string; glyph: string } | null; scored: boolean; netRealized: number; daysTracked: number; trend: "UP" | "DOWN" | "FLAT"; points: number; }
// Graded "tracked signal" — a wallet crossing an Operator-tier boundary.
interface XrayEvent { wallet: string; kind: "TIER_UP" | "TIER_DOWN"; fromTier: string | null; toTier: string | null; operatorScore: number | null; netRealized: number; ts: number; }
const TIER_GLYPH: Record<string, string> = { TRACKED: "▪", POSITIVE: "◆", CONSISTENT: "✦" };

const WATCH_KEY = "nexus_sm_watchlist";
const loadWatch = (): string[] => { try { return JSON.parse(localStorage.getItem(WATCH_KEY) || "[]"); } catch { return []; } };
interface SmEvent { source?: "orderly" | "hl"; addr: string; coin: string; sym: string; side: "LONG" | "SHORT"; type: "OPEN" | "CLOSE"; price: number; szUsd: number; closedPnl: number | null; ts: number; }

const TRACKED = "#ededf0"; // watchlist/tracked accent — bone, NOT blue (blue is teaching copy only)
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n: number | null | undefined) => {
  // Coerce first: several callers pass fields straight off external (HL / Orderly)
  // payloads, where a missing value would make `.toFixed` throw and crash the view —
  // the same class as the trader-profile crash. NaN/undefined → $0, never a throw.
  const v = Number(n) || 0;
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : `${a.toFixed(0)}`;
  return `${v < 0 ? "-" : ""}$${s}`;
};
const ago = (ts: number) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${(m / 60).toFixed(0)}h` : `${(m / 1440).toFixed(0)}d`;
};

// ── Copy confirm (Grok) — copying a wallet inherits its GRADED, WATCHED record (net over
// days tracked, green-day rate), never its flattering lifetime PnL. A single-leader copy
// pauses here so the trader sees exactly what track record they're about to ride. Lifetime
// stays off the button. Fail-soft: an un-graded leader says so honestly (grading starts now).
function CopyConfirm({ leader, sym, side, onConfirm, onCancel }: {
  leader: string; sym: string; side: "LONG" | "SHORT"; onConfirm: () => void; onCancel: () => void;
}) {
  const [track, setTrack] = useState<XrayTrack | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let off = false;
    fetch(`${AGENT_API}/smart/xray/history?address=${leader}`).then((r) => r.json())
      .then((x) => { if (!off) setTrack(x && x.track ? x.track : null); })
      .catch(() => { /* no record — honest empty state */ })
      .finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [leader]);
  // The coin's SHARP split — the SAME /smart/consensus field the Funding Edge ticket lens shows
  // ({side, long, short}), so the confirm cites 4L/1S, not Quick Call's bare "5" (Grok). Context.
  const [smart, setSmart] = useState<{ side: "LONG" | "SHORT"; count: number; long: number; short: number } | null>(null);
  useEffect(() => {
    let off = false;
    const bare = sym.replace(/^PERP_/, "").replace(/_USDC$/, "").toUpperCase();
    fetch(`${AGENT_API}/smart/consensus`).then((r) => r.json())
      .then((d) => { const s = d?.consensus?.[bare]; if (!off) setSmart(s && (s.side === "LONG" || s.side === "SHORT") ? { side: s.side, count: s.count ?? 0, long: s.long ?? 0, short: s.short ?? 0 } : null); })
      .catch(() => { /* no read — the line just hides */ });
    return () => { off = true; };
  }, [sym]);
  const graded = !!track && !track.building && (track.daysTracked ?? 0) > 0;
  const net = track?.netRealized ?? 0;
  const sideCol = side === "LONG" ? "#3ecf8e" : "#f7525f";
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, zIndex: 9100, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="nx-fade-in" onClick={(e) => e.stopPropagation()} style={{ width: "min(420px, 96vw)", background: "#0f0f11", border: "1px solid #33333a", borderRadius: 10, padding: 18 }}>
        <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase", marginBottom: 8 }}>Copy this move</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: smart ? 6 : 14 }}>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 18, fontWeight: 700, color: "#ededf0" }}>{sym}</span>
          <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, fontWeight: 700, color: sideCol }}>{side === "LONG" ? "↑ LONG" : "↓ SHORT"}</span>
          <span style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a" }}>{short(leader)}</span>
        </div>
        {/* The sharp split — the SAME field the Funding Edge ticket shows (4L/1S), not the Quick
            Call's bare count. Plain context: the sharp positioning on this coin, no conviction word. */}
        {smart && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, fontFamily: "var(--nx-font-mono)", fontSize: 10.5 }}>
            <span style={{ fontSize: 8, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase" }}>Smart money</span>
            <b style={{ color: "#a1a1aa" }}>{smart.long}L/{smart.short}S</b>
            <span style={{ color: smart.side === "LONG" ? "#3ecf8e" : "#f7525f" }}>{smart.side}</span>
            {smart.side !== side && <span style={{ color: "#52525b" }}>· you're copying the other way</span>}
          </div>
        )}
        {/* The GRADED, WATCHED record — the number that can't be faked, not lifetime PnL. */}
        <div style={{ border: "1px solid #232327", borderRadius: 8, padding: "10px 12px", marginBottom: 14, background: "#0c0c0e" }}>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.1em", color: "#52525b", textTransform: "uppercase", marginBottom: 6 }}>What you're tracking</div>
          {loading ? (
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#71717a" }}>reading graded record…</div>
          ) : graded ? (
            <>
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#a1a1aa", lineHeight: 1.6 }}>
                watched <b style={{ color: net >= 0 ? "#3ecf8e" : "#f7525f", fontSize: 14 }}>{net >= 0 ? "+" : ""}{usd(net)}</b> · {track!.daysTracked}d tracked{track!.winWindowRate != null ? <> · <b style={{ color: "#ededf0" }}>{track!.winWindowRate}%</b> green days</> : null}
              </div>
              <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 5, lineHeight: 1.5 }}>This is the window you've been watching, not lifetime.</div>
            </>
          ) : (
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#71717a", lineHeight: 1.55 }}>No graded watched record yet — the agent grades this copy on-chain from here.</div>
          )}
        </div>
        <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 11, color: "#71717a", lineHeight: 1.5, marginBottom: 14 }}>The agent enters your direction and manages the exit (PAPER-first, graded on-chain). You set the levels next. Not financial advice.</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} style={{ flex: 1, fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa", background: "none", border: "1px solid #232327", borderRadius: 4, padding: "9px 0", cursor: "pointer" }}>Cancel</button>
          <button onClick={onConfirm} style={{ flex: 2, fontFamily: "var(--nx-font-mono)", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: "#0a0a0b", background: "#ededf0", border: "none", borderRadius: 4, padding: "9px 0", cursor: "pointer" }}>⚡ COPY {side} {sym} →</button>
        </div>
      </div>
    </div>
  );
}

export function SmartMoneyView({ myPositions = [] }: { myPositions?: { symbol?: string; position_qty?: number | string }[] }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [board, setBoard] = useState<SmTrader[] | null>(null);
  const [events, setEvents] = useState<SmEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [poster, setPoster] = useState<PosterData | null>(null);
  const [detail, setDetail] = useState<{ source: "orderly" | "hl"; address: string; accountId?: string } | null>(null);
  const [pendingCopy, setPendingCopy] = useState<{ sym: string; side: "LONG" | "SHORT"; refPrice: number; lev: number | null; leader: string } | null>(null);
  const [watch, setWatch] = useState<string[]>(loadWatch);
  const [watchOnly, setWatchOnly] = useState(false);
  // Progressive disclosure — lead with the signal (consensus + a short feed/board),
  // expand for the full depth. Kills the "long scroll of raw data" without hiding it.
  const [feedAll, setFeedAll] = useState(false);
  const [boardAll, setBoardAll] = useState(false);
  const [trackMap, setTrackMap] = useState<Record<string, TrackChip>>({});
  const [trackedSignals, setTrackedSignals] = useState<XrayEvent[]>([]);
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

  // Batch-load the graded Tracked Record for every wallet on the board + watchlist
  // (KV-only server read; only wallets with ≥2 accrued snapshots come back).
  useEffect(() => {
    const addrs = [...new Set([...(board || []).map((t) => t.address.toLowerCase()), ...watch.map((w) => w.toLowerCase())])].slice(0, 60);
    if (!addrs.length) return;
    let cancel = false;
    fetch(`${AGENT_API}/smart/xray/tracked?addresses=${addrs.join(",")}`)
      .then((r) => r.json())
      .then((x) => { if (!cancel && x && x.tracked) setTrackMap(x.tracked); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [board, watch]);

  // Graded "tracked signals" — wallets that just earned/lost an Operator tier.
  useEffect(() => {
    let cancel = false;
    fetch(`${AGENT_API}/smart/xray/events`)
      .then((r) => r.json())
      .then((x) => { if (!cancel && x && Array.isArray(x.events)) setTrackedSignals(x.events.slice(0, 6)); })
      .catch(() => {});
    return () => { cancel = true; };
  }, []);

  // Smart-money CONSENSUS — coins where ≥2 tracked traders hold the same side.
  // The highest-conviction signal: not one whale, but agreement. Derived free
  // from the board data we already have.
  const consensus = useMemo<SmConsensus[]>(() => {
    if (!board) return [];
    type Entry = { sym: string; side: "LONG" | "SHORT"; traders: Set<string>; netUsd: number; refPrice: number; maxSz: number };
    const map = new Map<string, Entry>();
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
    // Collapse to ONE side per coin — the DOMINANT agreement. A coin with tracked
    // traders on BOTH sides (e.g. 5 long + 5 short BTC) is a SPLIT, not consensus, so
    // showing both entries under "coins traders agree on" is contradictory. Keep the
    // side that clearly leads (more traders); drop the coin entirely on a tie.
    const bySym = new Map<string, { LONG?: Entry; SHORT?: Entry }>();
    for (const e of map.values()) {
      if (e.traders.size < 2) continue;
      const g = bySym.get(e.sym) || {};
      g[e.side] = e; bySym.set(e.sym, g);
    }
    const dominant: Entry[] = [];
    for (const g of bySym.values()) {
      const sides = [g.LONG, g.SHORT].filter(Boolean) as Entry[];
      if (sides.length === 1) { dominant.push(sides[0]); continue; }
      sides.sort((a, b) => b.traders.size - a.traders.size);
      if (sides[0].traders.size > sides[1].traders.size) dominant.push(sides[0]); // clear lead wins; even split dropped
    }
    return dominant
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
  const doCopy = (sym: string, side: "LONG" | "SHORT", refPrice: number, lev?: number | null, leader?: string) => {
    const p = refPrice > 0 ? refPrice : 0;
    const isLong = side === "LONG";
    deployDirectiveFromThesis({
      symbol: sym, direction: side, entryPrice: p,
      stopLoss: p > 0 ? (isLong ? p * 0.97 : p * 1.03) : 0,
      takeProfit1: p > 0 ? (isLong ? p * 1.06 : p * 0.94) : 0,
      leverage: lev && lev > 0 ? Math.min(20, Math.round(lev)) : undefined,
      // Provenance → the closed trade is graded back to this leader ("copies of
      // 0x… returned Y"). Only when there's a single leader (not consensus).
      source: leader && /^0x[a-f0-9]{40}$/i.test(leader) ? leader : undefined,
    }, navigate);
  };

  // A single-leader copy pauses on a confirm that shows the leader's GRADED WATCHED record
  // (Grok) — you see what track record you're inheriting, never their lifetime green. A
  // consensus copy (no single wallet) has no watched record to show, so it deploys directly.
  const copy = (sym: string, side: "LONG" | "SHORT", refPrice: number, lev?: number | null, leader?: string) => {
    if (leader && /^0x[a-f0-9]{40}$/i.test(leader)) { setPendingCopy({ sym, side, refPrice, lev: lev ?? null, leader }); return; }
    doCopy(sym, side, refPrice, lev, leader);
  };

  const tradeBtn = (onClick: () => void) => (
    <button onClick={onClick} title="Copy this move — the agent enters your direction and manages the exit (PAPER-first, graded on-chain)"
      style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.04em", color: "#ededf0", background: "none", border: "1px solid #33333a", borderRadius: 3, padding: "3px 8px", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
      ⚡ TRADE
    </button>
  );

  const thesisBtn = (onClick: () => void) => (
    <button onClick={onClick} title="Turn this into a reasoned thesis — sized, R:R'd, and gradeable in the Thesis Engine"
      style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#a1a1aa", background: "none", border: "1px solid #232327", borderRadius: 3, padding: "3px 8px", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
      ◆ plan
    </button>
  );

  // ↗ Share a smart-money signal as a branded card (the viral loop on our most
  // alive surface). Consensus cards carry the trader count.
  const shareBtn = (d: PosterData) => (
    <button onClick={() => setPoster(d)} title="Share this signal"
      style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", background: "none", border: "1px solid #232327", borderRadius: 3, padding: "3px 8px", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
      ↗ share
    </button>
  );

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      {poster && <SharePoster data={poster} onClose={() => setPoster(null)} />}
      {detail && <TraderDetail source={detail.source} address={detail.address} accountId={detail.accountId} myAddress={wallet ?? undefined} onClose={() => setDetail(null)} />}
      {pendingCopy && (
        <CopyConfirm leader={pendingCopy.leader} sym={pendingCopy.sym} side={pendingCopy.side}
          onCancel={() => setPendingCopy(null)}
          onConfirm={() => { const c = pendingCopy; setPendingCopy(null); doCopy(c.sym, c.side, c.refPrice, c.lev, c.leader); }} />
      )}
      {toast && (
        <div className="nx-fade-in" style={{ position: "fixed", bottom: 20, left: 20, zIndex: 8000, background: "#0f0f11", border: "1px solid #33333a", borderLeft: `3px solid ${TRACKED}`, borderRadius: 6, padding: "10px 14px", fontFamily: "var(--nx-font-mono)", fontSize: 11, color: TRACKED, boxShadow: "0 8px 30px rgba(0,0,0,0.5)" }}>
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

      {/* How to read this — plain, congruent with Intel + the Mispriced Board. */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 12, padding: "11px 13px", border: "1px solid #232327", borderLeft: "2px solid #71717a", borderRadius: 6, background: "#0f0f11" }}>
        <span style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 12, flexShrink: 0 }}>?</span>
        <span style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: 12.5, lineHeight: 1.55, color: "#a1a1aa" }}>
          <b style={{ color: "#f4f4f5" }}>How to read this:</b> the strongest signal isn't one whale — it's <b style={{ color: "#f4f4f5" }}>agreement</b>. Consensus
          shows the coins several top traders are positioned the same way on. Smart money is often early and often wrong, so treat it as
          context — then copy a move into a trade your agent manages and grades.
        </span>
      </div>

      {/* Multi-axis conviction scan — the highest-agreement fades across the board. */}
      <ConvictionScanner />

      {/* #3 convert-loop framing — one-time */}
      <Coachmark storageKey="nexus_coach_smart_v1" badge="THE LOOP" title="From watcher to ranked trader">
        Copy any move → the agent manages the exit → every close joins <strong style={{ color: "#d4d4d8" }}>your</strong> on-chain track record.
        That's how you go from watching smart money to <strong style={{ color: "#d4d4d8" }}>being</strong> graded next to them — a record nobody can fake.
      </Coachmark>

      {loading && !board && !events && (
        <div style={{ color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 12, padding: 24, textAlign: "center" }}>indexing Hyperliquid…</div>
      )}
      {error && !board && !events && <EmptyState message={error} />}

      {/* ── #1 YOU vs SMART MONEY — your positions vs the crowd ── */}
      {alignment.length > 0 && (
        <div style={{ ...agentCardStyle, marginBottom: 12 }}>
          <div style={agentLabelStyle}>◎ YOU vs SMART MONEY <span style={{ color: "#52525b" }}>— your open positions vs where the smart money sits</span></div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {alignment.map((a) => (
              <div key={a.coin} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 4, border: `1px solid ${a.aligned ? "#33333a" : "#4a1e22"}`, background: a.aligned ? "#0f0f11" : "#0f0f11", flexWrap: "wrap" }}>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", width: 56, flexShrink: 0 }}>{a.coin}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", flexShrink: 0 }}>you <span style={{ color: a.yourSide === "LONG" ? "#3ecf8e" : "#f7525f" }}>{a.yourSide}</span></span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", flexShrink: 0 }}>smart money <span style={{ color: a.smartSide === "LONG" ? "#3ecf8e" : "#f7525f" }}>{a.smartSide}</span> <span style={{ color: "#52525b" }}>({a.traders})</span></span>
                <span style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 10, fontWeight: 700, color: a.aligned ? "#3ecf8e" : "#fbbf24", flexShrink: 0 }}>
                  {a.aligned ? "✓ ALIGNED" : "⚠ FIGHTING THE CROWD"}
                </span>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 8 }}>
            Context, not a signal — smart money is often early AND often wrong. Know which side you're on.
          </div>
        </div>
      )}

      {/* ── SMART MONEY CONSENSUS — the HERO: the highest-conviction signal ── */}
      {consensus.length > 0 && (
        <div style={{ ...agentCardStyle, marginBottom: 12, borderColor: "#33333a", borderLeft: "2px solid #ededf0" }}>
          <div style={{ ...agentLabelStyle, fontSize: 12, letterSpacing: "0.14em" }}>◆ SMART MONEY CONSENSUS <span style={{ color: "#52525b", letterSpacing: "0.06em" }}>— the strongest read: coins several top traders agree on</span></div>
          <div className="nx-stagger" style={{ marginTop: 10, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
            {consensus.map((c) => (
              <div key={`${c.sym}${c.side}`} style={{ display: "flex", alignItems: "center", gap: 10, rowGap: 6, flexWrap: "wrap", padding: "8px 10px", border: "1px solid #1a1a1e", borderRadius: 6, background: "#0f0f11" }}>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#ededf0", flexShrink: 0 }}>{c.sym}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700, color: c.side === "LONG" ? "#3ecf8e" : "#f7525f", flexShrink: 0 }}>{c.side === "LONG" ? "↑ LONG" : "↓ SHORT"}</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#a1a1aa", flexShrink: 0 }}>{c.count} traders</span>
                <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", flexShrink: 0 }}>{usd(c.netUsd)}</span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    title="Ask Nexus AI to analyze this consensus"
                    onClick={() => window.dispatchEvent(new CustomEvent("nexus:assistant-ask", { detail: { prompt: `${c.count} tracked smart-money traders are ${c.side} ${c.sym}. Use get_smart_money and explain_move — is this consensus worth following, what's driving it, and how does it fit my edge?` } }))}
                    style={{ background: "transparent", border: "1px solid #232327", borderRadius: 4, color: "#a1a1aa", fontFamily: "var(--nx-font-mono)", fontSize: 10, padding: "2px 6px", cursor: "pointer" }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "#ededf0"; e.currentTarget.style.borderColor = "#33333a"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "#a1a1aa"; e.currentTarget.style.borderColor = "#232327"; }}
                  >◆ ask</button>
                  {shareBtn({ kind: "smart", symbol: c.sym, direction: c.side, szUsd: c.netUsd, consensus: c.count })}
                  {thesisBtn(() => openThesis(c.sym, c.side, c.refPrice, `Smart-money consensus: ${c.count} top traders are ${c.side} ${c.sym}.`))}
                  {tradeBtn(() => copy(c.sym, c.side, c.refPrice))}
                </span>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 8 }}>
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
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#52525b", marginTop: 3, lineHeight: 1.5 }}>
            Top on-chain traders opening &amp; closing positions in real time — ⚡ copies a move into a trade your agent manages.
          </div>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column" }}>
            {events.slice(0, feedAll ? 30 : 8).map((e, i) => {
              const watched = watch.includes(e.addr);
              const isOpen = e.type === "OPEN";
              const long = e.side === "LONG";
              const sideColor = long ? "#3ecf8e" : "#f7525f";
              return (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 6px", paddingLeft: watched ? 8 : 6, borderBottom: "1px solid #1a1a1e", background: watched ? "#ededf008" : "transparent", borderLeft: watched ? `2px solid ${TRACKED}` : "2px solid transparent" }}>
                {/* event dot — a fresh OPEN glows in the side's color, a CLOSE is muted */}
                <span title={isOpen ? "Opened a position" : "Closed a position"} style={{ marginTop: 5, width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: isOpen ? sideColor : "#3f3f46", boxShadow: isOpen ? `0 0 6px ${sideColor}66` : "none" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* primary line — reads like a sentence: who · action · side · market */}
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap", fontFamily: "var(--nx-font-mono)" }}>
                    {watched && <span style={{ color: TRACKED, fontSize: 10 }}>★</span>}
                    <span onClick={() => openDetail(e.addr, e.source)} title="View trader detail" style={{ fontSize: 11, color: watched ? TRACKED : "#a1a1aa", cursor: "pointer", textDecoration: "underline", textDecorationColor: "#33333a" }}>{short(e.addr)}</span>
                    <span style={{ fontSize: 11, color: isOpen ? "#d4d4d8" : "#71717a" }}>{isOpen ? "opened" : "closed"}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: sideColor }}>{long ? "LONG" : "SHORT"}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#ededf0" }}>{e.sym}</span>
                  </div>
                  {/* meta line — size · price · realized pnl (on close) · source · age */}
                  <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", marginTop: 3 }}>
                    <span style={{ color: "#a1a1aa" }}>{usd(e.szUsd)}</span>
                    {e.price ? <span style={{ color: "#52525b" }}>@ {usd(e.price)}</span> : null}
                    {e.closedPnl != null && <span style={{ color: e.closedPnl >= 0 ? "#3ecf8e" : "#f7525f", fontWeight: 700 }}>{e.closedPnl >= 0 ? "+" : ""}{usd(e.closedPnl)}</span>}
                    <span style={{ color: "#3f3f46" }}>·</span>
                    <span title={e.source === "orderly" ? "Orderly (native)" : "Hyperliquid"} style={{ color: e.source === "orderly" ? "#3ecf8e" : "#52525b" }}>{e.source === "orderly" ? "◆ Orderly" : "Hyperliquid"}</span>
                    <span style={{ color: "#3f3f46" }}>·</span>
                    <span>{ago(e.ts)} ago</span>
                  </div>
                </div>
                {/* actions — only a fresh OPEN is copyable */}
                {isOpen && (
                  <span style={{ display: "flex", gap: 6, flexShrink: 0, marginTop: 1 }}>
                    {shareBtn({ kind: "smart", symbol: e.sym, direction: e.side, szUsd: e.szUsd, trader: short(e.addr) })}
                    {thesisBtn(() => openThesis(e.sym, e.side, e.price, `${short(e.addr)} (smart money) opened ${e.side} ${e.sym}.`))}
                    {tradeBtn(() => copy(e.sym, e.side, e.price, null, e.addr))}
                  </span>
                )}
              </div>
              );
            })}
          </div>
          {events.length > 8 && (
            <button onClick={() => setFeedAll((v) => !v)}
              style={{ marginTop: 8, width: "100%", background: "none", border: "1px solid #232327", borderRadius: 4, color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10, letterSpacing: "0.05em", padding: "6px 0", cursor: "pointer" }}>
              {feedAll ? "▲ show less" : `▼ show ${Math.min(30, events.length) - 8} more`}
            </button>
          )}
        </div>
      )}

      {/* ── TRACKED SIGNALS — graded tier crossings (low-noise, ~daily) ── */}
      {trackedSignals.length > 0 && (
        <div style={{ ...agentCardStyle, marginBottom: 12 }}>
          <div style={agentLabelStyle}>TRACKED SIGNALS <span style={{ color: "#52525b" }}>— Operator-tier changes, graded from realized-PnL consistency</span></div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {trackedSignals.map((s, i) => {
              const up = s.kind === "TIER_UP";
              return (
                <div key={i} onClick={() => openDetail(s.wallet, "orderly")} title="Open the wallet's Tracked Record"
                  style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", cursor: "pointer", padding: "5px 0", borderTop: i ? "1px solid #1a1a1e" : "none" }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: up ? "#3ecf8e" : "#71717a", width: 16, flexShrink: 0 }}>{up ? "▲" : "▽"}</span>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", flexShrink: 0, textDecoration: "underline", textDecorationColor: "#33333a" }}>{short(s.wallet)}</span>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa" }}>
                    {up ? "earned" : "dropped to"} {s.toTier ? `${TIER_GLYPH[s.toTier] ?? ""} ${s.toTier}` : "no tier"}
                    {s.operatorScore != null && up ? <span style={{ color: "#52525b" }}> · score {s.operatorScore}</span> : null}
                  </span>
                  <span style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#52525b", flexShrink: 0 }}>{ago(s.ts)}</span>
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
            <div style={agentLabelStyle}>SMART MONEY BOARD <span style={{ color: "#52525b" }}>— ◆ Orderly (native) + Hyperliquid</span></div>
            <button onClick={() => setWatchOnly((v) => !v)} disabled={watch.length === 0}
              title={watch.length === 0 ? "Star traders below to build a watchlist" : "Show only your watchlist"}
              style={{ marginLeft: "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, letterSpacing: "0.04em", color: watchOnly ? TRACKED : "#71717a", background: watchOnly ? "#1a1a1e" : "none", border: `1px solid ${watchOnly ? "#33333a" : "#232327"}`, borderRadius: 3, padding: "4px 9px", cursor: watch.length === 0 ? "default" : "pointer", opacity: watch.length === 0 ? 0.5 : 1 }}>
              ★ WATCHLIST{watch.length > 0 ? ` (${watch.length})` : ""}
            </button>
          </div>
          {watchOnly && shown.length === 0 && (
            <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#71717a", padding: "16px 0", textAlign: "center" }}>No watched traders in the current board. Star ★ any trader to track them.</div>
          )}
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {shown.slice(0, boardAll ? 999 : 6).map((t, i) => {
              const starred = watch.includes(t.address);
              return (
              <div key={t.address} style={{ border: "1px solid #1a1a1e", borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#52525b", width: 24, flexShrink: 0 }}>#{i + 1}</span>
                  <button onClick={() => toggleWatch(t.address)} title={starred ? "Unwatch" : "Add to watchlist"}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 13, color: starred ? TRACKED : "#52525b", flexShrink: 0, lineHeight: 1 }}>
                    {starred ? "★" : "☆"}
                  </button>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, letterSpacing: "0.05em", color: t.source === "orderly" ? "#3ecf8e" : "#71717a", border: `1px solid ${t.source === "orderly" ? "#33333a" : "#232327"}`, borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>{t.source === "orderly" ? "◆ ORDERLY" : "HL"}</span>
                  <span onClick={() => openDetail(t.address, t.source, t.accountId)} title="View trader detail" style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#ededf0", flexShrink: 0, cursor: "pointer", textDecoration: "underline", textDecorationColor: "#33333a" }}>{short(t.address)}</span>
                  <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: t.pnl >= 0 ? "#3ecf8e" : "#f7525f", flexShrink: 0 }}>{usd(t.pnl)} <span style={{ color: "#52525b" }}>{t.pnlLabel}</span></span>
                  {t.roi != null && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#a1a1aa", flexShrink: 0 }}>{(t.roi * 100).toFixed(0)}% ROI</span>}
                  {t.accountValue != null && t.accountValue > 0 && <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 10, color: "#71717a", flexShrink: 0 }}>{usd(t.accountValue)} acct</span>}
                  {(() => {
                    const tk = trackMap[t.address.toLowerCase()];
                    if (!tk) return null;
                    if (tk.tier) return (
                      <span onClick={() => openDetail(t.address, t.source, t.accountId)} title={`Consistency Score ${tk.operatorScore} — graded from ${tk.daysTracked}d of realized-PnL consistency. Click for the full Tracked Record.`}
                        style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#3ecf8e", border: "1px solid #33333a", borderRadius: 3, padding: "1px 5px", flexShrink: 0, cursor: "pointer" }}>{tk.tier.glyph} {tk.operatorScore}</span>
                    );
                    return (
                      <span title={`Tracking — ${tk.points} snapshots. A graded Consistency Score unlocks after ~4 daily windows.`}
                        style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", flexShrink: 0 }}>▪ tracking</span>
                    );
                  })()}
                  <a href={t.source === "hl" ? `/analyze?address=${t.address}` : `https://orderly-dashboard.orderly.network/address/${t.address}`} target="_blank" rel="noopener noreferrer"
                    style={{ marginLeft: isMobile ? 0 : "auto", fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#71717a", textDecoration: "none", border: "1px solid #232327", borderRadius: 3, padding: "3px 8px", flexShrink: 0 }}>
                    {t.source === "hl" ? "x-ray ↗" : "explorer ↗"}
                  </a>
                </div>
                {t.positions.length > 0 && (
                  <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                    {t.positions.slice(0, 5).map((p, j) => (
                      <div key={j} style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0", flexWrap: "nowrap", overflowX: "auto" }}>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 13, color: "#f4f4f5", flex: "1 1 72px", minWidth: 72 }}>{p.coin}</span>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 600, color: p.side === "LONG" ? "#3ecf8e" : "#f7525f", width: 78, flexShrink: 0 }}>{p.side === "LONG" ? "↑ LONG" : "↓ SHORT"}{p.lev ? ` ${p.lev}x` : ""}</span>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, color: "#a1a1aa", flex: "1 1 88px", minWidth: 88, textAlign: "right" }}>{usd(p.szUsd)}</span>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 11, color: "#52525b", flex: "1 1 92px", minWidth: 92, textAlign: "right" }}>{p.entry > 0 ? `@ $${p.entry.toLocaleString(undefined, { maximumFractionDigits: p.entry < 10 ? 4 : 2 })}` : ""}</span>
                        <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 600, color: p.uPnl >= 0 ? "#3ecf8e" : "#f7525f", flex: "1 1 88px", minWidth: 88, textAlign: "right" }}>{p.uPnl >= 0 ? "+" : ""}{usd(p.uPnl)}</span>
                        <span style={{ marginLeft: 10, flexShrink: 0 }}>
                          {p.tradeable && p.sym
                            ? tradeBtn(() => copy(p.sym as string, p.side, p.entry, p.lev, t.address))
                            : <span style={{ fontFamily: "var(--nx-font-mono)", fontSize: 8, color: "#52525b", whiteSpace: "nowrap" }}>HL-only</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              );
            })}
          </div>
          {shown.length > 6 && (
            <button onClick={() => setBoardAll((v) => !v)}
              style={{ marginTop: 8, width: "100%", background: "none", border: "1px solid #232327", borderRadius: 4, color: "#71717a", fontFamily: "var(--nx-font-mono)", fontSize: 10, letterSpacing: "0.05em", padding: "6px 0", cursor: "pointer" }}>
              {boardAll ? "▲ show top 6" : `▼ show ${shown.length - 6} more traders`}
            </button>
          )}
          <div style={{ fontFamily: "var(--nx-font-mono)", fontSize: 9, color: "#52525b", marginTop: 10, lineHeight: 1.5 }}>
            ◆ Orderly traders (public settlement indexer) copy natively; Hyperliquid traders copy directionally on Nexus. The agent manages the exit. Not financial advice.
          </div>
        </div>
        );
      })()}
    </div>
  );
}
