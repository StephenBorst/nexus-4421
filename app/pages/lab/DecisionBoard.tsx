// ── THE BOARD — every market, one read ───────────────────────────────────────
// The unified decision surface: a dense, scannable confluence grid that fuses the
// signals nobody else has into one line per market — funding (fade side), OI drift,
// 1h trend, the graded-caller lean, and the mechanical PLAY. It's the "Market Cipher"
// packaging lesson (one legible screen) done on OUR verifiable inputs instead of a
// stack of unverifiable oscillators.
//
// ⚠️ Honesty by construction (the engine work proved there is no house directional
// alpha): every column is a PUBLIC FACT (funding/OI/trend/consensus), and "THE PLAY"
// is the MECHANICAL read — what the rules say — NOT a confidence or a promise. It gets
// GRADED after the fact like every call. No fabricated edge, no fake score.
//
// Sits between the Briefing (the narrative read) and Market Intel (the deep detail):
// Briefing = "what matters now", Board = "scan the whole book", Intel = "go deep".
import { useEffect, useMemo, useState } from "react";
import { C, MONO, UI, RADIUS } from "@/config/theme";
import { SectionHeader } from "./components";
import { useIsMobile } from "./useIsMobile";
import { computeTape, FADE_FUNDING_FLOOR_PCT_YR, type MarketSignal } from "./briefing";
import type { TabId } from "./types";
import { R_CONTRACT } from "@/lib/rContract.mjs";
import { frozenLevelsFor } from "@/lib/frozenDraft";

const AGENT_API = "https://og.nexustradinglabs.com";
const FUTURES = "https://api-evm.orderly.org/v1/public/futures";
const CROWDED = 0.0004;   // |funding|/8h at/above which the crowd is extended (fade band)
// The board's /signals call gates the whole table's spinner, so a hung connection (no
// response, no reset — seen on a cold guest-context load while curl to the same URL
// returns rows) would strand it on "loading the board…" forever. Cap it: abort after
// SIGNALS_TIMEOUT_MS so the promise REJECTS instead of pending, and the caller fails
// soft to last-good/empty. No explicit return-type annotation → it infers Promise<any>
// from r.json(), so callers keep reading j?.signals exactly as before.
const SIGNALS_TIMEOUT_MS = 2000;
async function fetchJsonTimeout(url: string, ms: number) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

type Consensus = Record<string, { side: "LONG" | "SHORT" | "SPLIT"; lean: number; participants: number }>;
type Dir = "LONG" | "SHORT";
interface Row {
  sym: string;
  price: number | null;
  change24h: number | null;
  funding: number;                       // /8h decimal
  oiChange: number;                      // % (from signals)
  trend: "TREND_UP" | "TREND_DOWN" | "CHOP" | null;
  trendMove: number | null;
  trendOi: number | null;
  consensus: { side: "LONG" | "SHORT" | "SPLIT"; participants: number } | null;
  play: { klass: "FADE" | "WATCH" | null; dir: Dir | null; label: string; strong: boolean };
  fundingAnnual: number;                 // funding ×1095 — the ticket's %/yr language
  // The independent-lens strip: four PUBLIC reads that either confirm or contradict the
  // mechanical play — graded callers, smart money, catalysts, forecasters. agree = how many
  // point the SAME way as the play (the "agreement = signal" fusion, kept explainable).
  lens: { callers: Dir | null; smart: Dir | null; catalyst: Dir | null; forecast: Dir | null };
  agree: number;
  score: number;
  mine: { tone: "pos" | "caution"; text: string } | null;
  record: { net: number; n: number; wr: number } | null;   // your graded record on THIS market
}

// Catalyst board → per-coin directional lean (dominant impact side across its events).
function catalystLeans(catalysts: { impacts?: { coin?: string; direction?: string }[] }[]): Record<string, Dir> {
  const tally: Record<string, { L: number; S: number }> = {};
  for (const c of catalysts || []) for (const im of c.impacts || []) {
    const coin = String(im.coin || "").toUpperCase(); if (!coin) continue;
    const t = tally[coin] || (tally[coin] = { L: 0, S: 0 });
    if (im.direction === "LONG") t.L++; else if (im.direction === "SHORT") t.S++;
  }
  const out: Record<string, Dir> = {};
  for (const [coin, t] of Object.entries(tally)) { if (t.L > t.S) out[coin] = "LONG"; else if (t.S > t.L) out[coin] = "SHORT"; }
  return out;
}
// Forecast board → per-coin lean (dominant near-money forecast direction; UP = LONG).
// Tradable-only (markPrice present) so it matches the our-markets-only Forecast lens.
function forecastLeans(markets: { coin?: string; forecastLean?: string; markPrice?: number | null }[]): Record<string, Dir> {
  const tally: Record<string, { L: number; S: number }> = {};
  for (const m of markets || []) {
    if (m.markPrice == null) continue;
    const coin = String(m.coin || "").toUpperCase(); if (!coin || !m.forecastLean) continue;
    const t = tally[coin] || (tally[coin] = { L: 0, S: 0 });
    if (m.forecastLean === "UP") t.L++; else if (m.forecastLean === "DOWN") t.S++;
  }
  const out: Record<string, Dir> = {};
  for (const [coin, t] of Object.entries(tally)) { if (t.L > t.S) out[coin] = "LONG"; else if (t.S > t.L) out[coin] = "SHORT"; }
  return out;
}

