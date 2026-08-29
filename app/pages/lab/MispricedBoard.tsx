// ── THE MISPRICED BOARD — price every market, surface the gap ─────────────────
// Borrowed framing (Quotient signal.quotient.social): don't just list calls — price
// every market and surface where it diverges from FAIR, ranked so the sort order IS
// the signal. On a perp there's no oracle fair value, but the FUNDING rate is the
// crowd's mispricing made explicit: persistently positive funding = the book is
// lopsided long = a mean-revert (fade) edge to the SHORT side, and vice-versa.
//
// Design: complex intelligence made SIMPLE + graspable + executable.
//  · SCAN — the few genuinely stretched markets are Signal Cards (the annualized edge
//    is the hero number); everything priced fair collapses to a quiet rail below.
//  · UNDERSTAND — open one → a detail view (big price, plain-English stance, a two-pole
//    positioning read, the sharp callers' second opinion).
//  · EXECUTE — one tap drafts the fade into the Thesis Engine.
// Every card carries a plain-language read so a first-timer gets it, while the exact
// numbers stay for power users. Tier-2 (queued) lights up a funding-history story-line
// + a reversion proof stat on the detail view for markets with enough history.
//
// Two independent fail-soft fetches: /intel/mispriced (fast, KV-cached market data)
// and /theses/consensus (the caller lean), merged by coin here on the client.
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "@orderly.network/hooks";
import { C, MONO, UI, RADIUS } from "@/config/theme";
import { AGENT_API } from "./agentTypes";
import { FADE_FUNDING_FLOOR_PCT_YR } from "./briefing";
import { useIsMobile } from "./useIsMobile";
import { SectionHeader } from "./components";
import { Simulate } from "./Simulate";
import { ProjectionBand } from "@/components/ProjectionBand";

type EdgeQuality = { tier: "PROVEN" | "TRAP" | "MIXED" | "UNPROVEN"; revertedPct: number | null; samples: number };
// The SYNTHESIS input — where the graded top Orderly traders (the sharp capital) actually
// sit on this market, + the long/short split. Funding = the crowd (fade it); smartMoney =
// the real money (ride with it). When they disagree, that tension is the read.
type SmartMoney = { side: "LONG" | "SHORT"; count: number; long: number | null; short: number | null };
type Market = {
  symbol: string; coin: string; markPrice: number;
  funding8hPct: number; fundingAnnualPct: number; oiUsd: number;
  change24hPct: number | null; direction: "LONG" | "SHORT" | "NONE";
  edge: number; status: "MISPRICED" | "PRICED_FAIR";
  reversion?: { revertedPct: number; avgReversionPct: number; samples: number; horizonDays: number } | null;
  edgeQuality?: EdgeQuality; // flagged markets: has fading this HISTORICALLY paid?
  smartMoney?: SmartMoney | null; // sharp-capital consensus (merged server-side into the board)
};
type BoardResp = { asOf?: string; scanned?: number; mispricedCount?: number; markets?: Market[] };
type Lean = { side: "LONG" | "SHORT" | "SPLIT"; lean: number; longCount: number; shortCount: number; participants: number };
type ConsensusResp = { consensus?: Record<string, Lean> };
type Reversion = { samples: number; horizonDays: number; avgReversionPct: number; medianReversionPct: number; revertedPct: number; crowd: "long" | "short" };
type PosResp = { coin: string; points: { t: number; f: number }[]; reversion: Reversion | null };

const fmtUsd = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;
const fmtPrice = (n: number) => n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toPrecision(4);

const stanceLabel = (dir: string) => dir === "SHORT" ? "Crowd over-long" : dir === "LONG" ? "Crowd over-short" : "Balanced";

// Plain-English translation — the readability layer. A first-timer reads this; a pro
// reads the numbers above it. Both are true, neither is dumbed down. verdict === "WATCH"
// tells the truth Grok flagged: funding can be HIGH in absolute terms yet not STRETCHED
// vs its own range — that's a watch, not a fade.
const plainRead = (m: Market, verdict?: "FADE" | "WATCH" | "NONE", weakEdge?: boolean, tooSmall?: boolean) => {
  const pct = Math.abs(m.fundingAnnualPct);
  const crowd = m.direction === "SHORT" ? "long" : "short";
  // Poked out of its range but the annualized cost is trivial — the crowd is barely paying to
  // hold, so there's no economically meaningful fade. Checked first: magnitude gates the badge.
  if (tooSmall && m.direction !== "NONE")
    return `Funding on ${m.coin} is only ${m.fundingAnnualPct >= 0 ? "+" : ""}${m.fundingAnnualPct}%/yr — even poking out of its recent range, the crowd is barely paying to hold ${crowd}, so there's no meaningful fade to take. Watch for a bigger stretch.`;
  // Stretched, but the base rate says fading it has bled — the honest "watch, don't chase"
  // read (checked BEFORE the plain WATCH branch, which would wrongly claim it's un-stretched).
  if (weakEdge && m.direction !== "NONE")
    return `Funding on ${m.coin} is stretched (the crowd is one-sided ${crowd}), but the last times it ran this hot the fade mostly DIDN'T pay — historically it has underperformed here. Treat it as a watch; draft only on your own read, not the fade.`;
  if (verdict === "WATCH" && m.direction !== "NONE")
    return `Funding on ${m.coin} is elevated (${m.fundingAnnualPct >= 0 ? "+" : ""}${m.fundingAnnualPct}%/yr) but sitting within its own typical range — the crowd isn't stretched right now, so there's no clean fade yet. Watch for it to pierce out of the band.`;
  if (m.direction === "SHORT") return `Traders are paying ${pct}%/yr to stay long ${m.coin} — the crowd is stretched one-sided. That crowding usually unwinds, so the edge is to lean short.`;
  if (m.direction === "LONG") return `Shorts are paying ${pct}%/yr to stay short ${m.coin} — the crowd is stretched one-sided the other way, so the edge is to lean long.`;
  return `${m.coin} funding is close to balanced — no clear crowd to fade right now.`;
};

// ── THE HONEST EDGE TEST (Grok) — funding is a FADE only when it's stretched vs its OWN
// recent range (pierces p25–p75), not merely high in absolute terms. Needs enough history
// to judge; null = can't confirm a stretch → the ticket treats it as WATCH, never FADE.
function fundingStretched(points?: { f: number }[]): boolean | null {
  const fs = (points || []).map((p) => p.f).filter((f) => Number.isFinite(f));
  if (fs.length < 8) return null;
  const srt = [...fs].sort((a, b) => a - b);
  const q = (p: number) => srt[Math.min(srt.length - 1, Math.max(0, Math.round(p * (srt.length - 1))))];
  const lf = fs[fs.length - 1];
  return lf > q(0.75) || lf < q(0.25);
}

