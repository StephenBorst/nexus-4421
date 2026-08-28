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
const LEAN_MIN = 0.00003; // |funding|/8h above which we show a faint directional lean (not a setup)

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
  play: { klass: "CONFLUENCE" | "FADE" | "TREND" | "LEAN" | null; dir: Dir | null; label: string; strong: boolean };
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
function derivePlay(s: MarketSignal): Row["play"] {
  if (s.confluence === "LONG" || s.confluence === "SHORT") {
    return { klass: "CONFLUENCE", dir: s.confluence, label: `Confluence ${s.confluence === "LONG" ? "long" : "short"}`, strong: true };
  }
  if (Math.abs(s.funding_rate_8h) >= CROWDED) {
    const dir: Dir = s.funding_rate_8h > 0 ? "SHORT" : "LONG";
    return { klass: "FADE", dir, label: `Fade ${dir === "LONG" ? "long" : "short"}`, strong: true };
  }
  if ((s.trend === "TREND_UP" || s.trend === "TREND_DOWN") && (s.trend_oi_pct ?? 0) >= 1) {
    const dir: Dir = s.trend === "TREND_UP" ? "LONG" : "SHORT";
    return { klass: "TREND", dir, label: `Ride ${dir === "LONG" ? "up" : "down"}`, strong: true };
  }
  // ── faint leans (informational, not a setup) ──
  if (Math.abs(s.funding_rate_8h) >= LEAN_MIN) {
    const dir: Dir = s.funding_rate_8h > 0 ? "SHORT" : "LONG";
    return { klass: "LEAN", dir, label: `leans ${dir === "LONG" ? "long" : "short"}`, strong: false };
  }
  if (s.trend === "TREND_UP" || s.trend === "TREND_DOWN") {
    const dir: Dir = s.trend === "TREND_UP" ? "LONG" : "SHORT";
    return { klass: "LEAN", dir, label: `${dir === "LONG" ? "up" : "down"}-trend, thin OI`, strong: false };
  }
  return { klass: null, dir: null, label: "—", strong: false };
}

// Actionability: confluence beats a crowded fade beats a confirmed trend, plus the raw
// funding magnitude as a tiebreak. Only the DEFAULT sort — the read itself isn't ranked.
function scoreOf(play: Row["play"], funding: number): number {
  const base = play.klass === "CONFLUENCE" ? 300 : play.klass === "FADE" ? 200 : play.klass === "TREND" ? 100 : play.klass === "LEAN" ? 10 : 0;
  return base + Math.min(99, Math.abs(funding) * 100000);
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
    const counterTrend = play.klass === "FADE" || play.klass === "CONFLUENCE";
    if (counterTrend && edge.alignClass === "AGAINST_TREND") return { tone: "pos", text: `your class · +${edge.alignAvgR}R counter-trend` };
    if (play.klass === "TREND" && edge.alignClass === "WITH_TREND") return { tone: "pos", text: `your class · +${edge.alignAvgR}R with trend` };
  }
  return null;
}

type SortMode = "actionable" | "confluence" | "funding" | "movers" | "mine";