const tk = (s: string) => s.replace("PERP_", "").replace("_USDC", "");
const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const fmtPrice = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 5 : n < 100 ? 3 : 2 }));

// The mechanical play for one market — mirrors the agent's own rule priority
// (confluence > crowded-funding fade > OI/trend), never invents a signal. STRONG
// plays (confluence/fade/trend) are real setups and render bright; below them, a
// faint LEAN tier shows which way the crowd/tape tilts so a calm market still reads
// as information, not a wall of "no read" — but a lean is explicitly NOT a setup.
// THE PLAY = the ONE verdict object (Grok): FADE SHORT / FADE LONG / WATCH. No "leans."
// The fade side is the funding sign; FADE only when funding is STRETCHED vs its own range
// (the server verdict the ticket + share card use). Falls back to the old crowded-funding
// read only if the server verdict is absent (older /signals payloads).
function derivePlay(s: MarketSignal): Row["play"] {
  const dir: Dir | null = s.fade_dir === "SHORT" || s.fade_dir === "LONG" ? s.fade_dir : null;
  // Magnitude floor (Grok): a stretch on a trivial band isn't a crowded fade — it needs an
  // economically large annualized cost too. A stretched-but-small server FADE reads WATCH here.
  const annual = Math.abs(Number(s.funding_annual_pct ?? s.funding_rate_8h * 1095 * 100));
  const bigEnough = annual >= FADE_FUNDING_FLOOR_PCT_YR;
  if (s.verdict === "FADE" && dir && bigEnough) return { klass: "FADE", dir, label: `FADE ${dir}`, strong: true };
  if (s.verdict === "FADE" && dir) return { klass: "WATCH", dir, label: "WATCH", strong: false };  // stretched but not economically large
  if (s.verdict === "WATCH") return { klass: "WATCH", dir, label: "WATCH", strong: false };
  if (s.verdict === "NONE") return { klass: null, dir: null, label: "—", strong: false };
  // legacy fallback (no server verdict): crowded funding = a fade, else no read.
  if (Math.abs(s.funding_rate_8h) >= CROWDED) { const d: Dir = s.funding_rate_8h > 0 ? "SHORT" : "LONG"; return { klass: "FADE", dir: d, label: `FADE ${d}`, strong: true }; }
  return { klass: null, dir: null, label: "—", strong: false };
}

// Actionability (Grok): a real FADE ranks first, then rows where ≥2 independent lenses agree,
// then everything else. Chop + empty lenses falls to the bottom (use FUNDING/MOVERS for those).
function scoreOf(play: Row["play"], funding: number, agree: number): number {
  const base = play.klass === "FADE" ? 300 : play.klass === "WATCH" ? (agree >= 2 ? 100 : 0) : 0;
  return base + (play.strong ? agree * 25 : 0) + Math.min(49, Math.abs(funding) * 100000);
}

// ── The personal edge lens ───────────────────────────────────────────────────
// The insight nobody else can compute: is THIS market's play YOUR kind of trade?
// Derived from the user's own graded record — which direction they measurably win
// on (userSide) and their counter-trend/with-trend align edge — the same inputs the
// Briefing's fusion uses, applied per row. Honest: it states your record, never that
// you'll win because of it.
type Trade = { symbol: string; direction: Dir; pnl: number };

// Your realized record per market (bare ticker) — the most granular personal lens,
// and the one that fires for ANY symbol you've actually traded, even without a
// directional side edge. "Should I take this BTC play? I'm +$26 net on BTC."
function symbolRecords(trades: Trade[]): Record<string, { net: number; n: number; wins: number }> {
  const m: Record<string, { net: number; n: number; wins: number }> = {};
  for (const t of trades) {
    const k = tk(t.symbol);
    const cur = m[k] || (m[k] = { net: 0, n: 0, wins: 0 });
    cur.net += t.pnl; cur.n += 1; if (t.pnl > 0) cur.wins += 1;
  }
  return m;
}
type ProcessEdge = { align?: { bucket: string; avgR: number }; contrarian?: { calls: number; avgR: number } } | null;
type Edge = { side: Dir | null; wr: number; alignClass: "AGAINST_TREND" | "WITH_TREND" | null; alignAvgR: number };

const wrOf = (r: Trade[]) => (r.length ? Math.round((r.filter((t) => t.pnl > 0).length / r.length) * 1000) / 10 : 0);

function computeEdge(trades: Trade[], proc: ProcessEdge): Edge {
  const longs = trades.filter((t) => t.direction === "LONG");
  const shorts = trades.filter((t) => t.direction === "SHORT");
  let side: Dir | null = null, wr = 0;
  if (longs.length >= 4 && shorts.length >= 4) {
    const lw = wrOf(longs), sw = wrOf(shorts);
    if (Math.abs(lw - sw) >= 12) { side = lw > sw ? "LONG" : "SHORT"; wr = Math.max(lw, sw); }
  }
  const bucket = proc?.align?.bucket || null;
  const alignClass = bucket === "align:AGAINST_TREND" ? "AGAINST_TREND" : bucket === "align:WITH_TREND" ? "WITH_TREND" : null;
  return { side, wr, alignClass, alignAvgR: proc?.align?.avgR ?? 0 };
}