// Direction chips are POSITIONING, not P&L — kept monochrome per the design law
// (green = profit only, red = loss only). Only the 24h price move uses pos/neg.
const dirChip = (dir: string): React.CSSProperties => ({
  fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
  padding: "2px 6px", borderRadius: RADIUS.sm, whiteSpace: "nowrap",
  color: dir === "NONE" || dir === "SPLIT" ? C.text.faint : C.text.bright,
  background: C.surface, border: `1px solid ${C.border}`,
});

// The positioning read: a bar whose fill leans toward the crowded side (from a
// balanced center), with both fade poles labeled. Static in tier 1; tier 2 threads a
// funding-history line through it. crowd long → fill right (fade short) & vice-versa.
function PositionBar({ m, maxEdge, big }: { m: Market; maxEdge: number; big?: boolean }) {
  const pct = Math.min(46, (m.edge / Math.max(1, maxEdge)) * 46);
  const crowdLong = m.direction === "SHORT";  // paying to be long → fade short
  const crowdShort = m.direction === "LONG";
  return (
    <div>
      <div style={{ position: "relative", height: big ? 8 : 6, background: C.inset, border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: "50%", top: -1, bottom: -1, width: 1, background: C.borderStrong }} />
        {m.direction !== "NONE" && (
          <div style={{ position: "absolute", top: 0, bottom: 0, background: C.accent, opacity: 0.9,
            ...(crowdLong ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }) }} />
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: big ? 8 : 6, fontFamily: MONO, fontSize: big ? 10 : 8.5, letterSpacing: "0.05em" }}>
        <span style={{ color: crowdShort ? C.text.bright : C.text.faint }}>◄ FADE LONG</span>
        <span style={{ color: crowdLong ? C.text.bright : C.text.faint }}>FADE SHORT ►</span>
      </div>
    </div>
  );
}