export function DecisionBoard({ onSelectTab, trades, wallet }: {
  onSelectTab?: (tab: TabId) => void;
  trades?: Trade[];          // the user's closed trades — powers the personal edge lens
  wallet?: string | null;
}) {
  const isMobile = useIsMobile();
  const [signals, setSignals] = useState<MarketSignal[] | null>(null);
  const [tape, setTape] = useState<Record<string, { price: number; change: number }>>({});
  const [consensus, setConsensus] = useState<Consensus | null>(null);
  const [smart, setSmart] = useState<Record<string, Dir>>({});       // smart-money lean per coin
  const [catalyst, setCatalyst] = useState<Record<string, Dir>>({}); // catalyst lean per coin
  const [forecast, setForecast] = useState<Record<string, Dir>>({}); // forecaster lean per coin
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
  const records = useMemo(() => symbolRecords(trades ?? []), [trades]);
  const hasLens = !!(edge.side || edge.alignClass || Object.keys(records).length);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(`${AGENT_API}/signals`).then((r) => r.json()).then((j) => { if (alive) setSignals(Array.isArray(j?.signals) ? j.signals : []); }).catch(() => alive && setSignals([]));
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
        oiChange: s.oi_change_pct,
        trend: s.trend ?? null,
        trendMove: s.trend_move_pct ?? null,
        trendOi: s.trend_oi_pct ?? null,
        consensus: c ? { side: c.side, participants: c.participants } : null,
        play,
        lens,
        agree,
        // Confluence NUDGES actionability (more independent reads agree → look here first),
        // but only for real setups — a lean with agreement is still just a lean.
        score: scoreOf(play, s.funding_rate_8h) + (play.strong ? agree * 25 : 0),
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
  const draftPlay = (r: Row) => {
    if (!r.play.dir) return;
    const crowd = r.play.dir === "SHORT" ? "long" : "short";
    // Carry the FUSION into the plan: name the independent lenses that confirm this play so
    // the drafted thesis records WHY it was a confluent read (the loop stays explainable).
    const lensName: Record<string, string> = { callers: "graded callers", smart: "smart money", catalyst: "catalysts", forecast: "forecasters" };
    const agreeing = (["callers", "smart", "catalyst", "forecast"] as const).filter((k) => r.lens[k] === r.play.dir);
    const confNote = r.agree >= 2 ? ` ${r.agree} independent reads confirm this: ${agreeing.map((k) => lensName[k]).join(", ")}.` : "";
    const draft = {
      symbol: r.sym,
      direction: r.play.dir,
      // Prefill the entry from the live mark so the read arrives one field closer to armed —
      // the trader still sets stop + target (where the chart tells them), then deploys to the agent.
      entryPrice: r.price != null ? String(r.price) : "",
      catalyst: `${r.play.label} · funding ${(r.funding * 100).toFixed(3)}%/8h`,
      notes: (r.play.klass === "CONFLUENCE"
        ? `Funding and open interest agree — the crowd is offside ${crowd}. Set your stop and target; it grades from public price.`
        : `${r.play.label} — the mechanical read, not a promise. Add your levels; it grades first-touch vs the tape.`) + confNote,
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
        Funding, open interest and trend are <b style={{ color: C.text.bright }}>public facts</b>. <b style={{ color: C.text.bright }}>The play</b> is the mechanical read — what the rules say, not a promise — and it gets <b style={{ color: C.text.bright }}>graded from the tape</b> afterward, same as every call. No score to trust; a record to verify.
        {" "}<b style={{ color: C.text.bright }}>Confluence</b> shows four INDEPENDENT reads — <span style={{ color: C.text.muted }}>callers · smart money · catalysts · forecasters</span> — and how many <b style={{ color: C.text.bright }}>agree with the play</b> (<span style={{ color: C.accent }}>◆</span> marks where separate signals converge). Agreement is a reason to look, still graded after.
        {hasLens && <> Each play is also matched against <b style={{ color: C.pos }}>your own graded edge</b> — <span style={{ color: C.pos }}>◆ your side/class</span> vs <span style={{ color: C.warn }}>△ off your edge</span>.</>}
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: C.text.faint, alignSelf: "center", letterSpacing: "0.06em" }}>SORT</span>
        {hasLens && sortBtn("mine", "◆ MINE")}
        {sortBtn("actionable", "ACTIONABLE")}
        {sortBtn("confluence", "◆ CONFLUENCE")}
        {sortBtn("funding", "FUNDING")}
        {sortBtn("movers", "MOVERS")}
      </div>

      {!signals ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint, padding: "18px 4px" }}>loading the board…</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 720 }}>
            {/* header row */}
            <div style={{ display: "grid", gridTemplateColumns: cols, gap: gridGap, padding: headPad, borderBottom: `1px solid ${C.border}` }}>
              <div style={head}>Market</div>
              <div style={head}>Last / 24h</div>
              <div style={head}>Funding /8h</div>
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
              const pc = dirColor(r.play.dir);
              return (
                <div key={r.sym} style={{ display: "grid", gridTemplateColumns: cols, gap: gridGap, padding: rowPad, borderBottom: `1px solid ${C.surfaceAlt}`, alignItems: "center", borderLeft: confluent ? `3px solid ${pc}` : "3px solid transparent", background: confluent ? `${pc}0c` : undefined }}>
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
                  {/* CONFLUENCE — the four INDEPENDENT reads (callers · smart · catalyst ·
                      forecast), each a verifiable public fact, + how many confirm the play. */}
                  <div style={{ ...cell, gap: 5, flexWrap: "wrap" }}>
                    {([
                      { k: "Ca", v: r.lens.callers, t: `Graded callers${r.consensus ? ` (${r.consensus.participants})` : ""}` },
                      { k: "Sm", v: r.lens.smart, t: "Smart money" },
                      { k: "Ct", v: r.lens.catalyst, t: "Catalysts" },
                      { k: "Fc", v: r.lens.forecast, t: "Forecasters" },
                    ] as { k: string; v: Dir | null; t: string }[]).map(({ k, v, t }) => (
                      <span key={k} title={`${t}: ${v ? v.toLowerCase() : "no read"}`} style={{
                        fontFamily: MONO, fontSize: 9, fontWeight: 700, whiteSpace: "nowrap",
                        color: v === "LONG" ? C.pos : v === "SHORT" ? C.neg : C.text.faint, opacity: v ? 1 : 0.42,
                      }}>{k}{v === "LONG" ? "↑" : v === "SHORT" ? "↓" : "·"}</span>
                    ))}
                    {r.play.dir && r.agree >= 2 && (
                      <span title={`${r.agree} of 4 independent reads confirm the play`} style={{
                        fontFamily: MONO, fontSize: 8, fontWeight: 700, color: dirColor(r.play.dir),
                        border: `1px solid ${dirColor(r.play.dir)}66`, borderRadius: 3, padding: "0 4px", lineHeight: 1.5,
                      }}>◆{r.agree}</span>
                    )}
                  </div>
                  {/* THE PLAY — the mechanical read (strong = a real setup, bright; lean =
                      faint tilt, informational), + your personal edge lens below it */}
                  <div style={{ ...cell, flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                    {r.play.strong
                      ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: dirColor(r.play.dir), flexShrink: 0 }} />
                          <span style={{ color: dirColor(r.play.dir), fontSize: 11, fontWeight: 600 }}>{r.play.label}</span>
                          {r.play.klass === "CONFLUENCE" && <span style={{ fontSize: 8, color: C.text.faint, border: `1px solid ${C.border}`, borderRadius: 3, padding: "0 4px" }}>◆</span>}
                        </span>
                      : r.play.klass === "LEAN"
                      ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: C.text.faint }}>
                          <span style={{ color: r.play.dir === "LONG" ? C.pos : C.neg, opacity: 0.55 }}>{r.play.dir === "LONG" ? "↑" : "↓"}</span>{r.play.label}
                        </span>
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
                    {r.play.strong && r.play.dir && (
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
