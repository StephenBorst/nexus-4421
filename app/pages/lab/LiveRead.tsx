import { useEffect, useMemo, useState } from "react";
import { fusePositioning, positioningRead } from "@/lib/positioning.mjs";
import { fetchDeribitTerm } from "@/lib/deribit.mjs";
import { Simulate } from "./Simulate";
import type { ProcessedTrade } from "./types";
import { C } from "@/config/theme";

// ── THE READ — the pre-trade fusion panel (Phase-3 synthesis) ────────────────
// The decision moment used to be intelligence-blind: the Thesis Engine showed funding
// cost and R:R but none of the OBSERVE/PROVE intelligence. This fuses it INTO the draft.
// The instant you enter a symbol it pulls the SAME reads scattered across the Lab —
// positioning (crowd vs smart), the funding fade, the graded callers, and YOUR OWN record
// on this market — and synthesizes them against the direction you're drafting. One read,
// where the decision happens. Honest by construction: it shows the inputs, not a black-box
// score, and never a green light.

const AGENT_API = "https://og.nexustradinglabs.com";
const MONO = "var(--nx-font-mono)";
const UI = "var(--nx-font-ui, sans-serif)";
const BONE = "#ededf0", FOG = "#a1a1aa", MUTED = "#71717a", FAINT = "#52525b";
const POS = "#3ecf8e", NEG = "#f7525f", WARN = "#e0a458", BORDER = "#232327", INSET = "#0c0c0e";

const bare = (s: string) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");

type Fused = { coin: string; verdict: "CONFLUENCE" | "SPLIT" | "CROWD" | "SMART"; crowdFade: "LONG" | "SHORT" | null; smartSide: "LONG" | "SHORT" | null; fundingAnnualPct: number | null; smartTraders: number };
type Regime = { trend?: string; vol?: string; atrPct?: number };
type Warning = { text: string; severity?: string; kind?: string };
type Advice = { regime: Regime | null; alignment: string | null; warnings: Warning[]; plan: { flags?: string[] } | null; yourRecord: { trend?: { avgR: number; calls: number } | null; vol?: { avgR: number; calls: number } | null } | null } | null;
type Levels = { entryPrice: number; stopLoss: number; takeProfit1: number };
type BaseRate = { available: boolean; hitRate: number; samples: number; expectancyR: number; windowDays: number; setup?: string };

// ── MARKET BREADTH / BETA GATE — the tape a single-name read is posted INTO. A short on
// one alt can be right about the coin and wrong about the market: when the whole book's
// crowd is leaning the same way, systemic squeezes drag every name. We read the SAME
// mispriced board already fetched and tally how many markets the crowd is net-long vs
// net-short (funding sign per market). Broadly long funding = risk-on froth (a market-wide
// fade-SHORT backdrop); broadly negative = capitulation (a fade-LONG backdrop). Delivered
// as CONTEXT, never a conviction vote — it's the backdrop, not a per-coin signal, so it
// can't inflate the tally. Orthogonal to the single-coin funding fade and pure-client.
type Breadth = { crowdLong: number; crowdShort: number; total: number; lean: "LONG" | "SHORT" | null; sharePct: number };
type Momentum = { available: boolean; state: "BUILDING" | "UNWINDING" | "PEAKING" | "RESET" | "STABLE" | "FLAT"; windowHours: number; fundingChangePct: number; oiChangePct: number; headline: string };
function computeBreadth(markets: { fundingAnnualPct?: number }[]): Breadth | null {
  let crowdLong = 0, crowdShort = 0;
  for (const m of markets || []) {
    const f = Number(m.fundingAnnualPct);
    if (!Number.isFinite(f) || Math.abs(f) < 1) continue; // ignore near-flat funding (noise)
    if (f > 0) crowdLong++; else crowdShort++;            // +funding = crowd pays to be long
  }
  const total = crowdLong + crowdShort;
  if (total < 8) return null; // too few markets to call a backdrop
  const share = Math.max(crowdLong, crowdShort) / total;
  // ≥65% one-sided = a real broad tilt; the market-wide FADE lean is the contrarian side.
  const lean: "LONG" | "SHORT" | null = share >= 0.65 ? (crowdLong > crowdShort ? "SHORT" : "LONG") : null;
  return { crowdLong, crowdShort, total, lean, sharePct: Math.round(share * 100) };
}

type Magnet = { price: number; side: string; mag?: number };
type Magnets = { below: Magnet[]; above: Magnet[]; currentPrice: number };
type Beta = { available: boolean; beta: number; correlation: number; drivenPct: number; verdict: "BTC_DRIVEN" | "IDIOSYNCRATIC" | "MIXED" };