// ── THE SYNTH CHART — one premium, time-aligned frame ─────────────────────────
// PRICE (top) over FUNDING (bottom), sharing an x-axis + real date ticks, with
// Quotient-style right-edge value boxes and the SMART-MONEY marker riding the live
// price. The funding band is ADAPTIVE — the window's own typical range (p25–p75) — so
// the current reading visibly PIERCES OUT of "typical" and the panel is never the dead
// gray space it used to be. Renders on EVERY market: price is the always-available spine
// (Orderly candles), funding layers in from recorded OR public history. Uniform scaling
// (no preserveAspectRatio distortion) keeps labels crisp; fail-soft to the two-pole gauge
// only if there is truly no price AND no funding.
function SynthChart({ points, price, direction, smartMoney, markPrice, fundingAnnualPct, maxEdge, m }: {
  points: { t: number; f: number }[]; price: { t: number; c: number }[]; direction: string;
  smartMoney?: SmartMoney | null; markPrice: number; fundingAnnualPct: number; maxEdge: number; m: Market;
}) {
  const pc = (price || []).filter((p) => Number.isFinite(p.c) && p.c > 0);
  const fpts = (points || []).filter((p) => Number.isFinite(p.f) && Number.isFinite(p.t));
  const hasPrice = pc.length >= 2, hasFunding = fpts.length >= 2;
  if (!hasPrice && !hasFunding) return <PositionBar m={m} maxEdge={maxEdge} big />;

  const VB_W = 440, padL = 3, gutterR = 66, plotW = VB_W - padL - gutterR;
  const priceTop = 13, priceH = 116, priceBot = priceTop + priceH;
  const dateY = priceBot + 15;
  const fundTop = priceBot + 32, fundH = 62, fundBot = fundTop + fundH, fundMid = fundTop + fundH / 2;
  const VB_H = hasFunding ? fundBot + 6 : priceBot + 20;

  // shared time domain across both series (true time alignment, not index)
  const times: number[] = [];
  if (hasPrice) times.push(pc[0].t, pc[pc.length - 1].t);
  if (hasFunding) times.push(fpts[0].t, fpts[fpts.length - 1].t);
  const t0 = Math.min(...times), t1 = Math.max(...times), tspan = (t1 - t0) || 1;
  const X = (t: number) => padL + ((t - t0) / tspan) * plotW;

  const gx = VB_W - gutterR + 5, boxW = gutterR - 8;

  // PRICE geometry
  let priceLine = "", priceArea = "", priceUp = false, changePct: number | null = null, lastPx = markPrice, lastPy = 0, lastPxX = plotW;
  if (hasPrice) {
    const cs = pc.map((p) => p.c);
    const lo = Math.min(...cs), hi = Math.max(...cs), sp = (hi - lo) || 1;
    const py = (c: number) => priceBot - 8 - ((c - lo) / sp) * (priceH - 16);
    const pts = pc.map((p) => [X(p.t), py(p.c)] as const);
    priceLine = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    priceArea = `${priceLine} L${pts[pts.length - 1][0].toFixed(1)},${priceBot} L${pts[0][0].toFixed(1)},${priceBot} Z`;
    changePct = Math.round(((cs[cs.length - 1] - cs[0]) / cs[0]) * 1000) / 10;
    priceUp = changePct >= 0;
    lastPx = pc[pc.length - 1].c; lastPy = py(lastPx); lastPxX = pts[pts.length - 1][0];
  }

  // FUNDING geometry — adaptive band = the window's own p25–p75
  let fundLine = "", bandTop = fundMid, bandH = 0, zeroY = fundMid, lastFx = plotW, lastFy = fundMid, pierced = false;
  if (hasFunding) {
    const fs = fpts.map((p) => p.f);
    const srt = [...fs].sort((a, b) => a - b);
    const q = (p: number) => srt[Math.min(srt.length - 1, Math.max(0, Math.round(p * (srt.length - 1))))];
    const p25 = q(0.25), p75 = q(0.75);
    const refF = Math.max(Math.abs(Math.min(...fs)), Math.abs(Math.max(...fs)), 1e-9) * 1.08;
    const fy = (f: number) => fundMid - Math.max(-1, Math.min(1, f / refF)) * (fundH / 2 - 8);
    const xy = fpts.map((p) => [X(p.t), fy(p.f)] as const);
    fundLine = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const b0 = fy(p75), b1 = fy(p25);
    bandTop = Math.min(b0, b1); bandH = Math.abs(b1 - b0) || 1; zeroY = fy(0);
    lastFx = xy[xy.length - 1][0]; lastFy = xy[xy.length - 1][1];
    const lf = fs[fs.length - 1]; pierced = lf > p75 || lf < p25;
  }

  // date ticks (~4, evenly spaced across the shared window)
  const NT = 4;
  const ticks = Array.from({ length: NT }, (_, i) => {
    const tt = t0 + (tspan * i) / (NT - 1);
    const anchor: "start" | "middle" | "end" = i === 0 ? "start" : i === NT - 1 ? "end" : "middle";
    return { x: X(tt), label: new Date(tt).toLocaleDateString(undefined, { month: "short", day: "numeric" }), anchor };
  });

  const smSide = smartMoney?.side;
  const MF = "ui-monospace,monospace";
  // The caption + fade-accent highlight must follow the SAME floor as the verdict (Grok):
  // a pierce on a trivial band is not "stretched". Pierced AND economically large → stretched.
  const stretchedEnough = pierced && Math.abs(fundingAnnualPct) >= FADE_FUNDING_FLOOR_PCT_YR;
  return (
    <div>
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} style={{ display: "block", width: "100%", height: "auto" }} role="img" aria-label="Price over funding, time-aligned, with the smart-money marker on the live price.">
        {/* ── PRICE PANEL ── */}
        {hasPrice && <>
          <text x={padL} y={priceTop - 3} fill={C.text.faint} fontFamily={MF} fontSize="7.5" letterSpacing="1.4">PRICE</text>
          {changePct != null && <text x={padL + 34} y={priceTop - 3} fill={priceUp ? C.pos : C.neg} fontFamily={MF} fontSize="7.5">{priceUp ? "+" : ""}{changePct}%</text>}
          <path d={priceArea} fill={priceUp ? C.pos : C.neg} opacity="0.07" />
          <polyline points={priceLine} fill="none" stroke={priceUp ? C.pos : C.neg} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" opacity="0.92" />
          {/* current price value box (Quotient-style right rail) */}
          <line x1={lastPxX} y1={lastPy} x2={VB_W - gutterR} y2={lastPy} stroke={C.borderStrong} strokeWidth="0.5" strokeDasharray="2 2" />
          <rect x={VB_W - gutterR} y={lastPy - 8} width={boxW} height={16} rx="2" fill={C.surface} stroke={C.borderStrong} />
          <text x={gx} y={lastPy + 3.4} fill={C.text.bright} fontFamily={MF} fontSize="9" fontWeight="700">${fmtPrice(lastPx)}</text>
          {/* SMART-MONEY marker on the live price — positioning, so monochrome accent (not P&L color) */}
          {smSide && <>
            <circle cx={lastPxX} cy={lastPy} r="5.6" fill="none" stroke={C.accent} strokeWidth="1.4" />
            <circle cx={lastPxX} cy={lastPy} r="2.1" fill={C.accent} />
            <text x={Math.max(padL + 2, lastPxX - 9)} y={lastPy - 9} textAnchor="end" fill={C.accent} fontFamily={MF} fontSize="7.5" fontWeight="700">SMART $ {smSide === "LONG" ? "▲" : "▼"}</text>
          </>}
        </>}

        {/* ── DATE AXIS (shared) ── */}
        <line x1={padL} y1={dateY - 9} x2={plotW} y2={dateY - 9} stroke={C.border} strokeWidth="0.75" />
        {ticks.map((tk, i) => (
          <text key={i} x={Math.max(padL, Math.min(plotW, tk.x))} y={dateY} textAnchor={tk.anchor} fill={C.text.faint} fontFamily={MF} fontSize="7.5">{tk.label}</text>
        ))}

        {/* ── FUNDING PANEL ── */}
        {hasFunding && <>
          <text x={padL} y={fundTop - 4} fill={C.text.faint} fontFamily={MF} fontSize="7.5" letterSpacing="1.4">FUNDING</text>
          <text x={padL + 48} y={fundTop - 4} fill={direction === "SHORT" ? C.text.muted : C.text.faint} fontFamily={MF} fontSize="7">▲ fade short · crowd long</text>
          {/* adaptive TYPICAL band (p25–p75) — the current reading pierces out of it */}
          <rect x={padL} y={bandTop} width={plotW} height={bandH} fill={C.text.bright} opacity="0.05" />
          <text x={plotW - 2} y={bandTop - 2} textAnchor="end" fill={C.text.faint} fontFamily={MF} fontSize="6.5" letterSpacing="0.5">TYPICAL</text>
          <line x1={padL} y1={zeroY} x2={plotW} y2={zeroY} stroke={C.borderStrong} strokeWidth="0.75" strokeDasharray="3 4" />
          <text x={padL + 2} y={zeroY - 3} fill={C.text.faint} fontFamily={MF} fontSize="6.5" letterSpacing="0.5">BALANCED</text>
          <polyline points={fundLine} fill="none" stroke={C.text.bright} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={lastFx} cy={lastFy} r="5.6" fill={C.accent} opacity="0.14" />
          <circle cx={lastFx} cy={lastFy} r="2.6" fill={C.accent} />
          {/* current funding value box — highlighted when pierced (stretched) */}
          <line x1={lastFx} y1={lastFy} x2={VB_W - gutterR} y2={lastFy} stroke={stretchedEnough ? C.accent : C.borderStrong} strokeWidth="0.5" strokeDasharray="2 2" />
          <rect x={VB_W - gutterR} y={lastFy - 8} width={boxW} height={16} rx="2" fill={C.surface} stroke={stretchedEnough ? C.accent : C.borderStrong} />
          <text x={gx} y={lastFy + 3.4} fill={stretchedEnough ? C.accent : C.text.bright} fontFamily={MF} fontSize="8.5" fontWeight="700">{fundingAnnualPct >= 0 ? "+" : ""}{fundingAnnualPct}%</text>
          <text x={padL + 48} y={fundBot - 1} fill={direction === "LONG" ? C.text.muted : C.text.faint} fontFamily={MF} fontSize="7">▼ fade long · crowd short</text>
        </>}
      </svg>
      {/* the read the chart is making, one line */}
      <div style={{ fontFamily: MONO, fontSize: 8.5, color: C.text.faint, marginTop: 8, lineHeight: 1.5 }}>
        {hasFunding
          ? (stretchedEnough
              ? "Funding has pierced its typical range — the crowd is stretched. Watch whether price gives it back."
              : pierced
              ? `Funding poked out of its range, but at ${fundingAnnualPct >= 0 ? "+" : ""}${fundingAnnualPct}%/yr the cost to hold is trivial — not stretched enough to fade.`
              : "Funding is within its typical range — no crowd extreme to fade right now.")
          : "Price over the window. Funding history is still accumulating for this market."}
      </div>
    </div>
  );
}

// The fused verdict — funding (crowd) vs smart money (real capital), stated plainly and
// EXPLAINABLY (never a black-box score). Aligned = the sharp money is fading with you;
// divergence = it's riding with the crowd, so the fade isn't clean.
function synthVerdict(m: Market): { tone: "aligned" | "conflict"; text: string } | null {
  const sm = m.smartMoney;
  if (m.direction === "NONE" || !sm || !sm.side) return null;
  if (sm.side === m.direction)
    return { tone: "aligned", text: `The crowd is offside and the sharp money is already positioned ${sm.side.toLowerCase()} — the smart money is fading it with you. Higher-conviction fade.` };
  return { tone: "conflict", text: `The crowd is offside, but the sharp money is riding ${sm.side.toLowerCase()} WITH them. Not a clean fade — the real money is on the crowd's side here.` };
}