// The per-row personal tag — mirrors the fusion's your-setup / not-your-side / your-class
// branches. Returns null when there's no honest personal read for this row.
function personalRead(play: Row["play"], edge: Edge): { tone: "pos" | "caution"; text: string } | null {
  if (!play.dir || !play.strong) return null;   // only real setups get a personal read, not faint leans
  if (edge.side && play.dir === edge.side) return { tone: "pos", text: `your side · ${edge.wr}% win` };
  if (edge.side && play.dir !== edge.side) return { tone: "caution", text: "off your side" };
  if (!edge.side && edge.alignClass) {
    // a FADE is a counter-trend setup — reward the trader whose edge is counter-trend.
    if (play.klass === "FADE" && edge.alignClass === "AGAINST_TREND") return { tone: "pos", text: `your class · +${edge.alignAvgR}R counter-trend` };
  }
  return null;
}

type SortMode = "actionable" | "confluence" | "funding" | "movers" | "mine";

export function DecisionBoard({ onSelectTab, trades, wallet, theses, positions }: {
  onSelectTab?: (tab: TabId) => void;
  trades?: Trade[];          // the user's closed trades — powers the personal edge lens
  wallet?: string | null;
  theses?: { symbol?: string; direction?: string; gradedOutcome?: string; status?: string }[]; // your active calls (PLAN leg)
  positions?: { symbol?: string; direction?: "LONG" | "SHORT" }[];                              // your open positions (EXECUTE leg)
}) {
  const isMobile = useIsMobile();
  const [signals, setSignals] = useState<MarketSignal[] | null>(null);
  const [tape, setTape] = useState<Record<string, { price: number; change: number }>>({});
  const [tapeRead, setTapeRead] = useState<{ score: number; label: string } | null>(null); // RISK-OFF/ON breadth — context for the fade tag
  const [consensus, setConsensus] = useState<Consensus | null>(null);
  const [smart, setSmart] = useState<Record<string, Dir>>({});       // smart-money lean per coin
  const [catalyst, setCatalyst] = useState<Record<string, Dir>>({}); // catalyst lean per coin
  const [forecast, setForecast] = useState<Record<string, Dir>>({}); // forecaster lean per coin
  const [proc, setProc] = useState<ProcessEdge>(null);
  const [sort, setSort] = useState<SortMode>("actionable");
  const [draftingSym, setDraftingSym] = useState<string | null>(null); // the row whose PLAY→draft is fetching levels

  // Personal edge = which side the user measurably wins on + their align (counter/with-
  // trend) class. From their own trades + graded process record. Fail-soft; empty when
  // disconnected → the board stays purely market-level.
  useEffect(() => {
    if (!wallet) { setProc(null); return; }
    let alive = true;
    fetch(`${AGENT_API}/theses/process/${wallet}`).then((r) => r.json())
      .then((d) => { if (alive) setProc(d?.regimeEdges?.align?.best || d?.contrarian ? { align: d?.regimeEdges?.align?.best, contrarian: d?.contrarian } : null); })
      .catch(() => { /* lens still works off trades alone */ });
    return () => { alive = false; };
  }, [wallet]);

  const edge = useMemo(() => computeEdge(trades ?? [], proc), [trades, proc]);
  const records = useMemo(() => symbolRecords(trades ?? []), [trades]);
  const hasLens = !!(edge.side || edge.alignClass || Object.keys(records).length);

  // ── THE RETURN LEG: your loop state per market ────────────────────────────────
  // The Board is the OBSERVE surface; overlay where YOU already are in the loop on each
  // market — a live call (PLAN) and/or an open position (EXECUTE) — so observe → plan →
  // execute → prove reads in one place (the graded `record` below already shows PROVE).
  const liveCallBy = useMemo(() => {
    const m: Record<string, Dir> = {};
    for (const t of theses ?? []) {
      if (!t.symbol || (t.direction !== "LONG" && t.direction !== "SHORT")) continue;
      if (t.gradedOutcome === "WIN" || t.gradedOutcome === "LOSS") continue;               // resolved → no longer live
      if (t.status === "HIT_TP" || t.status === "STOPPED_OUT" || t.status === "INVALIDATED") continue;
      m[tk(String(t.symbol)).toUpperCase()] = t.direction;
    }
    return m;
  }, [theses]);
  const inPosBy = useMemo(() => {
    const m: Record<string, Dir> = {};
    for (const p of positions ?? []) if (p.symbol && (p.direction === "LONG" || p.direction === "SHORT")) m[tk(String(p.symbol)).toUpperCase()] = p.direction;
    return m;
  }, [positions]);
  const hasLoop = Object.keys(liveCallBy).length > 0 || Object.keys(inPosBy).length > 0;

  useEffect(() => {
    let alive = true;
    const load = () => {
      // /signals gates the table spinner — timeout-cap it and fail soft to last-good
      // (or empty on the very first load) so the board can never hang on "loading…".
      fetchJsonTimeout(`${AGENT_API}/signals`, SIGNALS_TIMEOUT_MS)
        .then((j) => { if (alive) setSignals(Array.isArray(j?.signals) ? j.signals : []); })
        .catch(() => { if (alive) setSignals((prev) => prev ?? []); });
      fetch(`${AGENT_API}/theses/consensus`).then((r) => r.json()).then((j) => { if (alive) setConsensus(j?.consensus ?? null); }).catch(() => { /* no crowd lean */ });
      // Three more INDEPENDENT lenses to fuse into the read — smart money, catalysts,
      // forecasters. Each fail-soft (an absent lens just shows "·", never blocks the board).
      fetch(`${AGENT_API}/smart/consensus`).then((r) => r.json()).then((j) => {
        if (!alive) return;
        const m: Record<string, Dir> = {};
        for (const [k, v] of Object.entries((j?.consensus ?? {}) as Record<string, { side?: string }>)) {
          if (v && (v.side === "LONG" || v.side === "SHORT")) m[k.toUpperCase()] = v.side;
        }
        setSmart(m);
      }).catch(() => { /* smart lens dim */ });
      fetch(`${AGENT_API}/intel/catalysts-board`).then((r) => r.json()).then((j) => { if (alive) setCatalyst(catalystLeans(j?.catalysts ?? [])); }).catch(() => { /* catalyst lens dim */ });
      fetch(`${AGENT_API}/intel/forecasts`).then((r) => r.json()).then((j) => { if (alive) setForecast(forecastLeans(j?.markets ?? [])); }).catch(() => { /* forecast lens dim */ });
      fetch(FUTURES).then((r) => r.json()).then((j) => {
        if (!alive) return;
        const rows = j?.data?.rows ?? [];
        const map: Record<string, { price: number; change: number }> = {};
        for (const m of rows) {
          const price = Number(m.mark_price ?? m.index_price ?? 0);
          const open = Number(m["24h_open"] ?? 0);
          map[tk(m.symbol)] = { price, change: open ? ((price - open) / open) * 100 : 0 };
        }
        setTape(map);
        // Breadth read (same engine as the Briefing) — so a FADE that IS the tape's mean-
        // reversion book can be tagged RISK-OFF · FADE here, where ACTIONABLE lives (Grok).
        setTapeRead(computeTape(rows.map((m: { symbol: string; "24h_open"?: string | number; mark_price?: string | number; index_price?: string | number; last_funding_rate?: string | number }) =>
          ({ symbol: m.symbol, "24h_open": m["24h_open"], "24h_close": m.mark_price ?? m.index_price, last_funding_rate: m.last_funding_rate }))));
      }).catch(() => { /* price column just shows — */ });
    };
    load();
    const iv = setInterval(load, 30000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const rows: Row[] = useMemo(() => {
    if (!signals) return [];
    const out = signals.map((s) => {
      const play = derivePlay(s);
      const t = tape[s.symbol] || null;
      const c = consensus?.[s.symbol];
      const coin = String(s.symbol).toUpperCase();
      const lens: Row["lens"] = {
        callers: c && c.side !== "SPLIT" ? c.side : null,
        smart: smart[coin] ?? null,
        catalyst: catalyst[coin] ?? null,
        forecast: forecast[coin] ?? null,
      };
      // agreement = independent lenses pointing the SAME way as the mechanical play.
      const agree = play.dir ? (Object.values(lens).filter((v) => v === play.dir).length) : 0;
      return {
        sym: s.symbol,
        price: t?.price ?? null,
        change24h: t?.change ?? null,
        funding: s.funding_rate_8h,
        fundingAnnual: Number(s.funding_annual_pct ?? s.funding_rate_8h * 1095 * 100),
        oiChange: s.oi_change_pct,
        trend: s.trend ?? null,
        trendMove: s.trend_move_pct ?? null,
        trendOi: s.trend_oi_pct ?? null,
        consensus: c ? { side: c.side, participants: c.participants } : null,
        play,
        lens,
        agree,
        // ACTIONABLE ranks a real FADE first, then rows with ≥2 agreeing lenses (Grok).
        score: scoreOf(play, s.funding_rate_8h, agree),
        mine: personalRead(play, edge),
        record: (() => { const rec = records[s.symbol]; return rec && rec.n >= 2 ? { net: rec.net, n: rec.n, wr: Math.round((rec.wins / rec.n) * 100) } : null; })(),
      } as Row;
    });
    // "mine" ranks your-edge plays first, then any market you have a record on, then the rest.
    const mineRank = (r: Row) => (r.mine?.tone === "pos" ? 0 : r.record ? 1 : r.mine?.tone === "caution" ? 2 : 3);
    // "confluence" ranks the most-confirmed real setups first (agreement = signal).
    const confRank = (r: Row) => (r.play.strong ? r.agree : -1);
    const cmp: Record<SortMode, (a: Row, b: Row) => number> = {
      actionable: (a, b) => b.score - a.score,
      confluence: (a, b) => (confRank(b) - confRank(a)) || (b.score - a.score),
      funding: (a, b) => Math.abs(b.funding) - Math.abs(a.funding),
      movers: (a, b) => Math.abs(b.change24h ?? 0) - Math.abs(a.change24h ?? 0),
      mine: (a, b) => (mineRank(a) - mineRank(b)) || (b.score - a.score),
    };
    return out.sort(cmp[sort]);
  }, [signals, tape, consensus, smart, catalyst, forecast, sort, edge, records]);

  // OBSERVE → PLAN handoff: a clean read is a thesis waiting to be written. Draft the
  // play into the Thesis Engine (same contract the Mispriced board + copilot use).
  const draftPlay = async (r: Row) => {
    if (!r.play.dir || draftingSym) return;
    const dir = r.play.dir;
    const crowd = dir === "SHORT" ? "long" : "short";
    // Carry the FUSION into the plan: name the independent lenses that confirm this play so
    // the drafted thesis records WHY it was a confluent read (the loop stays explainable).
    const lensName: Record<string, string> = { callers: "graded callers", smart: "smart money", catalyst: "catalysts", forecast: "forecasters" };
    const agreeing = (["callers", "smart", "catalyst", "forecast"] as const).filter((k) => r.lens[k] === dir);
    const confNote = r.agree >= 2 ? ` ${r.agree} independent reads confirm this: ${agreeing.map((k) => lensName[k]).join(", ")}.` : "";
    // why = the board verdict + funding (the same object the ticket shows).
    const why = `${r.play.label} · funding ${r.fundingAnnual >= 0 ? "+" : ""}${r.fundingAnnual.toFixed(1)}%/yr, crowd offside ${crowd}`;
    // Fill the FROZEN object from the SAME shared helper the Catalyst card uses (mark + 1.2× H4
    // ATR-14 stop + 1.5R + 7d, levels from rContract.mjs) so the fade lands one tap from the row
    // as a complete graded thesis — no second schema, no hunting the engine. If the candles can't
    // fill it (thin history), fall back to an entry-only prefill and let the engine BUILD the stop.
    setDraftingSym(r.sym);
    let lv = null as Awaited<ReturnType<typeof frozenLevelsFor>>;
    try { lv = await frozenLevelsFor(`PERP_${r.sym}_USDC`, dir); } catch { /* fall back below */ }
    const draft = lv
      ? {
          symbol: r.sym, direction: dir,
          entryPrice: String(lv.entryPrice), stopLoss: String(lv.stopLoss), takeProfit1: String(lv.takeProfit1),
          targetWindow: `${lv.holdDays}d`,
          catalyst: why,
          notes: `${r.play.label} — the crowd is stretched ${crowd}. Frozen: entry at mark, stop ${R_CONTRACT.atrMult}× H4 ATR(14), TP +${lv.riskReward}R, ${lv.holdDays}-day time-stop. Graded first-touch vs the tape.${confNote}`,
        }
      : {
          symbol: r.sym, direction: dir,
          // Prefill the entry from the live mark so the read arrives one field closer to armed —
          // the engine's BUILD sets the frozen stop from live volatility, the trader sets target.
          entryPrice: r.price != null ? String(r.price) : "",
          catalyst: why,
          notes: `${r.play.label} — the crowd is stretched ${crowd}. BUILD sets a 1.2× H4 ATR stop from live volatility; set your target, then it grades first-touch vs the tape.${confNote}`,
        };
    try { window.localStorage.setItem("nexus_thesis_draft", JSON.stringify(draft)); } catch { /* private mode */ }
    try {
      window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "thesis" } }));
      window.dispatchEvent(new CustomEvent("nexus:thesis-draft"));
    } catch { /* non-browser */ }
    setDraftingSym(null);
    onSelectTab?.("thesis");
  };

  if (signals && signals.length === 0) return null;   // fail-soft: nothing to say

  const dirColor = (d: Dir | null) => (d === "LONG" ? C.pos : d === "SHORT" ? C.neg : C.text.faint);
  const sortBtn = (mode: SortMode, label: string) => (
    <button onClick={() => setSort(mode)} style={{
      background: sort === mode ? "#1a1a1e" : "none", border: `1px solid ${sort === mode ? C.accent : C.border}`,
      color: sort === mode ? C.accent : C.text.muted, fontFamily: MONO, fontSize: 9, letterSpacing: "0.08em",
      padding: isMobile ? "6px 4px" : "4px 9px", borderRadius: RADIUS.sm, cursor: "pointer",
      // On phones each chip fills its equal grid cell (congruent) and never wraps its label.
      ...(isMobile ? { width: "100%", textAlign: "center" as const, whiteSpace: "nowrap" as const, minHeight: 30 } : {}),
    }}>{label}</button>
  );
  // Extracted so the same SHARE control sits in the desktop inline row AND the mobile header
  // row (no marginLeft:auto on mobile — it lives in a space-between flex there).
  const shareBtn = (
    <button
      onClick={() => {
        const text = "The Board on Nexus — every market, one read, graded from public price. The mechanical play + how many independent reads confirm it:";
        const url = "https://og.nexustradinglabs.com/share/board";
        window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, "_blank", "noopener");
      }}
      title="Share this live read as a card on X"
      className="nx-press"
      style={{
        marginLeft: isMobile ? 0 : "auto", background: "none", border: `1px solid ${C.border}`, color: C.text.muted,
        fontFamily: MONO, fontSize: 9, letterSpacing: "0.08em", padding: "4px 10px", borderRadius: RADIUS.sm, cursor: "pointer", flexShrink: 0,
      }}
    >↗ SHARE</button>
  );

  const cols = "minmax(60px,0.85fr) minmax(76px,1fr) minmax(84px,1.05fr) 54px minmax(66px,0.8fr) minmax(140px,1.6fr) minmax(118px,1.25fr) 34px";
  const cell: React.CSSProperties = { fontFamily: MONO, fontSize: 11, display: "flex", alignItems: "center", minWidth: 0 };
  const head: React.CSSProperties = { fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", textTransform: "uppercase", color: C.text.faint, display: "flex", alignItems: "center" };
  // Tighter grid on phones — less column gap + row padding so the dense table doesn't
  // waste vertical space (the two-line PLAY cell already adds height).
  const gridGap = isMobile ? 6 : 10;
  const rowPad = isMobile ? "6px 8px" : "9px 10px";
  const headPad = isMobile ? "0 8px 6px" : "0 10px 8px";

  return (
    <div style={{ marginBottom: 28 }}>
      <SectionHeader
        eyebrow="THE BOARD"
        title="Every market, one read"
        note={<span>{signals ? `${rows.length} markets` : "loading…"}{signals && rows.some((r) => r.play.strong && r.agree >= 3) ? ` · ${rows.filter((r) => r.play.strong && r.agree >= 3).length} in confluence` : ""} · every column verifiable</span>}
      />

      {/* Honesty framing — the whole point of the moat. */}
      <div style={{ fontFamily: UI, fontSize: 11, lineHeight: 1.5, color: C.text.muted, marginTop: -8, marginBottom: 14 }}>
        Funding and positioning are <b style={{ color: C.text.bright }}>public facts</b>. <b style={{ color: C.text.bright }}>The play</b> is one verdict word — <b style={{ color: C.text.bright }}>FADE</b> only when the crowd is <b style={{ color: C.text.bright }}>stretched</b> vs its own funding range, <b style={{ color: C.text.muted }}>WATCH</b> when it's merely elevated — the SAME read as the ticket. It grades <b style={{ color: C.text.bright }}>from the tape</b> after, like every call. No score to trust; a record to verify.
        {" "}<b style={{ color: C.text.bright }}>Confluence</b> shows four INDEPENDENT reads — <span style={{ color: C.text.muted }}>callers · smart money · catalysts · forecasters</span> — and how many <b style={{ color: C.text.bright }}>agree with the play</b> (<span style={{ color: C.accent }}>◆</span> marks where separate signals converge). Agreement is a reason to look, still graded after.
        {hasLens && <> Each play is also matched against <b style={{ color: C.pos }}>your own graded edge</b> — <span style={{ color: C.pos }}>◆ your side/class</span> vs <span style={{ color: C.warn }}>△ off your edge</span>.</>}
        {hasLoop && <> Your loop state rides on the ticker: <b style={{ color: C.text.bright }}>● a live call</b> (planned) · <b style={{ color: C.text.bright }}>▸ an open position</b> (executing) — the graded record closes it.</>}
      </div>

      {/* Sort controls. Desktop = one inline row. Mobile = SORT + SHARE on a header line, then
          the chips in an equal-width repeat(3,1fr) grid so they're congruent and WRAP instead of
          running off the right edge (the tab-row pattern). Share the LIVE read as a branded card
          that unfurls on X (the flywheel). */}
      {isMobile ? (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontFamily: MONO, fontSize: 9, color: C.text.faint, letterSpacing: "0.06em" }}>SORT</span>
            {shareBtn}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {hasLens && sortBtn("mine", "◆ MINE")}
            {sortBtn("actionable", "ACTIONABLE")}
            {sortBtn("confluence", "◆ CONFLUENCE")}
            {sortBtn("funding", "FUNDING")}
            {sortBtn("movers", "MOVERS")}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center" }}>
          <span style={{ fontFamily: MONO, fontSize: 9, color: C.text.faint, alignSelf: "center", letterSpacing: "0.06em" }}>SORT</span>
          {hasLens && sortBtn("mine", "◆ MINE")}
          {sortBtn("actionable", "ACTIONABLE")}
          {sortBtn("confluence", "◆ CONFLUENCE")}
          {sortBtn("funding", "FUNDING")}
          {sortBtn("movers", "MOVERS")}
          {shareBtn}
        </div>
      )}

      {!signals ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint, padding: "18px 4px" }}>loading the board…</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 720 }}>
            {/* header row */}
            <div style={{ display: "grid", gridTemplateColumns: cols, gap: gridGap, padding: headPad, borderBottom: `1px solid ${C.border}` }}>
              <div style={head}>Market</div>
              <div style={head}>Last / 24h</div>
              <div style={head}>Funding /yr</div>
              <div style={head}>OI Δ</div>
              <div style={head}>Trend</div>
              <div style={head}>Confluence</div>
              <div style={head}>The play</div>
              <div style={head} />
            </div>
            {rows.map((r) => {
              const fundHot = Math.abs(r.funding) >= CROWDED;
              // A confirmed setup = a real play with ≥3 independent lenses agreeing. The whole
              // moat in one glance: not one indicator, but where separate verifiable reads converge.
              const confluent = r.play.strong && !!r.play.dir && r.agree >= 3;
              const pc = C.accent; // FADE highlight = bone accent (matches the ticket; green stays profit-only)
              // Is THIS fade the mean-reversion book the tape favors? (long into RISK-OFF /
              // short into RISK-ON) — a context tag, never a vote, so the risk-off gate reads
              // as "keep the stretched fade," not "kill longs." Only on real FADE plays.
              const tapeFadeTag = r.play.klass === "FADE" && r.play.dir && tapeRead
                ? (tapeRead.label === "RISK-OFF" && r.play.dir === "LONG" ? "RISK-OFF"
                  : tapeRead.label === "RISK-ON" && r.play.dir === "SHORT" ? "RISK-ON" : null)
                : null;
              return (
                <div key={r.sym} style={{ display: "grid", gridTemplateColumns: cols, gap: gridGap, padding: rowPad, borderBottom: `1px solid ${C.surfaceAlt}`, alignItems: "center", borderLeft: confluent ? `3px solid ${pc}` : "3px solid transparent", background: confluent ? `${pc}0c` : undefined }}>
                  {/* Market + YOUR loop state: ● live call (plan) · ◆ in position (execute) */}
                  <div style={{ ...cell, fontSize: 13, fontWeight: 700, color: C.text.bright, gap: 5 }}>
                    <span>{r.sym}</span>
                    {liveCallBy[r.sym] && <span title={`Your live call here: ${liveCallBy[r.sym].toLowerCase()} — a plan already staked`} style={{ fontSize: 8, color: dirColor(liveCallBy[r.sym]), lineHeight: 1 }}>●</span>}
                    {inPosBy[r.sym] && <span title={`You're in a ${inPosBy[r.sym].toLowerCase()} position here — executing`} style={{ fontSize: 9, color: dirColor(inPosBy[r.sym]), lineHeight: 1 }}>▸</span>}
                  </div>
                  {/* Last / 24h */}
                  <div style={{ ...cell, flexDirection: "column", alignItems: "flex-start", gap: 1 }}>
                    <span style={{ color: C.text.bright, fontSize: 11 }}>{r.price != null ? `$${fmtPrice(r.price)}` : "—"}</span>
                    {r.change24h != null && <span style={{ fontSize: 9, color: r.change24h >= 0 ? C.pos : C.neg }}>{pct(r.change24h)}</span>}
                  </div>
                  {/* Funding — annualized (%/yr) to match the ticket + share card; amber when the crowd is hot */}
                  <div style={{ ...cell }}>
                    <span style={{ color: fundHot ? C.warn : C.text.muted }}>{r.fundingAnnual >= 0 ? "+" : ""}{r.fundingAnnual.toFixed(1)}%</span>
                  </div>
                  {/* OI change — hidden when ~0 (a dead 0.0% column looked fake); "—" until it moves */}
                  <div style={{ ...cell, color: Math.abs(r.oiChange) >= 3 ? C.text.bright : C.text.faint }}>{Math.abs(r.oiChange) < 0.05 ? <span style={{ color: C.text.faint }}>—</span> : `${r.oiChange >= 0 ? "+" : ""}${r.oiChange.toFixed(1)}%`}</div>
                  {/* Trend */}
                  <div style={{ ...cell, fontSize: 10 }}>
                    {r.trend === "TREND_UP" ? <span style={{ color: C.pos }}>↑ up{r.trendMove != null ? ` ${r.trendMove.toFixed(1)}%` : ""}</span>
                    : r.trend === "TREND_DOWN" ? <span style={{ color: C.neg }}>↓ dn{r.trendMove != null ? ` ${Math.abs(r.trendMove).toFixed(1)}%` : ""}</span>
                    : <span style={{ color: C.text.faint }}>chop</span>}
                  </div>
                  {/* CONFLUENCE — how many of the four INDEPENDENT reads (callers · smart ·
                      catalyst · forecast) confirm THE PLAY, as a legible "2/4" — not glyph soup
                      (Grok). A lens FIGHTING the play is named "✗ callers" so an ETH-style
                      conflict is visible without decoding abbreviations. No E[R] in this cell. */}
                  <div style={{ ...cell, gap: 6, flexWrap: "wrap" }}>
                    {(() => {
                      const lensList = [
                        { k: "callers", v: r.lens.callers },
                        { k: "smart", v: r.lens.smart },
                        { k: "catalyst", v: r.lens.catalyst },
                        { k: "forecast", v: r.lens.forecast },
                      ] as { k: string; v: Dir | null }[];
                      if (!r.play.dir) {
                        const n = lensList.filter((l) => l.v).length;
                        return <span style={{ fontFamily: MONO, fontSize: 10, color: C.text.faint }} title="No play — lenses with any read">{n ? `${n}/4 reads` : "—"}</span>;
                      }
                      const against = lensList.filter((l) => l.v && l.v !== r.play.dir);
                      const col = r.agree >= 3 ? C.accent : r.agree >= 2 ? C.text.bright : C.text.muted;
                      return (
                        <>
                          <span title="Independent reads confirming THE PLAY: graded callers · smart money · catalysts · forecasters" style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: col }}>{r.agree}/4</span>
                          {against.map((l) => (
                            <span key={l.k} title={`${l.k} is ${l.v?.toLowerCase()} — against the play`} style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 600, color: C.warn, whiteSpace: "nowrap" }}>✗ {l.k}</span>
                          ))}
                        </>
                      );
                    })()}
                  </div>
                  {/* THE PLAY — the ONE verdict word (Grok): FADE SHORT / FADE LONG / WATCH — the
                      SAME object as the ticket + share card. FADE in bone; when smart money is
                      offside the fade, name it (·SMART LONG) rather than pretend it's the play. */}
                  <div style={{ ...cell, flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                    {r.play.klass === "FADE"
                      ? <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                          <span style={{ color: C.text.bright, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.03em" }}>{r.play.label}</span>
                          {tapeFadeTag && (
                            <span title={`Broad tape is ${tapeFadeTag} — this stretched fade is the mean-reversion book that tape favors (context, not a vote)`} style={{ fontSize: 8, color: C.accent, border: `1px solid ${C.accent}55`, borderRadius: 3, padding: "0 4px", lineHeight: 1.6, letterSpacing: "0.04em" }}>{tapeFadeTag} · FADE</span>
                          )}
                          {r.lens.smart && r.play.dir && r.lens.smart !== r.play.dir && (
                            <span title="Smart money is positioned WITH the crowd, against the fade — not a clean fade" style={{ fontSize: 9, color: C.warn, fontWeight: 600 }}>· SMART {r.lens.smart}</span>
                          )}
                        </span>
                      : r.play.klass === "WATCH"
                      ? <span style={{ color: C.text.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em" }}>WATCH</span>
                      : <span style={{ color: C.text.faint, fontSize: 11 }}>—</span>}
                    {r.mine ? (
                      <span style={{ fontSize: 8.5, letterSpacing: "0.02em", color: r.mine.tone === "pos" ? C.pos : C.warn, display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 9 }}>{r.mine.tone === "pos" ? "◆" : "△"}</span>{r.mine.text}
                      </span>
                    ) : r.record ? (
                      <span style={{ fontSize: 8.5, letterSpacing: "0.02em", color: C.text.faint, display: "inline-flex", alignItems: "center", gap: 4 }}>
                        your record <b style={{ color: r.record.net >= 0 ? C.pos : C.neg }}>{r.record.net >= 0 ? "+" : "−"}${Math.abs(r.record.net) >= 1000 ? `${(Math.abs(r.record.net) / 1000).toFixed(1)}k` : Math.abs(r.record.net).toFixed(0)}</b>
                        <span style={{ color: C.text.faint }}>· {r.record.n}t · {r.record.wr}%</span>
                      </span>
                    ) : null}
                  </div>
                  {/* Action — draft the play as a thesis (real setups only) */}
                  <div style={{ ...cell, justifyContent: "flex-end" }}>
                    {r.play.strong && r.play.dir && (() => {
                      const busy = draftingSym === r.sym;
                      return (
                        <button onClick={() => draftPlay(r)} disabled={!!draftingSym}
                          title="Draft this fade as a graded thesis — mark · 1.2× H4 ATR stop · 1.5R · 7d" style={{
                          background: "#1a1a1e", border: `1px solid ${C.border}`, color: C.accent, fontFamily: MONO, fontSize: 11,
                          width: 26, height: 24, borderRadius: RADIUS.sm, cursor: draftingSym ? "default" : "pointer", lineHeight: 1,
                          opacity: draftingSym && !busy ? 0.4 : 1,
                        }}>{busy ? "…" : "→"}</button>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Scan → deep read: THE BOARD is the fast confluence scan; each column opens up into
          a lens right below (Funding = which fades PAID vs a TRAP, Positioning = crowd vs
          smart), and the full wallet board is the Smart Money drill-down. One spine. */}
      {signals && signals.length > 0 && (
        <div style={{ marginTop: 14, fontFamily: UI, fontSize: 11, lineHeight: 1.5, color: C.text.muted }}>
          The deep read is right below — <b style={{ color: C.text.bright }}>Funding Edges</b> (which fades PAID vs a TRAP) and <b style={{ color: C.text.bright }}>Positioning</b> (crowd vs smart).
          {onSelectTab && <> The full wallet board is in <button onClick={() => onSelectTab("smart")} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: MONO, color: C.accent }}>[ SMART MONEY ] →</button></>}
        </div>
      )}
    </div>
  );
}
