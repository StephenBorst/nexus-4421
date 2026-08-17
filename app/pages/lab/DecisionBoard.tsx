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
import type { MarketSignal } from "./briefing";
import type { TabId } from "./types";

const AGENT_API = "https://og.nexustradinglabs.com";
const FUTURES = "https://api-evm.orderly.org/v1/public/futures";
const CROWDED = 0.0004;   // |funding|/8h at/above which the crowd is extended (fade band)

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
  play: { klass: "CONFLUENCE" | "FADE" | "TREND" | null; dir: Dir | null; label: string };
  score: number;
  mine: { tone: "pos" | "caution"; text: string } | null;
}

const tk = (s: string) => s.replace("PERP_", "").replace("_USDC", "");
const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const fmtPrice = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 5 : n < 100 ? 3 : 2 }));

// The mechanical play for one market — mirrors the agent's own rule priority
// (confluence > crowded-funding fade > OI/trend), never invents a signal.
function derivePlay(s: MarketSignal): Row["play"] {
  if (s.confluence === "LONG" || s.confluence === "SHORT") {
    return { klass: "CONFLUENCE", dir: s.confluence, label: `Confluence ${s.confluence === "LONG" ? "long" : "short"}` };
  }
  if (Math.abs(s.funding_rate_8h) >= CROWDED) {
    const dir: Dir = s.funding_rate_8h > 0 ? "SHORT" : "LONG";
    return { klass: "FADE", dir, label: `Fade ${dir === "LONG" ? "long" : "short"}` };
  }
  if ((s.trend === "TREND_UP" || s.trend === "TREND_DOWN") && (s.trend_oi_pct ?? 0) >= 1) {
    const dir: Dir = s.trend === "TREND_UP" ? "LONG" : "SHORT";
    return { klass: "TREND", dir, label: `Ride ${dir === "LONG" ? "up" : "down"}` };
  }
  return { klass: null, dir: null, label: "—" };
}

// Actionability: confluence beats a crowded fade beats a confirmed trend, plus the raw
// funding magnitude as a tiebreak. Only the DEFAULT sort — the read itself isn't ranked.
function scoreOf(play: Row["play"], funding: number): number {
  const base = play.klass === "CONFLUENCE" ? 300 : play.klass === "FADE" ? 200 : play.klass === "TREND" ? 100 : 0;
  return base + Math.min(99, Math.abs(funding) * 100000);
}

// ── The personal edge lens ───────────────────────────────────────────────────
// The insight nobody else can compute: is THIS market's play YOUR kind of trade?
// Derived from the user's own graded record — which direction they measurably win
// on (userSide) and their counter-trend/with-trend align edge — the same inputs the
// Briefing's fusion uses, applied per row. Honest: it states your record, never that
// you'll win because of it.
type Trade = { direction: Dir; pnl: number };
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
  if (!play.dir) return null;
  if (edge.side && play.dir === edge.side) return { tone: "pos", text: `your side · ${edge.wr}% win` };
  if (edge.side && play.dir !== edge.side) return { tone: "caution", text: "off your side" };
  if (!edge.side && edge.alignClass) {
    const counterTrend = play.klass === "FADE" || play.klass === "CONFLUENCE";
    if (counterTrend && edge.alignClass === "AGAINST_TREND") return { tone: "pos", text: `your class · +${edge.alignAvgR}R counter-trend` };
    if (play.klass === "TREND" && edge.alignClass === "WITH_TREND") return { tone: "pos", text: `your class · +${edge.alignAvgR}R with trend` };
  }
  return null;
}

type SortMode = "actionable" | "funding" | "movers" | "mine";

