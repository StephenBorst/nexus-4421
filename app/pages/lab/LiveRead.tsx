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

const TREND_WORD: Record<string, string> = { TREND_UP: "uptrend", TREND_DOWN: "downtrend", CHOP: "chop" };
const VOL_WORD: Record<string, string> = { CALM: "calm", NORMAL: "normal vol", VOLATILE: "volatile" };

export function LiveRead({ symbol, direction, trades, levels, wallet }: { symbol: string; direction: "LONG" | "SHORT"; trades?: ProcessedTrade[]; levels?: Levels; wallet?: string | null }) {
  const coin = bare(symbol);
  const [fused, setFused] = useState<Fused | null | undefined>(undefined); // undefined=loading, null=no read
  const [callers, setCallers] = useState<{ side: "LONG" | "SHORT"; participants: number } | null>(null);
  const [advice, setAdvice] = useState<Advice>(null);
  const [baseRate, setBaseRate] = useState<BaseRate | null>(null);
  const [flush, setFlush] = useState<{ side: "UP" | "DOWN"; ratio: number } | null>(null);
  const [magnets, setMagnets] = useState<{ below: { price: number; side: string }[]; above: { price: number; side: string }[] } | null>(null);

  // Pending liquidation magnets (estimated heatmap) — where leveraged positions will be
  // force-closed = where price tends to get pulled. Forward-looking; fail-soft. Cached.
  useEffect(() => {
    if (!coin) { setMagnets(null); return; }
    let off = false;
    fetch(`${AGENT_API}/intel/liqmap/${coin}`).then((r) => r.json())
      .then((d) => { if (!off) setMagnets(d && d.available ? { below: d.below || [], above: d.above || [] } : null); })
      .catch(() => { if (!off) setMagnets(null); });
    return () => { off = true; };
  }, [coin]);
  const [basis, setBasis] = useState<{ side: "LONG" | "SHORT"; basisPct: number } | null>(null);
  const [ob, setOb] = useState<{ side: "LONG" | "SHORT"; imbalance: number } | null>(null);
  const [rawBasis, setRawBasis] = useState<number | null>(null);
  const [term, setTerm] = useState<{ structure: string; ratio: number; frontIv: number; backIv: number } | null>(null);

  // Spot-perp basis + order-book imbalance + options skew (one fetch). Basis: perp premium
  // (>0) = froth → SHORT, discount → LONG. OB: bid-heavy = support → LONG, ask-heavy → SHORT.
  // Skew (BTC/ETH/SOL): more put-fear than usual = capitulation → LONG, more call-greed → SHORT.
  useEffect(() => {
    if (!coin) { setBasis(null); setOb(null); setRawBasis(null); return; }
    let off = false;
    const sideOf = (s: { side?: string } | null | undefined) => (s && (s.side === "LONG" || s.side === "SHORT") ? s : null);
    fetch(`${AGENT_API}/intel/flow/${coin}`).then((r) => r.json())
      .then((d) => { if (off) return; setBasis((sideOf(d?.basisSignal) as typeof basis) ?? null); setOb((sideOf(d?.obSignal) as typeof ob) ?? null); setRawBasis(typeof d?.basis?.basisPct === "number" ? d.basis.basisPct : null); })
      .catch(() => { if (!off) { setBasis(null); setOb(null); setRawBasis(null); } });
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
      .then((d) => { if (!off) setBaseRate(d && d.available ? d : null); })
      .catch(() => { if (!off) setBaseRate(null); });
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
  const reads: { label: string; val: string; side: "LONG" | "SHORT" | null; ok: boolean }[] = [];
  if (fused?.crowdFade) reads.push({ label: "funding fade", val: fused.fundingAnnualPct != null ? `${fused.crowdFade} · ${fused.fundingAnnualPct}%/yr` : fused.crowdFade, side: fused.crowdFade, ok: fused.crowdFade === direction });
  if (fused?.smartSide) reads.push({ label: "smart money", val: `${fused.smartSide} · ${fused.smartTraders}`, side: fused.smartSide, ok: fused.smartSide === direction });
  if (fused && (fused.verdict === "CONFLUENCE" || fused.verdict === "SPLIT")) reads.push({ label: "positioning", val: fused.verdict === "CONFLUENCE" ? "◆ confluence" : "⚡ split", side: fused.verdict === "CONFLUENCE" ? boardLean : null, ok: fused.verdict === "CONFLUENCE" && boardLean === direction });
  if (callers) reads.push({ label: "graded callers", val: `${callers.side} · ${callers.participants}`, side: callers.side, ok: callers.side === direction });
  if (baseRate) reads.push({ label: "base rate", val: `${baseRate.hitRate}% · ${baseRate.expectancyR >= 0 ? "+" : ""}${baseRate.expectancyR}R`, side: boardLean, ok: baseRate.expectancyR > 0 && boardLean === direction });
  if (flush) { const fs = flush.side === "DOWN" ? "SHORT" : "LONG"; reads.push({ label: "liq flush", val: `${flush.ratio}× ${flush.side === "DOWN" ? "↓longs" : "↑shorts"}`, side: fs, ok: fs === direction }); }
  if (basis) reads.push({ label: "spot-perp basis", val: `${basis.basisPct > 0 ? "+" : ""}${basis.basisPct}% ${basis.basisPct > 0 ? "prem" : "disc"}`, side: basis.side, ok: basis.side === direction });
  // funding × basis divergence: funding says the crowd is one-sided, but the live perp premium
  // has already flipped the other way → the froth is unwinding → a mean-reversion bounce toward
  // the crowd's side is the tell (fade the fade). Only when funding is genuinely stretched.
  if (fused?.crowdFade && fused.fundingAnnualPct != null && rawBasis != null && Math.abs(fused.fundingAnnualPct) >= 10) {
    const crowdLong = fused.fundingAnnualPct > 0;
    if (crowdLong !== rawBasis > 0) { const bounce = crowdLong ? "LONG" : "SHORT"; reads.push({ label: "funding×basis", val: "premium fading", side: bounce, ok: bounce === direction }); }
  }
  if (ob) reads.push({ label: "order book", val: `${ob.imbalance > 0 ? "bid" : "ask"}-heavy`, side: ob.side, ok: ob.side === direction });
  if (record?.side) reads.push({ label: `your ${coin}`, val: `${record.side.net >= 0 ? "+" : "-"}$${Math.abs(record.side.net)} · ${record.side.n}t · ${record.side.wr}%`, side: record.side.net >= 0 ? direction : null, ok: record.side.net > 0 });
  else if (record) reads.push({ label: `your ${coin}`, val: `${record.net >= 0 ? "+" : "-"}$${Math.abs(record.net)} · ${record.n}t`, side: record.net >= 0 ? direction : null, ok: record.net > 0 });
  const agree = reads.filter((r) => r.ok).length;
  const pushback = reads.filter((r) => r.side && r.side !== direction).length;
  const convLevel = reads.length >= 3 && agree >= 4 ? "HIGH" : agree >= 2 && agree > pushback ? "MODERATE" : pushback > agree ? "AGAINST" : "LOW";
  const convColor = convLevel === "HIGH" ? POS : convLevel === "MODERATE" ? "#8fdcb8" : convLevel === "AGAINST" ? NEG : WARN;
  const convWord = convLevel === "HIGH" ? "HIGH CONVICTION" : convLevel === "MODERATE" ? "MODERATE" : convLevel === "AGAINST" ? "READS DISAGREE" : "LOW CONVICTION";

  const loading = fused === undefined;
  const nothing = fused === null && !callers && !record && !advice && !baseRate && !flush && !basis && !ob && !magnets && !term;

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
    const head = convLevel === "HIGH" ? `◆ High-conviction ${direction} — ${agree} of ${reads.length} independent reads align.`
      : convLevel === "AGAINST" ? `Heads up — the reads lean against your ${direction} (${pushback} push back).`
      : convLevel === "MODERATE" ? `Moderate ${direction} — ${agree} of ${reads.length} reads align.`
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
              <div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 8, background: `${convColor}12`, border: `1px solid ${convColor}33` }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", color: convColor }}>◆ {convWord}</span>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: FOG }}>{agree}/{reads.length} reads align {direction}{pushback > 0 ? ` · ${pushback} against` : ""}</span>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 6, marginBottom: 10 }}>
                {reads.map((r) => {
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
          {synth && <div style={{ fontFamily: UI, fontSize: 12.5, color: convColor === POS ? "#8fdcb8" : convColor, lineHeight: 1.55 }}>{synth}</div>}

          {/* BASE RATE — the honest historical resolution of the funding-fade setup here,
              from the same engine that grades live. Often below break-even by design; when
              it is, the read is "don't lean on this setup — trust your own edge." */}
          {baseRate && (
            <div style={{ marginTop: 8, fontFamily: UI, fontSize: 11.5, color: FOG, lineHeight: 1.5 }}>
              <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: MUTED }}>BASE RATE · </span>
              the funding-fade on {coin} resolved to target <b style={{ color: baseRate.expectancyR > 0 ? POS : WARN }}>{baseRate.hitRate}%</b> over {baseRate.samples} stretched-funding instances ({baseRate.windowDays}d), {baseRate.expectancyR >= 0 ? "+" : ""}{baseRate.expectancyR}R avg.{" "}
              <span style={{ color: MUTED }}>{baseRate.expectancyR > 0 ? "A real edge here — still size for variance." : "This setup has bled here — lean on your own thesis, not the fade."}</span>
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
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BORDER}` }}>
            <Simulate
              label="◆ Pressure-test this trade →"
              wallet={wallet}
              body={{ kind: "thesis", coin, direction, notes: synth || `${direction} ${coin} — ${convWord}, ${agree}/${reads.length} reads align.` }}
            />
          </div>

          <div style={{ fontFamily: MONO, fontSize: 8, color: FAINT, marginTop: 8, lineHeight: 1.5 }}>A read, not a green light — it tightens the odds, it doesn't guarantee them.</div>
        </>
      )}
    </div>
  );
}

export default LiveRead;