// The reversion proof stat (tier 2), phrased plainly — and HONESTLY when the fade
// historically failed (positive = price gave back / reverted; negative = it kept going).
function reversionSentence(coin: string, r: Reversion): string {
  const mag = Math.abs(r.avgReversionPct);
  const d = `${r.horizonDays} day${r.horizonDays === 1 ? "" : "s"}`;
  if (r.avgReversionPct > 0)
    return `The last ${r.samples} times ${coin} funding ran this hot, price gave back an average of ${mag}% over ${d} — it reverted ${r.revertedPct}% of the time.`;
  return `Careful: the last ${r.samples} times ${coin} funding ran this hot, price kept going the crowd's way by ${mag}% on average over ${d} — the fade only worked ${r.revertedPct}% of the time.`;
}

// Edge quality — pairs the raw funding signal with its TRACK RECORD (has fading this
// historically paid?). The honest intelligence: most tools stop at the number; this
// says when the fade has edge (PROVEN) and — crucially — when it's a TRAP (funding
// stretched but fading it has LOST). Monochrome/amber per the design law.
function EdgeQualityChip({ q }: { q?: EdgeQuality }) {
  if (!q) return null;
  const map: Record<string, { color: string; text: string }> = {
    PROVEN:   { color: C.accent,     text: `◆ Fade has paid here — reverted ${q.revertedPct}%` },
    TRAP:     { color: C.warn,       text: `⚠ Trap — fading this has FAILED (reverted only ${q.revertedPct}%)` },
    MIXED:    { color: C.text.fog,   text: `Coin-flip so far — reverted ${q.revertedPct}%` },
    UNPROVEN: { color: C.text.faint, text: `Unproven — not enough funding history yet` },
  };
  const s = map[q.tier];
  if (!s) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 9, fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.03em", color: s.color, lineHeight: 1.35 }}>
      {s.text}{q.samples > 0 && q.tier !== "UNPROVEN" ? <span style={{ color: C.text.faint, fontWeight: 400 }}>· {q.samples}×</span> : null}
    </div>
  );
}

// The sharp callers' second opinion (merit-weighted lean), phrased plainly.
function Callers({ m, lean }: { m: Market; lean?: Lean }) {
  if (!lean) return <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.text.faint }}>— no one's called it yet</span>;
  const diverges = lean.side !== "SPLIT" && m.direction !== "NONE" && lean.side !== m.direction;
  return (
    <>
      <span style={dirChip(lean.side)}>{lean.side === "SPLIT" ? "SPLIT" : `betting ${lean.side}`}</span>
      <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.text.faint }}>{lean.participants}</span>
      {diverges
        ? <span title="The sharp callers disagree with the fade" style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9, fontWeight: 700, color: C.warn }}>⚡ they disagree</span>
        : lean.side !== "SPLIT" && <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9, color: C.text.muted }}>✓ same side as the fade</span>}
    </>
  );
}

// Compact board-card synthesis hint: does the sharp money side WITH the fade or against?
// The one-glance version of THE READ, so the scan itself surfaces the synthesis.
function SmartMoneyChip({ m }: { m: Market }) {
  const sm = m.smartMoney;
  if (!sm?.side || m.direction === "NONE") return null;
  const aligned = sm.side === m.direction;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.03em", color: aligned ? C.accent : C.warn }}>
      {aligned ? "◆ Smart money is fading with you" : "⚡ Smart money is riding with the crowd"}
      <span style={{ color: C.text.faint, fontWeight: 400 }}>· {sm.count} {sm.side}</span>
    </div>
  );
}

