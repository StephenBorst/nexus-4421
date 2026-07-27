// ── LIVE ADVISOR — intelligence at the decision, not after it ──
// Every other readout in the Lab is retrospective: you visit Analytics AFTER the
// trade. That's a dashboard. This is the coach — it speaks while the plan is still
// editable, which is the only moment the information can actually prevent anything.
//
// Two things, both from POST /theses/advice:
//   1. What market this symbol is in RIGHT NOW, and your graded record in that market
//      ("SOL is chopping. Your chop record: −0.8R over 11 calls.")
//   2. Whether this draft plan is well-formed — scored by the SAME planQuality that
//      will grade the call once posted, so the preview can't disagree with the grade.
//
// Never blocks submission and never nags: it's information, the trader decides. Silent
// while incomplete, on error, or when there's nothing worth saying.
import { useEffect, useRef, useState } from "react";
import { C, MONO, RADIUS } from "@/config/theme";

const AGENT_API = "https://og.nexustradinglabs.com";

type Bucket = { bucket: string; calls: number; avgR: number; hitRate: number };
type Advice = {
  regime: { trend: string; vol: string; movePct: number } | null;
  alignment: string | null;
  yourRecord: { trend: Bucket | null; vol: Bucket | null; align: Bucket | null; calls: number } | null;
  plan: { score: number; flags: string[] } | null;
  warnings: { severity: string; kind: string; text: string }[];
};

const TREND_WORD: Record<string, string> = { TREND_UP: "trending up", TREND_DOWN: "trending down", CHOP: "chopping" };
const VOL_WORD: Record<string, string> = { CALM: "calm", NORMAL: "normal vol", VOLATILE: "volatile" };

export function ThesisAdvisor({ symbol, direction, entryPrice, stopLoss, takeProfit1, riskReward, wallet, compact = false }: {
  symbol: string;
  /** Omitted on surfaces where the side isn't chosen yet (Quick Trade) — the server
   *  then withholds the alignment claim rather than inventing one. */
  direction?: "LONG" | "SHORT";
  entryPrice?: string;
  stopLoss?: string;
  takeProfit1?: string;
  riskReward?: number;
  wallet?: string | null;
  /** One-line variant for surfaces with no written plan to score (Quick Trade). */
  compact?: boolean;
}) {
  const [advice, setAdvice] = useState<Advice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced — the levels change on every keystroke, and each call costs the worker
  // a candle fetch plus a KV read.
  useEffect(() => {
    if (!symbol) { setAdvice(null); return; }
    if (timer.current) clearTimeout(timer.current);
    let cancel = false;
    timer.current = setTimeout(() => {
      fetch(`${AGENT_API}/theses/advice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, symbol, direction, entryPrice, stopLoss, takeProfit1, riskReward }),
      })
        .then((r) => r.json())
        .then((d) => { if (!cancel) setAdvice(d); })
        .catch(() => { if (!cancel) setAdvice(null); }); // fail-soft: never block the composer
    }, 600);
    return () => { cancel = true; if (timer.current) clearTimeout(timer.current); };
  }, [symbol, direction, entryPrice, stopLoss, takeProfit1, riskReward, wallet]);

  if (!advice?.regime) return null;

  const { regime, yourRecord, warnings } = advice;
  // The record in the dimension that actually differentiates: prefer alignment
  // (with/against the tape), fall back to the raw trend bucket.
  const rec = yourRecord?.align || yourRecord?.trend || null;
  const recTone = rec ? (rec.avgR > 0 ? C.pos : C.neg) : C.text.fog;
  const high = warnings.filter((w) => w.severity === "high");
  const medium = warnings.filter((w) => w.severity !== "high");

  // Compact: market character + your record in it, one line. Used where there's no
  // written plan to score — the point is context BEFORE a one-tap market order.
  if (compact) {
    return (
      <div style={{ background: C.inset, border: `1px solid ${C.border}`, borderRadius: RADIUS.sm, padding: "8px 11px", fontFamily: "var(--nx-font-ui)", fontSize: 11.5, color: C.text.muted, lineHeight: 1.55 }}>
        <strong style={{ color: C.text.fog }}>{symbol.replace("PERP_", "").replace("_USDC", "")}</strong> is{" "}
        {TREND_WORD[regime.trend] ?? regime.trend.toLowerCase()} ({VOL_WORD[regime.vol] ?? regime.vol.toLowerCase()}).
        {rec
          ? <> Your record in this market: <strong style={{ color: recTone }}>{rec.avgR > 0 ? "+" : ""}{rec.avgR}R</strong> over {rec.calls}.</>
          : <> No graded record here yet.</>}
      </div>
    );
  }

  return (
    <div style={{ background: C.inset, border: `1px solid ${high.length ? "#4a3a00" : C.border}`, borderRadius: RADIUS.sm, padding: "9px 11px", marginBottom: 8 }}>
      <div style={{ fontSize: 8, color: C.text.faint, fontFamily: MONO, letterSpacing: "0.1em", marginBottom: 5 }}>
        BEFORE YOU POST
      </div>

      {/* The market you're about to trade into + your record in it. */}
      <div style={{ fontFamily: "var(--nx-font-ui)", fontSize: 12, color: C.text.fog, lineHeight: 1.55 }}>
        <strong style={{ color: C.text.bright }}>{symbol.toUpperCase()}</strong> is{" "}
        {TREND_WORD[regime.trend] ?? regime.trend.toLowerCase()}
        <span style={{ color: C.text.faint }}> ({VOL_WORD[regime.vol] ?? regime.vol.toLowerCase()}, {regime.movePct > 0 ? "+" : ""}{regime.movePct}% over 2d)</span>.
        {rec ? (
          <> Your record here: <strong style={{ color: recTone }}>{rec.avgR > 0 ? "+" : ""}{rec.avgR}R</strong> over {rec.calls} call{rec.calls === 1 ? "" : "s"}.</>
        ) : (
          <span style={{ color: C.text.faint }}> No graded record in this market yet.</span>
        )}
      </div>

      {/* Plan defects, present tense, each naming the fix. Amber = caution. */}
      {(high.length > 0 || medium.length > 0) && (
        <div style={{ marginTop: 7, paddingTop: 7, borderTop: `1px solid ${C.border}` }}>
          {[...high, ...medium].map((w) => (
            <div key={w.kind} style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 3 }}>
              <span style={{ flexShrink: 0, color: w.severity === "high" ? C.warn : C.text.muted, fontFamily: MONO, fontSize: 10 }}>
                {w.severity === "high" ? "⚠" : "·"}
              </span>
              <span style={{ fontFamily: "var(--nx-font-ui)", fontSize: 11.5, color: w.severity === "high" ? C.text.fog : C.text.muted, lineHeight: 1.5 }}>
                {w.text}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 8, color: C.text.faint, fontFamily: MONO, marginTop: 6, lineHeight: 1.5 }}>
        information, not a gate — scored by the same functions that will grade this call
      </div>
    </div>
  );
}
