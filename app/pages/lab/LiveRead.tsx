import { useEffect, useMemo, useState } from "react";
import { fusePositioning, positioningRead } from "@/lib/positioning.mjs";
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
const dirColor = (d: string | null) => (d === "LONG" ? POS : d === "SHORT" ? NEG : MUTED);

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
  const reads: { label: string; side: "LONG" | "SHORT" | null; ok: boolean }[] = [];
  if (flush) { const fs = flush.side === "DOWN" ? "SHORT" : "LONG"; reads.push({ label: `liq flush ${flush.ratio}×`, side: fs, ok: fs === direction }); }
  if (fused?.crowdFade) reads.push({ label: "funding fade", side: fused.crowdFade, ok: fused.crowdFade === direction });
  if (fused?.smartSide) reads.push({ label: "smart money", side: fused.smartSide, ok: fused.smartSide === direction });
  if (callers) reads.push({ label: "graded callers", side: callers.side, ok: callers.side === direction });
  if (baseRate) reads.push({ label: `base rate ${baseRate.expectancyR >= 0 ? "+EV" : "−EV"}`, side: boardLean, ok: baseRate.expectancyR > 0 && boardLean === direction });
  if (record?.side) reads.push({ label: `your ${coin} record`, side: record.side.net >= 0 ? direction : null, ok: record.side.net > 0 });
  else if (record) reads.push({ label: `your ${coin} record`, side: record.net >= 0 ? direction : null, ok: record.net > 0 });
  const agree = reads.filter((r) => r.ok).length;
  const pushback = reads.filter((r) => r.side && r.side !== direction).length;
  const convLevel = reads.length >= 3 && agree >= 4 ? "HIGH" : agree >= 2 && agree > pushback ? "MODERATE" : pushback > agree ? "AGAINST" : "LOW";
  const convColor = convLevel === "HIGH" ? POS : convLevel === "MODERATE" ? "#8fdcb8" : convLevel === "AGAINST" ? NEG : WARN;
  const convWord = convLevel === "HIGH" ? "HIGH CONVICTION" : convLevel === "MODERATE" ? "MODERATE" : convLevel === "AGAINST" ? "READS DISAGREE" : "LOW CONVICTION";

  const loading = fused === undefined;
  const nothing = fused === null && !callers && !record && !advice && !baseRate && !flush;

  // one honest synthesis line, reacting to what the user is drafting
  const synth = (() => {
    const bits: string[] = [];
    if (fused && boardLean) {
      if (fused.verdict === "CONFLUENCE") bits.push(`the crowd and the smart money both point ${boardLean.toLowerCase()}`);
      else if (fused.verdict === "SPLIT") bits.push(`positioning is split — the smart money is with the crowd`);
      else if (fused.verdict === "CROWD") bits.push(`funding says fade ${boardLean.toLowerCase()}`);
      else bits.push(`the smart money is ${boardLean.toLowerCase()}`);
    }
    if (record?.side) bits.push(`your ${direction.toLowerCase()} record on ${coin} is ${record.side.net >= 0 ? "+" : "-"}$${Math.abs(record.side.net)} over ${record.side.n} (${record.side.wr}%)`);
    else if (record) bits.push(`your ${coin} record is ${record.net >= 0 ? "+" : "-"}$${Math.abs(record.net)} over ${record.n}`);
    const head = aligned ? `Your ${direction} lines up:` : against ? `Heads up — you're drafting ${direction}, but ` : `On ${coin}:`;
    if (!bits.length) return null;
    return `${head} ${bits.join("; ")}.`;
  })();

  const tone = aligned ? POS : against ? WARN : FOG;
  const chip = (label: string, val: React.ReactNode, color = FOG) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontFamily: MONO, fontSize: 8, letterSpacing: "0.12em", color: MUTED }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color }}>{val}</span>
    </div>
  );

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
          {/* CONVICTION VERDICT — how many independent reads agree with your direction.
              The engine = agreement across orthogonal sources, not any single dial.
              Explainable: the confirming reads are chipped below. */}
          {reads.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${BORDER}` }}>
              <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: convColor }}>◆ {convWord}</span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: FOG }}>{agree}/{reads.length} reads align {direction}{pushback > 0 ? ` · ${pushback} push back` : ""}</span>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap", marginLeft: "auto" }}>
                {reads.map((r) => (
                  <span key={r.label} title={r.side ? `${r.label}: ${r.side}` : r.label} style={{ fontFamily: MONO, fontSize: 8, color: r.ok ? POS : (r.side && r.side !== direction ? NEG : FAINT), border: `1px solid ${r.ok ? "#2a3a30" : r.side && r.side !== direction ? "#3a2530" : BORDER}`, borderRadius: 3, padding: "1px 5px" }}>{r.ok ? "✓" : r.side && r.side !== direction ? "✗" : "·"} {r.label}</span>
                ))}
              </span>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))", gap: 12, marginBottom: 10 }}>
            {fused && fused.crowdFade && chip("Funding", <span>fade <span style={{ color: dirColor(fused.crowdFade) }}>{fused.crowdFade}</span>{fused.fundingAnnualPct != null ? ` · ${fused.fundingAnnualPct}%/yr` : ""}</span>)}
            {fused && fused.smartSide && chip("Smart money", <span style={{ color: dirColor(fused.smartSide) }}>{fused.smartSide}<span style={{ color: FAINT, fontWeight: 400 }}> · {fused.smartTraders}</span></span>)}
            {fused && fused.verdict === "CONFLUENCE" && chip("Positioning", <span style={{ color: BONE }}>◆ CONFLUENCE</span>, BONE)}
            {fused && fused.verdict === "SPLIT" && chip("Positioning", <span style={{ color: WARN }}>⚡ SPLIT</span>, WARN)}
            {callers && chip("Callers", <span style={{ color: dirColor(callers.side) }}>{callers.side}<span style={{ color: FAINT, fontWeight: 400 }}> · {callers.participants}</span></span>)}
            {record && chip(`Your ${coin}`, <span style={{ color: record.net >= 0 ? POS : NEG }}>{record.net >= 0 ? "+" : "-"}${Math.abs(record.net)}<span style={{ color: FAINT, fontWeight: 400 }}> · {record.n}t · {record.wr}%</span></span>)}
            {baseRate && chip("Fade base rate", <span style={{ color: baseRate.expectancyR > 0 ? POS : WARN }}>{baseRate.hitRate}%<span style={{ color: FAINT, fontWeight: 400 }}> · {baseRate.samples}× · {baseRate.expectancyR >= 0 ? "+" : ""}{baseRate.expectancyR}R</span></span>)}
            {flush && chip("Liq flush", <span style={{ color: flush.side === "DOWN" ? NEG : POS }}>{flush.side === "DOWN" ? "↓ longs" : "↑ shorts"}<span style={{ color: FAINT, fontWeight: 400 }}> · {flush.ratio}×</span></span>)}
          </div>
          {synth && <div style={{ fontFamily: UI, fontSize: 12.5, color: tone === POS ? "#8fdcb8" : tone, lineHeight: 1.55 }}>{synth}</div>}

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

          <div style={{ fontFamily: MONO, fontSize: 8, color: FAINT, marginTop: 8, lineHeight: 1.5 }}>A read, not a green light — it tightens the odds, it doesn't guarantee them.</div>
        </>
      )}
    </div>
  );
}

export default LiveRead;