// ── LIQ-MAGNET PULL — the directional read from the liquidation heatmap. Long-liq
// clusters BELOW pull price down; short-liq clusters ABOVE pull it up. For your drafted
// direction one side is a TARGET (tailwind), the other a COUNTER (headwind). We score each
// magnet by strength ÷ distance (a near, heavy cluster pulls hardest) and compare the best
// tailwind to the best headwind. A clear tailwind = a natural target in your favor; a
// closer/heavier counter = price likely pulled against you first. Directional → it votes.
function magnetPull(m: Magnets | null, direction: "LONG" | "SHORT"): { side: "LONG" | "SHORT"; targetPrice: number; distPct: number } | null {
  if (!m || !(m.currentPrice > 0)) return null;
  const px = m.currentPrice;
  const score = (mag: Magnet) => {
    const distPct = Math.abs(mag.price - px) / px * 100;
    if (!(distPct > 0.05)) return 0;
    return (Number(mag.mag) || 1) / distPct;
  };
  const best = (arr: Magnet[]) => arr.reduce((b, x) => (score(x) > score(b || x) ? x : (b || x)), null as Magnet | null);
  const tailArr = direction === "SHORT" ? m.below : m.above; // target side
  const headArr = direction === "SHORT" ? m.above : m.below; // counter side
  const tail = best(tailArr), head = best(headArr);
  const ts = tail ? score(tail) : 0, hs = head ? score(head) : 0;
  if (ts <= 0) return null;
  if (ts >= hs * 1.3 && tail) return { side: direction, targetPrice: tail.price, distPct: Math.round(Math.abs(tail.price - px) / px * 1000) / 10 };
  if (hs >= ts * 1.3 && head) return { side: direction === "SHORT" ? "LONG" : "SHORT", targetPrice: head.price, distPct: Math.round(Math.abs(head.price - px) / px * 1000) / 10 };
  return null; // no decisive gradient
}

const TREND_WORD: Record<string, string> = { TREND_UP: "uptrend", TREND_DOWN: "downtrend", CHOP: "chop" };
const VOL_WORD: Record<string, string> = { CALM: "calm", NORMAL: "normal vol", VOLATILE: "volatile" };