// One row of THE READ — a lens (crowd / smart $ / callers), its value, and whether it
// sides WITH the fade or AGAINST it. Kept monochrome+amber per the design law (the tag
// is emphasis/caution, not P&L).
function LensRow({ label, value, tag, tagTone, first }: { label: string; value: React.ReactNode; tag?: string; tagTone?: string; first?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: first ? "none" : `1px solid ${C.border}`, fontFamily: MONO, fontSize: 11 }}>
      <span style={{ width: 58, flexShrink: 0, color: C.text.faint, fontSize: 8.5, letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</span>
      <span style={{ color: C.text.bright, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
      {tag && <span style={{ marginLeft: "auto", flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: "0.04em", color: tagTone || C.text.muted }}>{tag}</span>}
    </div>
  );
}

// THE READ — the complete synthesis, three independent lenses answering one question:
// CROWD (funding, fade it) · SMART $ (sharp capital, ride it) · CALLERS (graded second
// opinion). Each shows which side it takes vs the fade; the verdict fuses crowd + smart
// money. Explainable end to end — the inputs stay visible, the verdict just reads them.
function SynthesisRead({ m, lean, active }: { m: Market; lean?: Lean; active: boolean }) {
  if (m.direction === "NONE") return null;
  const fadeDir = m.direction; // the fade side (opposite the crowd)
  const crowdSide = fadeDir === "SHORT" ? "long" : "short";
  const sm = m.smartMoney;
  const v = active ? synthVerdict(m) : null; // the fade verdict exists only when there IS a fade
  const withTag = "✓ WITH THE FADE", againstTag = "⚡ AGAINST";
  const callerSides = lean && lean.side !== "SPLIT";
  // n=1 caller is CONTEXT, not confirmation (Grok) — need ≥2 to tag it with/against the fade.
  const callerConfirms = !!lean && lean.side !== "SPLIT" && lean.participants >= 2;
  return (
    <div style={{ marginTop: 14, border: `1px solid ${C.border}`, borderRadius: RADIUS.md, padding: "9px 13px 11px", background: C.surfaceAlt }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 1 }}>
        <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: C.text.muted }}>◆ The read · three lenses</span>
        {!active && <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 8.5, color: C.text.faint }}>current positioning · no fade yet</span>}
      </div>
      <LensRow first label="Crowd" value={<>{m.fundingAnnualPct >= 0 ? "+" : ""}{m.fundingAnnualPct}%/yr · paying to be {crowdSide}</>} tag={active ? `FADE ${fadeDir}` : "within range"} tagTone={active ? C.text.bright : C.text.faint} />
      <LensRow label="Smart $"
        value={sm?.side ? `${sm.count} sharp${sm.count === 1 ? "" : "s"} ${sm.side}${sm.long != null && sm.short != null ? ` · ${sm.long}L/${sm.short}S` : ""}` : "no read"}
        tag={active && sm?.side ? (sm.side === fadeDir ? withTag : againstTag) : undefined}
        tagTone={sm?.side ? (sm.side === fadeDir ? C.accent : C.warn) : undefined} />
      <LensRow label="Callers"
        value={callerSides ? `betting ${lean!.side} · ${lean!.participants}${lean!.participants < 2 ? " (thin)" : ""}` : lean ? `split · ${lean.participants}` : "no one's called it"}
        tag={active && callerConfirms ? (lean!.side === fadeDir ? withTag : againstTag) : undefined}
        tagTone={callerConfirms ? (lean!.side === fadeDir ? C.accent : C.warn) : undefined} />
      {v && (
        <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${C.border}`, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 12, lineHeight: 1.2, color: v.tone === "aligned" ? C.accent : C.warn }}>{v.tone === "aligned" ? "◆" : "⚠"}</span>
          <span style={{ fontFamily: UI, fontSize: 12.5, lineHeight: 1.5, color: v.tone === "aligned" ? C.text.bright : C.text.fog }}>{v.text}</span>
        </div>
      )}
    </div>
  );
}

export function MispricedBoard() {
  const isMobile = useIsMobile();
  const { state: acct } = useAccount();
  const wallet = (acct as { address?: string })?.address?.toLowerCase() ?? null;
  const [board, setBoard] = useState<BoardResp | null>(null);
  const [lean, setLean] = useState<Record<string, Lean>>({});
  const [err, setErr] = useState(false);
  const [openCoin, setOpenCoin] = useState<string | null>(null);
  const [pos, setPos] = useState<PosResp | null>(null);
  const [price, setPrice] = useState<{ t: number; c: number }[] | null>(null);

  // On opening a market, pull its funding history (story-line) + reversion stat, AND the
  // price over the same window — so the SynthChart shows the fade thesis on EVERY market.
  // Price is the always-available spine (fetched even when funding history is sparse, over
  // the funding window if present else the trailing 30d). Fail-soft throughout.
  useEffect(() => {
    if (!openCoin) { setPos(null); setPrice(null); return; }
    let live = true; setPos(null); setPrice(null);
    fetch(`${AGENT_API}/intel/positioning/${openCoin}`).then((r) => r.json())
      .then(async (d: PosResp) => {
        if (!live) return;
        setPos(d);
        const toSec = (t: number) => (t > 1e12 ? Math.floor(t / 1000) : Math.floor(t));
        let from: number, to: number;
        if (d?.points && d.points.length >= 2) { from = toSec(d.points[0].t); to = toSec(d.points[d.points.length - 1].t); }
        else { to = Math.floor(Date.now() / 1000); from = to - 30 * 86400; }
        const pr = await fetch(`https://api-evm.orderly.org/tv/history?symbol=PERP_${openCoin}_USDC&resolution=60&from=${from}&to=${to}`)
          .then((r) => r.json()).catch(() => null);
        if (live && pr && pr.s === "ok" && Array.isArray(pr.t) && Array.isArray(pr.c)) {
          setPrice(pr.t.map((t: number, i: number) => ({ t: t * 1000, c: Number(pr.c[i]) })).filter((p: { c: number }) => p.c > 0));
        }
      })
      .catch(() => { if (live) setPos({ coin: openCoin, points: [], reversion: null }); });
    return () => { live = false; };
  }, [openCoin]);

  useEffect(() => {
    let live = true;
    const load = () => {
      fetch(`${AGENT_API}/intel/mispriced`).then((r) => r.json())
        .then((d: BoardResp) => { if (live) setBoard(d || {}); })
        .catch(() => { if (live) { setBoard({ markets: [] }); setErr(true); } });
      fetch(`${AGENT_API}/theses/consensus`).then((r) => r.json())
        .then((d: ConsensusResp) => { if (live) setLean(d?.consensus || {}); })
        .catch(() => { /* fail-soft — board still renders */ });
    };
    load();
    const t = setInterval(load, 90_000); // funding moves slowly; the server caches 180s
    return () => { live = false; clearInterval(t); };
  }, []);

  const markets = board?.markets ?? null;
  const maxEdge = useMemo(() => Math.max(1, ...(markets || []).map((m) => m.edge)), [markets]);
  const mispriced = useMemo(() => (markets || []).filter((m) => m.status === "MISPRICED"), [markets]);
  const fair = useMemo(() => (markets || []).filter((m) => m.status !== "MISPRICED"), [markets]);
  const scanned = board?.scanned ?? 0;
  const mispricedCount = board?.mispricedCount ?? 0;

  // Weave OBSERVE → PLAN: a stretched market is a thesis waiting to be written. Draft
  // the fade (symbol + direction + a funding catalyst) into the Thesis Engine for the
  // user to add levels + save. Reuses the assistant's draft contract (nexus_thesis_draft
  // + the tab/draft events the Lab already listens for) — no order, no auth.
  // ── FROZEN thesis draft (Grok — the last hole in the loop) ───────────────────
  // Draft must emit a REAL thesis, not a vibe short: side from the verdict (the caller only
  // fires this on FADE — WATCH never drafts), entry = live mark at click, stop = 1.2× ATR (the
  // SAME contract as the harness's gradeEventR — 1h ATR(24) when candles exist, else a labeled
  // ATR_proxy), TP = +1.5R, 7-day time-stop, why = stretched funding + crowd stance + smart $.
  // ⚠️ NOT sized off funding %/yr; NOT tightened because the fade "looks clean." Same gradeCall
  // fields (entry/stop/tp/direction) so Sept-14 doesn't grow a third object.
  const draftFade = async (m: Market) => {
    if (m.direction === "NONE") return;
    const isShort = m.direction === "SHORT";
    const crowd = isShort ? "long" : "short";
    let entry = m.markPrice, atr = 0, atrSource = "ATR_proxy (2% of price)";
    try {
      const now = Math.floor(Date.now() / 1000);
      const j = await fetch(`https://api-evm.orderly.org/tv/history?symbol=PERP_${m.coin}_USDC&resolution=60&from=${now - 90 * 3600}&to=${now}`).then((r) => r.json());
      if (j?.s === "ok" && Array.isArray(j.c) && j.c.length >= 8) {
        const n = j.c.length;
        if (Number(j.c[n - 1]) > 0) entry = Number(j.c[n - 1]); // live mark at click
        // Aggregate 1h → H4 bars (Grok's H4 ATR) — a 1h ATR stop is far too tight for a
        // multi-day fade (noise stops it instantly); H4 gives a tradeable, honest stop.
        const h4: { h: number; l: number; c: number }[] = [];
        for (let i = 0; i < n; i += 4) {
          const cs = j.c.slice(i, i + 4);
          if (!cs.length) continue;
          h4.push({ h: Math.max(...j.h.slice(i, i + 4)), l: Math.min(...j.l.slice(i, i + 4)), c: Number(cs[cs.length - 1]) });
        }
        let trs = 0, cnt = 0;
        for (let i = Math.max(1, h4.length - 14); i < h4.length; i++) {
          const tr = Math.max(h4[i].h - h4[i].l, Math.abs(h4[i].h - h4[i - 1].c), Math.abs(h4[i].l - h4[i - 1].c));
          if (Number.isFinite(tr) && tr > 0) { trs += tr; cnt++; }
        }
        if (cnt) { atr = trs / cnt; atrSource = "H4 ATR(14), Orderly"; }
      }
    } catch { /* fall through to the labeled proxy */ }
    if (!(atr > 0)) atr = entry * 0.02;
    const risk = 1.2 * atr, RR = 1.5;
    const dp = entry >= 1000 ? 0 : entry >= 1 ? 2 : 6;
    const round = (v: number) => Number(v.toFixed(dp));
    const stopLoss = round(isShort ? entry + risk : entry - risk);
    const takeProfit1 = round(isShort ? entry - RR * risk : entry + RR * risk);
    const draft = {
      symbol: m.coin,
      direction: m.direction,
      entryPrice: String(round(entry)),
      stopLoss: String(stopLoss),
      takeProfit1: String(takeProfit1),
      catalyst: `Funding fade · ${m.fundingAnnualPct >= 0 ? "+" : ""}${m.fundingAnnualPct}%/yr stretched, crowd offside ${crowd}`,
      targetWindow: "7d",
      notes: `${m.coin} funding has pierced its typical range (${m.fundingAnnualPct >= 0 ? "+" : ""}${m.fundingAnnualPct}%/yr) — the crowd is stretched ${crowd}${m.smartMoney?.side ? `; smart money ${m.smartMoney.count} ${m.smartMoney.side}` : ""}. Fading the mean-revert. Frozen levels: entry at mark, stop 1.2× ${atrSource}, TP +${RR}R, 7-day time-stop. ATR-based — NOT sized off funding.`,
    };
    try { window.localStorage.setItem("nexus_thesis_draft", JSON.stringify(draft)); } catch { /* private mode */ }
    try {
      window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "thesis" } }));
      window.dispatchEvent(new CustomEvent("nexus:thesis-draft"));
    } catch { /* non-browser — ignore */ }
  };

  const selected = openCoin ? (markets || []).find((m) => m.coin === openCoin) || null : null;

  // ── DETAIL VIEW — open one market, understand it deeply ──────────────────────
  if (selected) {
    const m = selected;
    const l = lean[m.coin];
    const change = m.change24hPct;
    // ── ONE VERDICT drives the whole ticket (Grok): a FADE requires the crowd to be
    // STRETCHED now (funding pierces its own range), not merely elevated. Not stretched
    // (or too little history to confirm) → WATCH; balanced → NONE. Header, copy, the read,
    // and the Draft button all read from this — so the page can never argue with itself.
    const stretched = fundingStretched(pos?.points);
    const q = m.edgeQuality;
    // The historical base rate VETOES "FADE NOW" (Grok): funding can be stretched yet fading
    // it has bled (TRAP / reverted <40% of instances). Then the ticket reads WATCH — but the
    // Draft STAYS as "Draft anyway", because overriding a weak base rate on purpose is the
    // honest path (same rule as the Thesis WATCH gate). A clean FADE needs BOTH a stretch AND
    // a base rate that pays; a stretch alone, historically unproven, is a WATCH you may draft.
    const weakEdge = !!q && (q.tier === "TRAP" || (q.revertedPct != null && q.revertedPct < 40));
    // Magnitude floor (Grok): a stretch on a trivial band (−0.66%/yr) is not a crowded fade.
    // A FADE needs a stretch AND an economically large annualized cost; else it's a WATCH.
    const bigEnough = Math.abs(m.fundingAnnualPct) >= FADE_FUNDING_FLOOR_PCT_YR;
    const tooSmall = stretched === true && !bigEnough;   // pierced its range, but trivially small
    const verdict: "FADE" | "WATCH" | "NONE" = m.direction === "NONE" ? "NONE" : (stretched === true && !weakEdge && bigEnough) ? "FADE" : "WATCH";
    const isFade = verdict === "FADE";
    const draftAnyway = m.direction !== "NONE" && stretched === true && bigEnough && weakEdge;
    const canDraft = isFade || draftAnyway;
    return (
      <div>
        <button onClick={() => setOpenCoin(null)} className="nx-card-interactive" style={{
          display: "inline-flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em",
          color: C.text.muted, background: "none", border: `1px solid ${C.border}`, borderRadius: RADIUS.sm,
          padding: "6px 11px", cursor: "pointer", marginBottom: 16,
        }}>← BACK TO BOARD</button>

        {/* Primo layout: the card (with the hero chart) takes the bulk of the width so the
            SynthChart breathes; the learnable legend fills the right cleanly instead of a
            smushed card + a big empty gap. Capped so it doesn't sprawl on ultra-wide. */}
        <div style={{ display: isMobile ? "block" : "grid", gridTemplateColumns: "minmax(0,1.75fr) minmax(260px,1fr)", gap: 32, alignItems: "start", maxWidth: 1240 }}>
          {/* The card */}
          <div style={{ position: "relative", border: `1px solid ${C.border}`, borderLeft: `2px solid ${C.accent}`, borderRadius: RADIUS.lg, padding: "24px 28px", background: "linear-gradient(180deg,#17171a 0%,#0d0d0f 100%)", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: C.text.muted }}>
              <span style={{ color: C.text.fog }}>◆ Nexus · Funding edge</span>
              <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.08em", color: isFade ? C.accent : draftAnyway ? C.warn : C.text.muted }}>{verdict === "NONE" ? "BALANCED" : isFade ? "◆ FADE NOW" : draftAnyway ? `⚠ WATCH · FADE ${q?.revertedPct}% HIST` : "◆ WATCHING"}</span>
            </div>
            <div style={{ fontFamily: UI, fontSize: 14, color: C.text.fog, marginTop: 18 }}>{m.coin} perpetual</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 1 }}>
              <span style={{ fontFamily: MONO, fontSize: 40, fontWeight: 600, color: C.text.bright, letterSpacing: "-0.02em", lineHeight: 1 }}>${fmtPrice(m.markPrice)}</span>
              {change != null && <span style={{ fontFamily: MONO, fontSize: 14, color: change > 0 ? C.pos : change < 0 ? C.neg : C.text.muted }}>{change > 0 ? "+" : ""}{change}% today</span>}
            </div>

            <div style={{ height: 1, background: C.border, margin: "16px 0" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: MONO, fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: C.text.bright }}>
              <span style={{ width: 16, height: 3, borderRadius: 2, background: C.accent }} />{stanceLabel(m.direction)}
            </div>

            {/* two-pole positioning read */}
            <div style={{ margin: "18px 0 4px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontFamily: MONO, fontSize: 10, marginBottom: 8 }}>
                <span style={{ color: C.text.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontSize: 8.5 }}>Funding edge</span>
                <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 22, fontWeight: 600, color: C.text.bright }}>
                  {m.fundingAnnualPct >= 0 ? "+" : ""}{m.fundingAnnualPct}%<span title="Annualized — what the funding rate adds up to over a year if today's rate held. 'yr' = per year." style={{ fontSize: 11, color: C.text.faint, marginLeft: 3 }}>/yr</span>
                </span>
              </div>
              <SynthChart points={pos?.points ?? []} price={price ?? []} direction={m.direction}
                smartMoney={m.smartMoney} markPrice={m.markPrice} fundingAnnualPct={m.fundingAnnualPct} maxEdge={maxEdge} m={m} />
            </div>

            {/* PROJECTION — the expected-move cone + this fade's directional target. */}
            <div style={{ marginTop: 14 }}>
              <ProjectionBand symbol={m.coin} />
            </div>

            <p style={{ fontFamily: UI, fontSize: 13, lineHeight: 1.55, color: C.text.fog, marginTop: 14, padding: "11px 12px", background: "rgba(237,237,240,0.03)", border: `1px solid ${C.border}`, borderRadius: RADIUS.md }}>
              {plainRead(m, verdict, weakEdge, tooSmall)}
            </p>

            {/* Reversion proof — what happened the last times it looked this stretched. */}
            {pos?.reversion && (
              <p style={{ fontFamily: UI, fontSize: 12.5, lineHeight: 1.5, color: C.text.fog, marginTop: 10, padding: "11px 12px", background: "rgba(237,237,240,0.03)", border: `1px solid ${C.border}`, borderRadius: RADIUS.md }}>
                {reversionSentence(m.coin, pos.reversion)}
                <span style={{ display: "block", fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", textTransform: "uppercase", color: C.text.faint, marginTop: 6 }}>{m.coin} · from recorded funding history</span>
              </p>
            )}

            {/* THE READ — three-lens synthesis (crowd · smart $ · callers) + the fused verdict */}
            {m.direction !== "NONE"
              ? <SynthesisRead m={m} lean={l} active={isFade} />
              : (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontFamily: MONO, fontSize: 10 }}>
                  <span style={{ color: C.text.faint, textTransform: "uppercase", letterSpacing: "0.12em", fontSize: 8.5 }}>Second opinion</span>
                  <Callers m={m} lean={l} />
                </div>
              )}

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
              <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.text.faint }}>{isFade ? "Live read · funding + smart money" : draftAnyway ? "Stretched, but the fade is historically unproven here" : "Watching · no fade edge right now"}</span>
              {/* Share the READ as a branded, verifiable card (verdict only — no fake R/stops).
                  A WATCH card shares as WATCH, a FADE as FADE; unfurls on X, links back. */}
              <button onClick={() => {
                const text = isFade
                  ? `${m.coin} funding is stretched — the fade is ${m.direction} (${m.fundingAnnualPct >= 0 ? "+" : ""}${m.fundingAnnualPct}%/yr). A positioning read on Nexus, graded from public price:`
                  : draftAnyway
                  ? `${m.coin} funding is stretched (${m.fundingAnnualPct >= 0 ? "+" : ""}${m.fundingAnnualPct}%/yr) but fading it has historically underperformed — a watch, not a clean fade. The read on Nexus:`
                  : `${m.coin} funding is elevated (${m.fundingAnnualPct >= 0 ? "+" : ""}${m.fundingAnnualPct}%/yr) but within its typical range — no fade yet. The read on Nexus:`;
                window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(`https://og.nexustradinglabs.com/share/read/${m.coin}`)}`, "_blank", "noopener");
              }} title="Share this read as a card on X" className="nx-press" style={{
                marginLeft: "auto", fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.06em", color: C.text.muted,
                background: "none", border: `1px solid ${C.border}`, borderRadius: RADIUS.sm, padding: "8px 12px", cursor: "pointer",
              }}>↗ SHARE</button>
              {/* One primary action, and it answers the page's one question: is there a fade NOW?
                  FADE → greenlight Draft. WATCH/NONE → Draft disabled (Simulate stays below). */}
              <button onClick={() => canDraft && draftFade(m)} disabled={!canDraft} title={isFade ? "Draft this fade into the Thesis Engine" : draftAnyway ? "Funding is stretched but fading it has historically underperformed — draft it anyway on your own read, not the base rate" : "No fade edge right now — funding isn't stretched vs its range"} className="nx-card-interactive" style={{
                fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em",
                color: isFade ? C.accent : draftAnyway ? C.warn : C.text.faint, background: "none",
                border: `1px solid ${isFade ? C.borderStrong : draftAnyway ? `${C.warn}88` : C.border}`, borderRadius: RADIUS.md, padding: "9px 15px",
                cursor: canDraft ? "pointer" : "not-allowed", opacity: canDraft ? 1 : 0.55,
              }}>{isFade ? "Draft this fade →" : draftAnyway ? "Draft anyway →" : "No fade to draft yet"}</button>
            </div>

            {/* Pressure-test the fade before you take it — run it through a simulation. */}
            {m.direction !== "NONE" && (
              <div style={{ marginTop: 12 }}>
                <Simulate label="◆ Simulate this fade" wallet={wallet} body={{
                  kind: "thesis", coin: m.coin, direction: m.direction, entry: m.markPrice,
                  notes: `Funding fade — ${m.coin} funding is ${m.fundingAnnualPct >= 0 ? "+" : ""}${m.fundingAnnualPct}%/yr, the crowd is offside ${m.direction === "SHORT" ? "long" : "short"}; fading for the mean-revert.`,
                }} />
              </div>
            )}
          </div>

          {/* Learnable legend */}
          <div style={{ paddingTop: isMobile ? 20 : 6 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: C.text.muted, marginBottom: 14 }}>Reading the card</div>
            {[
              ["The price, big", "Where the market is now, and today's move. No decoding."],
              ["The stance", "Which way the crowd is piled. “Over-long” means too many are betting up — the setup to fade."],
              ["The edge + poles", "How far the crowd is from balanced, and which way to fade it. Bigger = more stretched."],
              ["The second opinion", "Where the graded, credible callers lean. When they disagree with the fade, that tension is flagged."],
              ["The move", "One tap turns it into a trade plan you review and grade — nothing fires on its own."],
            ].map(([t, d], i) => (
              <div key={i} style={{ position: "relative", paddingLeft: 34, paddingBottom: 15 }}>
                <span style={{ position: "absolute", left: 0, top: -2, width: 22, height: 22, border: `1px solid ${C.borderStrong}`, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 10, color: C.text.fog }}>{i + 1}</span>
                <div style={{ fontFamily: UI, fontSize: 13, fontWeight: 600, color: C.text.bright }}>{t}</div>
                <div style={{ fontFamily: UI, fontSize: 12.5, lineHeight: 1.5, color: C.text.fog, marginTop: 2 }}>{d}</div>
              </div>
            ))}
            {pos && pos.points.length < 8 && !pos.reversion && (
              <div style={{ fontFamily: MONO, fontSize: 9, color: C.text.faint, letterSpacing: "0.05em", marginTop: 4, lineHeight: 1.6 }}>
                Not enough funding history recorded for {m.coin} yet — the story-line and reversion stat light up as it accumulates.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── BOARD — scan them all ────────────────────────────────────────────────────
  return (
    <div>
      <SectionHeader
        eyebrow="MISPRICED BOARD"
        title="Where the crowd is overpaying"
        note={scanned > 0 ? <span><span style={{ color: C.text.bright }}>{scanned}</span> scanned · <span style={{ color: C.accent }}>{mispricedCount}</span> mispriced</span> : "FUNDING-EDGE LENS"}
      />

      <p style={{ fontFamily: UI, fontSize: 13, color: C.text.fog, lineHeight: 1.6, maxWidth: 680, margin: "0 0 14px" }}>
        Funding is the crowd's mispricing made explicit. When one side pays to hold, the book is lopsided —
        and the mean-revert edge is to <b style={{ color: C.text.bright }}>fade it</b>. Annualized and ranked, so the top is where
        positioning is most stretched right now. Open a market to understand it; tap to draft the fade.
      </p>

      {/* How to read — plain, once, for everyone */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 18, padding: "11px 13px", border: `1px solid ${C.border}`, borderLeft: `2px solid ${C.text.muted}`, borderRadius: RADIUS.md, background: C.surfaceAlt }}>
        <span style={{ fontFamily: MONO, fontSize: 12, color: C.text.muted, flexShrink: 0 }}>?</span>
        <span style={{ fontFamily: UI, fontSize: 12.5, lineHeight: 1.5, color: C.text.fog }}>
          <b style={{ color: C.text.bright }}>How to read this:</b> a big number means one side of the crowd is paying a lot to stay in the trade.
          That crowding usually unwinds, so the <b style={{ color: C.text.bright }}>edge is to bet the other way</b>. Green/red is just today's price move.
        </span>
      </div>

      {markets === null ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint, padding: "12px 2px" }}>loading board…</div>
      ) : markets.length === 0 ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint, padding: "12px 2px" }}>
          {err ? "Market data unavailable — retrying." : "No liquid markets to price right now."}
        </div>
      ) : (
        <>
          {/* SIGNAL — the stretched few, as cards */}
          {mispriced.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "6px 0 12px" }}>
                <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", color: C.accent }}>◆ MISPRICED · WATCHING</span>
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.text.faint }}>{mispriced.length}</span>
                <span style={{ flex: 1, height: 1, background: C.border }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)", gap: 14 }}>
                {mispriced.map((m) => {
                  const l = lean[m.coin];
                  return (
                    <div key={m.symbol} onClick={() => setOpenCoin(m.coin)} title="Open this market"
                      className="nx-card-interactive"
                      style={{ position: "relative", border: `1px solid ${C.borderStrong}`, borderLeft: `2px solid ${m.edgeQuality?.tier === "TRAP" ? C.warn : C.accent}`, borderRadius: RADIUS.lg, padding: "13px 15px 12px", background: "linear-gradient(180deg,#161619 0%,#101012 100%)", cursor: "pointer", overflow: "hidden" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
                        <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.text.bright }}>{m.coin}</span>
                        <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.text.faint }}>{fmtUsd(m.oiUsd)} open interest</span>
                        <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.08em", color: C.accent }}>WATCHING</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
                        <div>
                          <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: C.text.muted, marginBottom: 3 }}>Funding edge</div>
                          <div style={{ fontFamily: MONO, fontSize: 31, fontWeight: 600, color: C.text.bright, lineHeight: 0.9, letterSpacing: "-0.02em" }}>
                            {m.fundingAnnualPct >= 0 ? "+" : ""}{m.fundingAnnualPct}<span title="Annualized — what the funding rate adds up to over a year if today's rate held. 'yr' = per year." style={{ fontSize: 13, color: C.text.faint, marginLeft: 4 }}>%/yr</span>
                          </div>
                        </div>
                      </div>
                      <EdgeQualityChip q={m.edgeQuality} />
                      <SmartMoneyChip m={m} />
                      <div style={{ margin: "11px 0 2px" }}><PositionBar m={m} maxEdge={maxEdge} /></div>
                      <p style={{ fontFamily: UI, fontSize: 12.5, lineHeight: 1.5, color: C.text.fog, marginTop: 10, marginBottom: 0, padding: "8px 10px", background: "rgba(237,237,240,0.03)", border: `1px solid ${C.border}`, borderRadius: RADIUS.md }}>
                        {plainRead(m)}
                      </p>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, fontFamily: MONO, fontSize: 11, color: C.text.fog }}>
                        <span>${fmtPrice(m.markPrice)}</span>
                        {m.change24hPct != null && <span style={{ color: m.change24hPct > 0 ? C.pos : m.change24hPct < 0 ? C.neg : C.text.muted }}>{m.change24hPct > 0 ? "+" : ""}{m.change24hPct}% today</span>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}`, fontFamily: MONO, fontSize: 10 }}>
                        <span style={{ color: C.text.faint, textTransform: "uppercase", letterSpacing: "0.12em", fontSize: 8.5 }}>Top callers</span>
                        <Callers m={m} lean={l} />
                      </div>
                      {/* Open the ticket to draft — the Draft action is GATED on the verdict
                          there (WATCH never drafts), so the scan card can't bypass it. */}
                      <button onClick={(e) => { e.stopPropagation(); setOpenCoin(m.coin); }} style={{
                        marginTop: 11, width: "100%", fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                        color: C.accent, border: `1px solid ${C.borderStrong}`, borderRadius: RADIUS.md, padding: 8, background: "transparent", cursor: "pointer",
                      }}>→ Open &amp; size the fade</button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* PRICED FAIR — the quiet many, as a rail */}
          {fair.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "26px 0 12px" }}>
                <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", color: C.text.muted }}>PRICED FAIR</span>
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.text.faint }}>{fair.length} · sorted by edge</span>
                <span style={{ flex: 1, height: 1, background: C.border }} />
              </div>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: RADIUS.md, overflow: "hidden", background: C.surfaceAlt }}>
                {fair.map((m, i) => (
                  <div key={m.symbol} onClick={() => setOpenCoin(m.coin)}
                    className="nx-card-interactive"
                    style={{ display: "grid", gridTemplateColumns: isMobile ? "70px 1fr 84px" : "90px 1fr 96px 84px", gap: 12, alignItems: "center", padding: "9px 13px", borderTop: i === 0 ? "none" : `1px solid ${C.border}`, cursor: "pointer" }}>
                    <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: C.text.fog }}>{m.coin}</span>
                    {!isMobile && <div style={{ height: 4, borderRadius: 3, background: C.inset, border: `1px solid ${C.border}`, position: "relative" }}>
                      <div style={{ position: "absolute", top: 0, bottom: 0, background: C.borderStrong, ...(m.direction === "LONG" ? { right: "50%" } : { left: "50%" }), width: `${Math.min(46, (m.edge / maxEdge) * 46)}%` }} />
                    </div>}
                    {isMobile && <span />}
                    <span title="Annualized — what the funding rate adds up to over a year if today's rate held. 'yr' = per year." style={{ fontFamily: MONO, fontSize: 10.5, color: C.text.muted, textAlign: "right" }}>{m.fundingAnnualPct >= 0 ? "+" : ""}{m.fundingAnnualPct}%/yr</span>
                    <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.08em", color: C.text.faint, textAlign: "right" }}>FAIR</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <p style={{ fontFamily: MONO, fontSize: 9.5, color: C.text.faint, lineHeight: 1.6, marginTop: 18, letterSpacing: "0.02em" }}>
        Funding annualized (per-8h × 1095). |edge| ≥ 12%/yr on a market with ≥ $50k open interest ⇒ Mispriced · Watching; else priced fair.
        Caller lean is merit-weighted from open positions + active public calls. A read on positioning, not advice — a stretched market can stay stretched.
      </p>
    </div>
  );
}