export function DecisionBoard({ onSelectTab, trades, wallet }: {
  onSelectTab?: (tab: TabId) => void;
  trades?: Trade[];          // the user's closed trades — powers the personal edge lens
  wallet?: string | null;
}) {
  const isMobile = useIsMobile();
  const [signals, setSignals] = useState<MarketSignal[] | null>(null);
  const [tape, setTape] = useState<Record<string, { price: number; change: number }>>({});
  const [consensus, setConsensus] = useState<Consensus | null>(null);
  const [proc, setProc] = useState<ProcessEdge>(null);
  const [sort, setSort] = useState<SortMode>("actionable");

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
  const hasLens = !!(edge.side || edge.alignClass);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(`${AGENT_API}/signals`).then((r) => r.json()).then((j) => { if (alive) setSignals(Array.isArray(j?.signals) ? j.signals : []); }).catch(() => alive && setSignals([]));
      fetch(`${AGENT_API}/theses/consensus`).then((r) => r.json()).then((j) => { if (alive) setConsensus(j?.consensus ?? null); }).catch(() => { /* no crowd lean */ });
      fetch(FUTURES).then((r) => r.json()).then((j) => {
        if (!alive) return;
        const map: Record<string, { price: number; change: number }> = {};
        for (const m of j?.data?.rows ?? []) {
          const price = Number(m.mark_price ?? m.index_price ?? 0);
          const open = Number(m["24h_open"] ?? 0);
          map[tk(m.symbol)] = { price, change: open ? ((price - open) / open) * 100 : 0 };
        }
        setTape(map);
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
      return {
        sym: s.symbol,
        price: t?.price ?? null,
        change24h: t?.change ?? null,
        funding: s.funding_rate_8h,
        oiChange: s.oi_change_pct,
        trend: s.trend ?? null,
        trendMove: s.trend_move_pct ?? null,
        trendOi: s.trend_oi_pct ?? null,
        consensus: c ? { side: c.side, participants: c.participants } : null,
        play,
        score: scoreOf(play, s.funding_rate_8h),
        mine: personalRead(play, edge),
      } as Row;
    });
    // "mine" ranks your-edge plays first (positive tag), then off-your-side, then the rest.
    const mineRank = (r: Row) => (r.mine?.tone === "pos" ? 0 : r.mine?.tone === "caution" ? 1 : 2);
    const cmp: Record<SortMode, (a: Row, b: Row) => number> = {
      actionable: (a, b) => b.score - a.score,
      funding: (a, b) => Math.abs(b.funding) - Math.abs(a.funding),
      movers: (a, b) => Math.abs(b.change24h ?? 0) - Math.abs(a.change24h ?? 0),
      mine: (a, b) => (mineRank(a) - mineRank(b)) || (b.score - a.score),
    };
    return out.sort(cmp[sort]);
  }, [signals, tape, consensus, sort, edge]);

  // OBSERVE → PLAN handoff: a clean read is a thesis waiting to be written. Draft the
  // play into the Thesis Engine (same contract the Mispriced board + copilot use).
  const draftPlay = (r: Row) => {
    if (!r.play.dir) return;
    const crowd = r.play.dir === "SHORT" ? "long" : "short";
    const draft = {
      symbol: r.sym,
      direction: r.play.dir,
      catalyst: `${r.play.label} · funding ${(r.funding * 100).toFixed(3)}%/8h`,
      notes: r.play.klass === "CONFLUENCE"
        ? `Funding and open interest agree — the crowd is offside ${crowd}. Set your own entry, stop and target; it grades from public price.`
        : `${r.play.label} — the mechanical read, not a promise. Add your levels; it grades first-touch vs the tape.`,
    };
    try { window.localStorage.setItem("nexus_thesis_draft", JSON.stringify(draft)); } catch { /* private mode */ }
    try {
      window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "thesis" } }));
      window.dispatchEvent(new CustomEvent("nexus:thesis-draft"));
    } catch { /* non-browser */ }
    onSelectTab?.("thesis");
  };

  if (signals && signals.length === 0) return null;   // fail-soft: nothing to say

  const dirColor = (d: Dir | null) => (d === "LONG" ? C.pos : d === "SHORT" ? C.neg : C.text.faint);
  const sortBtn = (mode: SortMode, label: string) => (
    <button onClick={() => setSort(mode)} style={{
      background: sort === mode ? "#1a1a1e" : "none", border: `1px solid ${sort === mode ? C.accent : C.border}`,
      color: sort === mode ? C.accent : C.text.muted, fontFamily: MONO, fontSize: 9, letterSpacing: "0.08em",
      padding: "4px 9px", borderRadius: RADIUS.sm, cursor: "pointer",
    }}>{label}</button>
  );

  const cols = "minmax(64px,0.9fr) minmax(78px,1fr) minmax(88px,1.1fr) 64px minmax(74px,0.9fr) minmax(76px,0.9fr) minmax(120px,1.3fr) 40px";
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
        eyebrow="// THE BOARD"
        title="Every market, one read"
        note={<span>{signals ? `${rows.length} markets` : "loading…"} · every column verifiable</span>}
      />

      {/* Honesty framing — the whole point of the moat. */}
      <div style={{ fontFamily: UI, fontSize: 11, lineHeight: 1.5, color: C.text.muted, marginTop: -8, marginBottom: 14 }}>
        Funding, open interest and trend are <b style={{ color: C.text.bright }}>public facts</b>. <b style={{ color: C.text.bright }}>The play</b> is the mechanical read — what the rules say, not a promise — and it gets <b style={{ color: C.text.bright }}>graded from the tape</b> afterward, same as every call. No score to trust; a record to verify.
        {hasLens && <> Each play is matched against <b style={{ color: C.pos }}>your own graded edge</b> — <span style={{ color: C.pos }}>◆ your side/class</span> vs <span style={{ color: C.warn }}>△ off your edge</span>.</>}
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: C.text.faint, alignSelf: "center", letterSpacing: "0.06em" }}>SORT</span>
        {hasLens && sortBtn("mine", "◆ MINE")}
        {sortBtn("actionable", "ACTIONABLE")}
        {sortBtn("funding", "FUNDING")}
        {sortBtn("movers", "MOVERS")}
      </div>

      {!signals ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint, padding: "18px 4px" }}>loading the board…</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 640 }}>
            {/* header row */}
            <div style={{ display: "grid", gridTemplateColumns: cols, gap: gridGap, padding: headPad, borderBottom: `1px solid ${C.border}` }}>
              <div style={head}>Market</div>
              <div style={head}>Last / 24h</div>
              <div style={head}>Funding /8h</div>
              <div style={head}>OI Δ</div>
              <div style={head}>Trend</div>
              <div style={head}>Callers</div>
              <div style={head}>The play</div>
              <div style={head} />
            </div>
            {rows.map((r) => {
              const fundHot = Math.abs(r.funding) >= CROWDED;
              return (
                <div key={r.sym} style={{ display: "grid", gridTemplateColumns: cols, gap: gridGap, padding: rowPad, borderBottom: `1px solid ${C.surfaceAlt}`, alignItems: "center" }}>
                  {/* Market */}
                  <div style={{ ...cell, fontSize: 13, fontWeight: 700, color: C.text.bright }}>{r.sym}</div>
                  {/* Last / 24h */}
                  <div style={{ ...cell, flexDirection: "column", alignItems: "flex-start", gap: 1 }}>
                    <span style={{ color: C.text.bright, fontSize: 11 }}>{r.price != null ? `$${fmtPrice(r.price)}` : "—"}</span>
                    {r.change24h != null && <span style={{ fontSize: 9, color: r.change24h >= 0 ? C.pos : C.neg }}>{pct(r.change24h)}</span>}
                  </div>
                  {/* Funding — colored by crowd side (positive = crowd long = amber/hot) */}
                  <div style={{ ...cell }}>
                    <span style={{ color: fundHot ? C.warn : C.text.muted }}>{(r.funding * 100).toFixed(4)}%</span>
                  </div>
                  {/* OI change */}
                  <div style={{ ...cell, color: Math.abs(r.oiChange) >= 3 ? C.text.bright : C.text.faint }}>{r.oiChange >= 0 ? "+" : ""}{r.oiChange.toFixed(1)}%</div>
                  {/* Trend */}
                  <div style={{ ...cell, fontSize: 10 }}>
                    {r.trend === "TREND_UP" ? <span style={{ color: C.pos }}>↑ up{r.trendMove != null ? ` ${r.trendMove.toFixed(1)}%` : ""}</span>
                    : r.trend === "TREND_DOWN" ? <span style={{ color: C.neg }}>↓ dn{r.trendMove != null ? ` ${Math.abs(r.trendMove).toFixed(1)}%` : ""}</span>
                    : <span style={{ color: C.text.faint }}>chop</span>}
                  </div>
                  {/* Callers (graded consensus) */}
                  <div style={{ ...cell, fontSize: 10 }}>
                    {r.consensus && r.consensus.side !== "SPLIT"
                      ? <span style={{ color: r.consensus.side === "LONG" ? C.pos : C.neg }}>{r.consensus.side === "LONG" ? "long" : "short"} <span style={{ color: C.text.faint }}>{r.consensus.participants}</span></span>
                      : <span style={{ color: C.text.faint }}>{r.consensus ? "split" : "—"}</span>}
                  </div>
                  {/* THE PLAY — the mechanical read, + your personal edge lens below it */}
                  <div style={{ ...cell, flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                    {r.play.klass
                      ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: dirColor(r.play.dir), flexShrink: 0 }} />
                          <span style={{ color: dirColor(r.play.dir), fontSize: 11, fontWeight: 600 }}>{r.play.label}</span>
                          {r.play.klass === "CONFLUENCE" && <span style={{ fontSize: 8, color: C.text.faint, border: `1px solid ${C.border}`, borderRadius: 3, padding: "0 4px" }}>◆</span>}
                        </span>
                      : <span style={{ color: C.text.faint, fontSize: 11 }}>no clean read</span>}
                    {r.mine && (
                      <span style={{ fontSize: 8.5, letterSpacing: "0.02em", color: r.mine.tone === "pos" ? C.pos : C.warn, display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 9 }}>{r.mine.tone === "pos" ? "◆" : "△"}</span>{r.mine.text}
                      </span>
                    )}
                  </div>
                  {/* Action — draft the play as a thesis */}
                  <div style={{ ...cell, justifyContent: "flex-end" }}>
                    {r.play.dir && (
                      <button onClick={() => draftPlay(r)} title="Structure this as a graded thesis" style={{
                        background: "#1a1a1e", border: `1px solid ${C.border}`, color: C.accent, fontFamily: MONO, fontSize: 11,
                        width: 26, height: 24, borderRadius: RADIUS.sm, cursor: "pointer", lineHeight: 1,
                      }}>→</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