export function LiveRead({ symbol, direction, trades, levels, wallet, onWeakEdge, onBaseRate }: { symbol: string; direction: "LONG" | "SHORT"; trades?: ProcessedTrade[]; levels?: Levels; wallet?: string | null; onWeakEdge?: (w: { weak: boolean; histPct: number | null }) => void; onBaseRate?: (br: { hitRate: number; expectancyR: number; samples: number } | null) => void }) {
  const coin = bare(symbol);
  const [fused, setFused] = useState<Fused | null | undefined>(undefined); // undefined=loading, null=no read
  const [callers, setCallers] = useState<{ side: "LONG" | "SHORT"; participants: number } | null>(null);
  const [breadth, setBreadth] = useState<Breadth | null>(null);
  const [momentum, setMomentum] = useState<Momentum | null>(null);
  const [advice, setAdvice] = useState<Advice>(null);
  const [baseRate, setBaseRate] = useState<BaseRate | null>(null);
  const [flush, setFlush] = useState<{ side: "UP" | "DOWN"; ratio: number } | null>(null);
  const [magnets, setMagnets] = useState<Magnets | null>(null);
  const [beta, setBeta] = useState<Beta | null>(null);

  // BTC beta — how much of this coin's move is just market beta (skip for BTC itself).
  useEffect(() => {
    if (!coin || coin === "BTC") { setBeta(null); return; }
    let off = false;
    fetch(`${AGENT_API}/intel/beta/${coin}`).then((r) => r.json())
      .then((d) => { if (!off) setBeta(d && d.available ? d : null); })
      .catch(() => { if (!off) setBeta(null); });
    return () => { off = true; };
  }, [coin]);

  // Pending liquidation magnets (estimated heatmap) — where leveraged positions will be
  // force-closed = where price tends to get pulled. Forward-looking; fail-soft. Cached.
  useEffect(() => {
    if (!coin) { setMagnets(null); return; }
    let off = false;
    fetch(`${AGENT_API}/intel/liqmap/${coin}`).then((r) => r.json())
      .then((d) => { if (!off) setMagnets(d && d.available ? { below: d.below || [], above: d.above || [], currentPrice: Number(d.currentPrice) || 0 } : null); })
      .catch(() => { if (!off) setMagnets(null); });
    return () => { off = true; };
  }, [coin]);
  const [basis, setBasis] = useState<{ side: "LONG" | "SHORT"; basisPct: number } | null>(null);
  const [ob, setOb] = useState<{ side: "LONG" | "SHORT"; imbalance: number } | null>(null);
  const [cvd, setCvd] = useState<{ side: "LONG" | "SHORT"; kind: string } | null>(null);
  const [rawBasis, setRawBasis] = useState<number | null>(null);
  const [term, setTerm] = useState<{ structure: string; ratio: number; frontIv: number; backIv: number } | null>(null);

  // Spot-perp basis + order-book imbalance + options skew (one fetch). Basis: perp premium
  // (>0) = froth → SHORT, discount → LONG. OB: bid-heavy = support → LONG, ask-heavy → SHORT.
  // Skew (BTC/ETH/SOL): more put-fear than usual = capitulation → LONG, more call-greed → SHORT.
  useEffect(() => {
    if (!coin) { setBasis(null); setOb(null); setCvd(null); setRawBasis(null); return; }
    let off = false;
    const sideOf = (s: { side?: string } | null | undefined) => (s && (s.side === "LONG" || s.side === "SHORT") ? s : null);
    fetch(`${AGENT_API}/intel/flow/${coin}`).then((r) => r.json())
      .then((d) => { if (off) return; setBasis((sideOf(d?.basisSignal) as typeof basis) ?? null); setOb((sideOf(d?.obSignal) as typeof ob) ?? null); setCvd((sideOf(d?.cvdSignal) as typeof cvd) ?? null); setRawBasis(typeof d?.basis?.basisPct === "number" ? d.basis.basisPct : null); })
      .catch(() => { if (!off) { setBasis(null); setOb(null); setCvd(null); setRawBasis(null); } });
    return () => { off = true; };
  }, [coin]);

  // Vol regime (DVOL term structure) — fetched CLIENT-SIDE: Deribit hard-blocks the worker's
  // datacenter IP but works from the browser (same as our GeckoTerminal fetch). BTC/ETH/SOL.
  useEffect(() => {
    if (!coin) { setTerm(null); return; }
    let off = false;
    fetchDeribitTerm(coin).then((t) => { if (!off) setTerm(t && t.structure ? t : null); }).catch(() => { if (!off) setTerm(null); });
    return () => { off = true; };
  }, [coin]);

  // Live liquidation flush (OKX feed) — a cascade of forced closes. DOWN = longs
  // capitulating (confirms a SHORT fade); UP = shorts squeezed (confirms a LONG).
  // Activates once ~12h of liq:hist has accrued; fail-soft/hidden until then.
  useEffect(() => {
    if (!coin) { setFlush(null); return; }
    let off = false;
    fetch(`${AGENT_API}/intel/liquidations/${coin}`).then((r) => r.json())
      .then((d) => { if (!off) setFlush(d && d.flush && (d.flush.side === "UP" || d.flush.side === "DOWN") ? d.flush : null); })
      .catch(() => { if (!off) setFlush(null); });
    return () => { off = true; };
  }, [coin]);

  // Historical base rate for the funding-fade setup on this coin — the honest "how has
  // this actually resolved" number, computed server-side by the REAL backtest engine over
  // 60d of public funding+price (first-touch TP vs SL). Cached; fail-soft.
  useEffect(() => {
    if (!coin) { setBaseRate(null); return; }
    let off = false;
    fetch(`${AGENT_API}/intel/baserate/${coin}`).then((r) => r.json())
      .then((d) => { if (!off) setBaseRate(d && d.available ? (d as BaseRate) : null); })
      .catch(() => { if (!off) setBaseRate(null); });
    return () => { off = true; };
  }, [coin]);

  // ── THE ONE HIST CLOCK (Grok) — the reversion / edgeQuality the GAPS card, ticket-verdict,
  // scanner AND this Quick Call all cite. /intel/positioning now returns the SAME object the
  // mispriced board computes (byte-identical fast-path, else its method), so every surface shows
  // ONE number — no more "SOL 80% on the card, 63% on Quick Call, 25% on the backtest." The
  // separate /intel/baserate backtest is NO LONGER cited on the live glass (kept only to FREEZE
  // the odds a published call was taken against — a past-tense record, not live conviction).
  const [reversion, setReversion] = useState<{ revertedPct: number; samples: number; tier: string } | null>(null);
  useEffect(() => {
    if (!coin) { setReversion(null); return; }
    let off = false;
    fetch(`${AGENT_API}/intel/positioning/${coin}`).then((r) => r.json())
      .then((d) => { if (!off) setReversion(d && d.reversion && d.reversion.samples ? { revertedPct: d.reversion.revertedPct, samples: d.reversion.samples, tier: (d.edgeQuality && d.edgeQuality.tier) || "" } : null); })
      .catch(() => { if (!off) setReversion(null); });
    return () => { off = true; };
  }, [coin]);

  // SETUP MOMENTUM (persistence / decay) — the one time-derivative: is the funding-fade
  // still building (early) or unwinding (late)? Server computes it from the recorded oi:hist.
  useEffect(() => {
    if (!coin) { setMomentum(null); return; }
    let off = false;
    fetch(`${AGENT_API}/intel/persistence/${coin}`).then((r) => r.json())
      .then((d) => { if (!off) setMomentum(d && d.available ? d : null); })
      .catch(() => { if (!off) setMomentum(null); });
    return () => { off = true; };
  }, [coin]);

  // Once the LEVELS are set, run the SAME grading the call will get later (/theses/advice):
  // the market regime, any plan defects (late entry, stop in noise, R:R mismatch…), and your
  // record IN that regime. The warnings match how it will actually be judged.
  const lv = levels && levels.entryPrice > 0 && levels.stopLoss > 0 && levels.takeProfit1 > 0 ? levels : null;
  useEffect(() => {
    if (!coin || !lv) { setAdvice(null); return; }
    let off = false;
    fetch(`${AGENT_API}/theses/advice`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: wallet || undefined, symbol: coin, direction, entryPrice: lv.entryPrice, stopLoss: lv.stopLoss, takeProfit1: lv.takeProfit1 }),
    }).then((r) => r.json()).then((d) => { if (!off) setAdvice(d && !d.error ? d : null); }).catch(() => { if (!off) setAdvice(null); });
    return () => { off = true; };
  }, [coin, direction, lv?.entryPrice, lv?.stopLoss, lv?.takeProfit1, wallet]);

  useEffect(() => {
    if (!coin) { setFused(undefined); setCallers(null); return; }
    let off = false; setFused(undefined); setCallers(null);
    Promise.all([
      fetch(`${AGENT_API}/intel/mispriced`).then((r) => r.json()).catch(() => null),
      fetch(`${AGENT_API}/smart/board`).then((r) => r.json()).catch(() => null),
      fetch(`${AGENT_API}/theses/consensus`).then((r) => r.json()).catch(() => null),
    ]).then(([mp, sb, cons]) => {
      if (off) return;
      const rows = fusePositioning(mp?.markets ?? [], sb?.traders ?? []) as Fused[];
      setFused(rows.find((r) => r.coin === coin) ?? null);
      const l = cons?.consensus?.[coin];
      setCallers(l && (l.side === "LONG" || l.side === "SHORT") ? { side: l.side, participants: Number(l.participants) || 0 } : null);
      setBreadth(computeBreadth(mp?.markets ?? []));
    }).catch(() => { if (!off) setFused(null); });
    return () => { off = true; };
  }, [coin]);

  // Your realized record on THIS market (edge-aware, at the decision).
  const record = useMemo(() => {
    const ts = (trades || []).filter((t) => bare(t.symbol) === coin);
    if (!ts.length) return null;
    const wins = ts.filter((t) => t.pnl > 0).length;
    const net = ts.reduce((s, t) => s + t.pnl, 0);
    const sideTs = ts.filter((t) => (t.direction || t.side) === direction);
    const sideWins = sideTs.filter((t) => t.pnl > 0).length;
    return {
      n: ts.length, wr: Math.round((wins / ts.length) * 100), net: Math.round(net),
      side: sideTs.length >= 2 ? { n: sideTs.length, wr: Math.round((sideWins / sideTs.length) * 100), net: Math.round(sideTs.reduce((s, t) => s + t.pnl, 0)) } : null,
    };
  }, [trades, coin, direction]);

  if (!coin) return null;

  // The market's lean the intelligence favors (the fade side; confluence when smart agrees).
  const boardLean: "LONG" | "SHORT" | null = fused
    ? (fused.verdict === "SMART" ? fused.smartSide : fused.crowdFade)
    : null;
  const aligned = boardLean != null && direction === boardLean;
  const against = boardLean != null && direction !== boardLean;

  // ── CONVICTION — the engine isn't one signal; it's how many INDEPENDENT, orthogonal
  // reads agree with the direction you're drafting. Each is a distinct data source
  // (crowd funding, on-chain smart money, the graded caller crowd, the historical base
  // rate, your own realized record). Agreement across uncorrelated sources is the only
  // thing that's held up — so we gate conviction on the TALLY, and stay fully explainable
  // by listing exactly which reads confirm and which push back. Never a black-box score.
  // vote=true → counts toward the N/M ALIGNED tally. The play is NOT a vote (Grok): only
  // genuinely INDEPENDENT directional reads vote — smart money, graded callers, spot-perp
  // basis, CVD flow, liq flush. The funding fade IS the play; positioning is a summary of the
  // others; the base rate is a CLOCK not a side; the order book is microstructure; funding×basis
  // is derived; the liq magnet is a target; your record is personal. Those DISPLAY as context
  // (base rate has its own loud line below) but never increment N — "counting is doing marketing".
  const reads: { label: string; val: string; side: "LONG" | "SHORT" | null; ok: boolean; vote: boolean }[] = [];
  if (fused?.crowdFade) reads.push({ label: "funding fade", val: fused.fundingAnnualPct != null ? `${fused.crowdFade} · ${fused.fundingAnnualPct}%/yr` : fused.crowdFade, side: fused.crowdFade, ok: fused.crowdFade === direction, vote: false });
  if (fused?.smartSide) reads.push({ label: "smart money", val: `${fused.smartSide} · ${fused.smartTraders}`, side: fused.smartSide, ok: fused.smartSide === direction, vote: true });
  if (fused && (fused.verdict === "CONFLUENCE" || fused.verdict === "SPLIT")) reads.push({ label: "positioning", val: fused.verdict === "CONFLUENCE" ? "◆ confluence" : "⚡ split", side: fused.verdict === "CONFLUENCE" ? boardLean : null, ok: fused.verdict === "CONFLUENCE" && boardLean === direction, vote: false });
  if (callers) reads.push({ label: "graded callers", val: `${callers.side} · ${callers.participants}`, side: callers.side, ok: callers.side === direction, vote: true });
  // The hist read is the ONE reversion clock (below) — the /intel/baserate backtest is no longer
  // shown as a read here (it was the second history book; one fade, one clock — Grok).
  if (flush) { const fs = flush.side === "DOWN" ? "SHORT" : "LONG"; reads.push({ label: "liq flush", val: `${flush.ratio}× ${flush.side === "DOWN" ? "↓longs" : "↑shorts"}`, side: fs, ok: fs === direction, vote: true }); }
  // Basis only VOTES when the premium/discount is actually a setup — a 7 bp discount shouldn't
  // mint a third "independent read" and bounce N every refresh (Grok). Below ~0.3% it's caption only.
  if (basis) reads.push({ label: "spot-perp basis", val: `${basis.basisPct > 0 ? "+" : ""}${basis.basisPct}% ${basis.basisPct > 0 ? "prem" : "disc"}`, side: basis.side, ok: basis.side === direction, vote: Math.abs(basis.basisPct) >= 0.3 });
  // funding × basis divergence: derived from funding + basis (NOT independent — no vote).
  if (fused?.crowdFade && fused.fundingAnnualPct != null && rawBasis != null && Math.abs(fused.fundingAnnualPct) >= 10) {
    const crowdLong = fused.fundingAnnualPct > 0;
    if (crowdLong !== rawBasis > 0) { const bounce = crowdLong ? "LONG" : "SHORT"; reads.push({ label: "funding×basis", val: "premium fading", side: bounce, ok: bounce === direction, vote: false }); }
  }
  if (cvd) reads.push({ label: "CVD flow", val: cvd.kind === "distribution" ? "sold into" : "bought up", side: cvd.side, ok: cvd.side === direction, vote: true });
  const pull = magnetPull(magnets, direction);
  if (pull) reads.push({ label: "liq pull", val: `${pull.distPct}% ${pull.side === direction ? "target" : "counter"}`, side: pull.side, ok: pull.side === direction, vote: false });
  if (ob) reads.push({ label: "order book", val: `${ob.imbalance > 0 ? "bid" : "ask"}-heavy`, side: ob.side, ok: ob.side === direction, vote: false });
  if (record?.side) reads.push({ label: `your ${coin}`, val: `${record.side.net >= 0 ? "+" : "-"}$${Math.abs(record.side.net)} · ${record.side.n}t · ${record.side.wr}%`, side: record.side.net >= 0 ? direction : null, ok: record.side.net > 0, vote: false });
  else if (record) reads.push({ label: `your ${coin}`, val: `${record.net >= 0 ? "+" : "-"}$${Math.abs(record.net)} · ${record.n}t`, side: record.net >= 0 ? direction : null, ok: record.net > 0, vote: false });
  const voteReads = reads.filter((r) => r.vote);
  const agree = voteReads.filter((r) => r.ok).length;
  const pushback = voteReads.filter((r) => r.side && r.side !== direction).length;
  const convLevel = voteReads.length >= 3 && agree >= 3 && agree > pushback ? "HIGH" : agree >= 2 && agree > pushback ? "MODERATE" : pushback > agree ? "AGAINST" : "LOW";
  const convColor = convLevel === "HIGH" ? POS : convLevel === "MODERATE" ? "#8fdcb8" : convLevel === "AGAINST" ? NEG : WARN;
  // "HIGH CONVICTION" is banned language app-wide (the loudest word must be the graded one) — the
  // HIGH case is a STRONG READ, and it only survives the dock below over a PROVEN reversion clock.
  const convWord = convLevel === "HIGH" ? "STRONG READ" : convLevel === "MODERATE" ? "MODERATE" : convLevel === "AGAINST" ? "READS DISAGREE" : "LOW CONVICTION";
  // ── THE ONE HIST CLOCK — reversion / edgeQuality only (Grok). Lenses agreeing is NOT the fade
  // working ("counting is doing marketing"), so a weak base rate VETOES the confidence word.
  //   weak     = a losing clock (edgeQuality TRAP or reverted ≤42%) → amber HIST line + arms WATCH.
  //   unproven = no reversion history (n=0) → can't read HIGH/PROVEN, says "unproven" (but doesn't
  //              force WATCH — you may draft an unproven fade on your own read).
  //   proven   = the fade has actually reverted here (edgeQuality PROVEN) → HIGH/PROVEN allowed.
  // The /intel/baserate BACKTEST is NO LONGER a second clock on the glass — one fade, one clock.
  const revPct = reversion ? reversion.revertedPct : null;
  const revWeak = reversion ? (reversion.tier === "TRAP" || (revPct != null && revPct <= 42)) : false;
  const revProven = reversion ? reversion.tier === "PROVEN" : false;
  const revUnproven = !reversion || reversion.tier === "UNPROVEN";
  const weakBase = revWeak;                                                               // the losing-clock dock (amber)
  const histLabel = revPct != null ? `${revPct}% reverted` : "unproven";
  // HIGH can only stand over a PROVEN clock; otherwise the word is capped to an aligned/HIST line
  // (a weak clock is amber; an unproven clock is muted and says "unproven" — n≥1 never says unproven).
  const cappedHigh = convLevel === "HIGH" && !revProven;
  const convWordFinal = (weakBase || cappedHigh) ? `${agree}/${voteReads.length} ALIGNED · HIST ${histLabel}` : convWord;
  const convColorFinal = weakBase ? WARN : cappedHigh ? MUTED : convColor;
  // The WATCH/arming gate is the reversion clock (one clock ticket↔read↔thesis, no fork).
  useEffect(() => { onWeakEdge?.({ weak: revWeak, histPct: revPct }); }, [revWeak, revPct, onWeakEdge]);
  // /intel/baserate is kept ONLY to FREEZE the odds a published call was taken against — a
  // past-tense record on the card, never a live conviction word (which cites the reversion clock).
  useEffect(() => { onBaseRate?.(baseRate ? { hitRate: baseRate.hitRate, expectancyR: baseRate.expectancyR, samples: baseRate.samples } : null); }, [baseRate, onBaseRate]);

  // ── PROVEN-EDGE PATTERN — not "more reads agree," but the SPECIFIC orthogonal stack the
  // backtests + live grading actually validated: the funding-fade CONDITIONED on smart-money
  // agreement AND a positive historical base rate, all on the side you're drafting. Every
  // exhaustive sweep found the naive funding/OI dials net-negative; the ONE door that stayed
  // open was conditioning the fade on the orthogonal smart-money signal. This detects exactly
  // that configuration. It fires rarely by design — a positive base rate is the exception, not
  // the rule — and that scarcity IS the honesty. When it lights up we name it distinctly, so a
  // 4-of-8 tally of soft reads is never mistaken for the confluence that has actually held up.
  const provenEdge = !!(
    fused && fused.crowdFade === direction && fused.smartSide === direction &&
    fused.fundingAnnualPct != null && Math.abs(fused.fundingAnnualPct) >= 10 &&
    revProven   // the fade has actually reverted here (the ONE clock, edgeQuality PROVEN) — never over a weak/unproven one
  );

  const loading = fused === undefined;
  const nothing = fused === null && !callers && !record && !advice && !reversion && !flush && !basis && !ob && !magnets && !term;

  // THE SYNTHESIS — one honest "so what" line woven from the full engine: the conviction
  // headline (from the multi-axis tally), then the context the chips don't spell out — the
  // vol regime (does this market favor fades?), the nearest liq magnet in your direction (a
  // natural target), and your own record here. The verdict band lists WHICH reads align; this
  // says what it MEANS. Reacts to the direction you're drafting.
  const synth = (() => {
    if (!reads.length) return null;
    const px = (n: number) => (n >= 1000 ? n.toLocaleString() : String(n));
    const bits: string[] = [];
    if (term) bits.push(term.structure === "backwardation"
      ? "options are backwardated — the volatile, mean-reverting regime fades work best in"
      : term.structure === "contango"
      ? "vol is calm — a trend regime, so fades are lower-odds"
      : "vol curve is neutral");
    const mag = magnets && (direction === "SHORT" ? magnets.below?.[0] : magnets.above?.[0]);
    if (mag) bits.push(`a liquidation magnet sits at $${px(mag.price)} ${direction === "SHORT" ? "below" : "above"} — a natural target`);
    if (record?.side) bits.push(`your ${direction.toLowerCase()} record on ${coin} is ${record.side.net >= 0 ? "+" : "-"}$${Math.abs(record.side.net)} over ${record.side.n} (${record.side.wr}%)`);
    else if (record) bits.push(`your ${coin} record is ${record.net >= 0 ? "+" : "-"}$${Math.abs(record.net)} over ${record.n}`);
    const alignLine = `${agree} of ${voteReads.length} reads align ${direction}`;
    const head = provenEdge ? `◆ Proven-edge setup — the funding-fade ${direction} on ${coin}, confirmed by smart money and a hist that's reverted ${revPct}% of the time. The one confluence that's held up in testing.`
      : weakBase ? `${alignLine}, but the hist says it loses — it reverted only ${revPct}% of recent stretched-funding instances. Aligned lenses aren't a paying edge; trust your own thesis, not the fade.`
      : convLevel === "AGAINST" ? `Heads up — the reads lean against your ${direction} (${pushback} push back).`
      : (convLevel === "HIGH" && revProven) ? `◆ Strong read ${direction} — ${alignLine}, and the fade has paid here (${revPct}% reverted).`
      : (convLevel === "HIGH" || convLevel === "MODERATE") ? `${alignLine}${revUnproven ? " — but the fade is unproven here, so trust your own thesis over the tally" : ""}.`
      : `Thin read on ${coin} — trust your own thesis.`;
    return bits.length ? `${head} ${bits.join("; ")}.` : head;
  })();

  const tone = aligned ? POS : against ? WARN : FOG;
  return (
    <div style={{ border: `1px solid ${aligned ? "#2a3a30" : against ? "#3a3320" : BORDER}`, borderLeft: `2px solid ${tone}`, background: C.surfaceAlt, borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: tone, boxShadow: `0 0 8px ${tone}88` }} />
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: BONE }}>THE READ · {coin}</span>
        <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 8.5, color: FAINT }}>live · positioning + your record</span>
      </div>

      {loading ? (
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>Reading {coin}…</div>
      ) : nothing ? (
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: MUTED, lineHeight: 1.5 }}>No strong read on {coin} right now — no funding extreme, no sharp cluster, no record here yet. Trust your own thesis.</div>
      ) : (
        <>
          {/* CONVICTION VERDICT — how many INDEPENDENT, orthogonal reads agree with your
              direction. Verdict leads (tinted hero); the evidence is ONE self-contained grid
              below — each read shows its value AND its alignment (✓ aligns / ✗ against / ·
              neutral), colored by alignment. Never a black-box score. */}
          {reads.length > 0 && (
            <>
              <div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 8, background: `${convColorFinal}12`, border: `1px solid ${convColorFinal}33` }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", color: convColorFinal }}>◆ {convWordFinal}</span>
                  {provenEdge && <span title="Funding-fade + smart-money + a positive base rate all align — the one configuration that survived backtesting" style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.1em", color: POS, border: `1px solid ${POS}55`, borderRadius: 3, padding: "1px 6px" }}>◆ PROVEN-EDGE SETUP</span>}
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: FOG }}>{agree}/{voteReads.length} independent reads align {direction}{pushback > 0 ? ` · ${pushback} against` : ""}</span>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 6, marginBottom: 10 }}>
                {voteReads.map((r) => {
                  const c = r.ok ? POS : (r.side && r.side !== direction ? NEG : FAINT);
                  const bd = r.ok ? "#2a3a30" : (r.side && r.side !== direction ? "#3a2530" : BORDER);
                  return (
                    <div key={r.label} style={{ display: "flex", alignItems: "baseline", gap: 7, border: `1px solid ${bd}`, borderRadius: 5, padding: "6px 9px", background: INSET }}>
                      <span style={{ fontFamily: MONO, fontSize: 10, color: c, flexShrink: 0 }}>{r.ok ? "✓" : r.side && r.side !== direction ? "✗" : "·"}</span>
                      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                        <span style={{ fontFamily: MONO, fontSize: 8, letterSpacing: "0.1em", color: MUTED, textTransform: "uppercase" }}>{r.label}</span>
                        <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: c === FAINT ? FOG : c, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.val}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {synth && <div style={{ fontFamily: UI, fontSize: 12.5, color: convColorFinal === POS ? "#8fdcb8" : convColorFinal, lineHeight: 1.55 }}>{synth}</div>}

          {/* SETUP MOMENTUM — persistence/decay: the ONLY time-derivative read. Is the crowded
              funding-fade still building (early) or already unwinding (late)? From oi:hist. */}
          {momentum && momentum.state !== "FLAT" && (() => {
            const s = momentum.state;
            const col = s === "BUILDING" ? POS : s === "UNWINDING" ? NEG : WARN;
            const tag = s === "BUILDING" ? "▲ BUILDING" : s === "UNWINDING" ? "▼ UNWINDING" : s === "PEAKING" ? "◆ PEAKING" : s === "RESET" ? "↻ RESET" : "= STABLE";
            return (
              <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.08em", color: col, border: `1px solid ${col}55`, borderRadius: 3, padding: "1px 6px", flexShrink: 0 }}>{tag}</span>
                <span style={{ fontFamily: UI, fontSize: 11.5, color: FOG, lineHeight: 1.5, flex: 1, minWidth: 180 }}>
                  <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: MUTED }}>SETUP MOMENTUM · </span>
                  {momentum.headline}
                  <span style={{ color: FAINT }}> {momentum.fundingChangePct >= 0 ? "+" : ""}{momentum.fundingChangePct}% funding / {momentum.oiChangePct >= 0 ? "+" : ""}{momentum.oiChangePct}% OI over {momentum.windowHours}h.</span>
                </span>
              </div>
            );
          })()}

          {/* HIST — the ONE reversion clock (the SAME series the card / ticket / scanner cite):
              how often fading this stretch has actually reverted here. Green when proven, amber
              when it has bled, muted when there isn't enough history to prove it. The separate
              /intel/baserate backtest is NOT shown here — one fade, one clock (Grok). */}
          {reversion && (
            <div style={{ marginTop: 8, fontFamily: UI, fontSize: 11.5, color: FOG, lineHeight: 1.5 }}>
              <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: MUTED }}>HIST · </span>
              {revPct != null
                ? <>fading {coin} here has reverted <b style={{ color: revProven ? POS : revWeak ? WARN : MUTED }}>{revPct}%</b> of the last {reversion.samples} stretched-funding instances.{" "}
                    <span style={{ color: MUTED }}>{revProven ? "A real edge here — still size for variance." : revWeak ? "This setup has bled here — lean on your own thesis, not the fade." : "Not proven yet — trust your own read over the fade."}</span></>
                : <span style={{ color: MUTED }}>no reversion history for {coin} yet — the fade is unproven; trust your own read.</span>}
            </div>
          )}

          {/* LIQ MAGNETS — estimated pending liquidation clusters (heatmap-lite): where
              leveraged positions get force-closed = where price tends to get pulled. */}
          {magnets && (magnets.below.length > 0 || magnets.above.length > 0) && (
            <div style={{ marginTop: 8, fontFamily: UI, fontSize: 11.5, color: FOG, lineHeight: 1.5 }}>
              <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: MUTED }}>LIQ MAGNETS · </span>
              {magnets.below[0] && <>downside pull <b style={{ color: NEG }}>${magnets.below[0].price >= 1000 ? magnets.below[0].price.toLocaleString() : magnets.below[0].price}</b> <span style={{ color: FAINT }}>(long liqs)</span></>}
              {magnets.below[0] && magnets.above[0] ? " · " : ""}
              {magnets.above[0] && <>upside pull <b style={{ color: POS }}>${magnets.above[0].price >= 1000 ? magnets.above[0].price.toLocaleString() : magnets.above[0].price}</b> <span style={{ color: FAINT }}>(short liqs)</span></>}
              <span style={{ color: MUTED }}> — estimated, where cascades sit.</span>
            </div>
          )}

          {/* VOL REGIME — DVOL term structure. Backwardation (front vol > back) = acute
              near-term stress, the regime mean-reversion fades work best in. BTC/ETH/SOL. */}
          {term && (
            <div style={{ marginTop: 8, fontFamily: UI, fontSize: 11.5, color: FOG, lineHeight: 1.5 }}>
              <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: MUTED }}>VOL REGIME · </span>
              options are in <b style={{ color: term.structure === "backwardation" ? WARN : term.structure === "contango" ? POS : FOG }}>{term.structure}</b> ({term.frontIv}v front / {term.backIv}v back).{" "}
              <span style={{ color: MUTED }}>{term.structure === "backwardation" ? "Acute near-term stress — fades work best here, but size for the move." : term.structure === "contango" ? "Calm/complacent — trends over fades." : "Neutral vol curve."}</span>
            </div>
          )}

          {/* MARKET BACKDROP — breadth/beta gate: the tape this single-name read is posted
              into. Broad one-sided funding = a market-wide fade lean that drags every name. */}
          {breadth && (
            <div style={{ marginTop: 8, fontFamily: UI, fontSize: 11.5, color: FOG, lineHeight: 1.5 }}>
              <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: MUTED }}>MARKET BACKDROP · </span>
              {breadth.crowdLong >= breadth.crowdShort ? breadth.crowdLong : breadth.crowdShort} of {breadth.total} markets have crowds leaning <b style={{ color: breadth.crowdLong >= breadth.crowdShort ? POS : NEG }}>{breadth.crowdLong >= breadth.crowdShort ? "long" : "short"}</b>
              {breadth.lean
                ? <> — <b style={{ color: breadth.lean === "LONG" ? POS : WARN }}>{breadth.lean === "SHORT" ? "risk-on froth" : "broad capitulation"}</b>, a market-wide fade-{breadth.lean.toLowerCase()} backdrop. <span style={{ color: breadth.lean === direction ? POS : WARN }}>Your {direction.toLowerCase()} runs {breadth.lean === direction ? "with" : "against"} the tape.</span></>
                : <span style={{ color: MUTED }}> — mixed, no broad tilt to fight or ride.</span>}
            </div>
          )}

          {/* BTC BETA — is this move the coin's own, or just market beta? Modulates how much
              the single-name reads mean; never votes a side. Skipped for BTC itself. */}
          {beta && (
            <div style={{ marginTop: 8, fontFamily: UI, fontSize: 11.5, color: FOG, lineHeight: 1.5 }}>
              <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: MUTED }}>BTC BETA · </span>
              {coin}'s move is <b style={{ color: beta.verdict === "BTC_DRIVEN" ? WARN : beta.verdict === "IDIOSYNCRATIC" ? POS : FOG }}>{beta.drivenPct}% BTC-driven</b> (β {beta.beta}).{" "}
              <span style={{ color: MUTED }}>{beta.verdict === "BTC_DRIVEN"
                ? `A ${direction.toLowerCase()} here is largely a BTC bet — the ${coin}-specific reads mean less; check BTC first.`
                : beta.verdict === "IDIOSYNCRATIC"
                ? `Trading on its own — this is a real ${coin}-specific read, not market beta.`
                : "Part market beta, part its own move."}</span>
            </div>
          )}

          {/* GRADING PREVIEW — once levels are set, the SAME grading the call will get:
              regime it's posted into, your record there, and any plan defect. */}
          {advice && (advice.regime || (advice.warnings && advice.warnings.length > 0)) && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BORDER}` }}>
              <div style={{ fontFamily: MONO, fontSize: 8, letterSpacing: "0.12em", color: MUTED, marginBottom: 6 }}>GRADING PREVIEW · how this call will be judged</div>
              {advice.regime && (
                <div style={{ fontFamily: UI, fontSize: 12, color: FOG, lineHeight: 1.5 }}>
                  {coin} is in a {TREND_WORD[advice.regime.trend || ""] || (advice.regime.trend || "").toLowerCase()} · {VOL_WORD[advice.regime.vol || ""] || (advice.regime.vol || "").toLowerCase()} tape
                  {advice.alignment === "AGAINST_TREND" ? <span style={{ color: WARN }}> — you're fighting the trend</span> : advice.alignment === "WITH_TREND" ? <span style={{ color: POS }}> — with the trend</span> : null}
                  {advice.yourRecord?.trend && advice.regime.trend ? <span style={{ color: FAINT }}> · your {TREND_WORD[advice.regime.trend] || ""} record {advice.yourRecord.trend.avgR >= 0 ? "+" : ""}{advice.yourRecord.trend.avgR}R/{advice.yourRecord.trend.calls}</span> : null}
                </div>
              )}
              {advice.warnings && advice.warnings.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 7 }}>
                  {advice.warnings.slice(0, 3).map((w, i) => (
                    <div key={i} style={{ fontFamily: UI, fontSize: 11.5, color: w.severity === "high" ? NEG : WARN, lineHeight: 1.45, display: "flex", gap: 6 }}><span>⚠</span><span>{w.text}</span></div>
                  ))}
                </div>
              ) : (
                <div style={{ fontFamily: MONO, fontSize: 10.5, color: POS, marginTop: 7 }}>✓ plan reads clean — grades on first touch of target vs stop.</div>
              )}
            </div>
          )}

          {/* PRESSURE-TEST — run the Miroshark sim on this exact trade: 25 agents react over
              10 rounds, surfacing the bull/bear case + where consensus lands. The decision-
              moment stress test, right in the read. */}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <Simulate
                label="◆ Pressure-test this trade →"
                wallet={wallet}
                body={{ kind: "thesis", coin, direction, notes: synth || `${direction} ${coin} — ${convWordFinal}, ${agree}/${voteReads.length} reads align.` }}
              />
            </div>
            {reads.length >= 2 && (() => {
              // Share the read — on-brand content ("multi-axis, graded, not advice"), pulls eyes
              // back to the Lab. Frames it as a READ, never a call/signal.
              const conf = reads.filter((r) => r.ok).map((r) => r.label).slice(0, 4).join(", ");
              const text = `◆ Nexus read — ${convWordFinal}, ${direction} ${coin}: ${agree}/${voteReads.length} independent reads align${conf ? ` (${conf})` : ""}. Multi-axis, graded on-chain, not advice. The full breakdown 👇`;
              const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent("https://trade.nexustradinglabs.com/lab")}`;
              return (
                <a href={xUrl} target="_blank" rel="noopener noreferrer" title="Share this read on X" className="nx-press"
                  style={{ flexShrink: 0, fontFamily: MONO, fontSize: 10, color: FOG, background: "transparent", border: `1px solid ${BORDER}`, borderRadius: 3, padding: "5px 11px", textDecoration: "none", whiteSpace: "nowrap" }}>𝕏 Share the read</a>
              );
            })()}
          </div>

          <div style={{ fontFamily: MONO, fontSize: 8, color: FAINT, marginTop: 8, lineHeight: 1.5 }}>A read, not a green light — it tightens the odds, it doesn't guarantee them.</div>
        </>
      )}
    </div>
  );
}

export default LiveRead;
