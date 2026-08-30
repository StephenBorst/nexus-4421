// ── CATALYST READ — world events → the Nexus markets you can trade ───────────
// The event layer of the engine. Liquid Polymarket macro/geopolitical markets, mapped
// to the LISTED markets they move here: oil-region geopolitics → CL (crude), rates →
// NAS, risk-on/off → BTC/SPX. The crowd probability shows how PRICED it already is. A
// setup to stake a graded thesis + execute here — not a fair-value oracle, not advice.
import { useEffect, useState } from "react";
import { SectionHeader } from "./components";
import { C } from "@/config/theme";
import { AGENT_API } from "./agentTypes";
import { h4Atr14Frac } from "@/lib/atr.mjs";

const MONO = "var(--nx-font-mono)";
const UI = "var(--nx-font-ui, sans-serif)";

type Impact = { coin: string; market: string; direction: "LONG" | "SHORT"; rationale: string };
type Catalyst = { question: string; category: string; riskLens: string; yesProbPct: number; volumeUsd: number; endDate: string | null; clobTokenId: string | null; impacts: Impact[] };
type Board = { asOf?: string; count: number; catalysts: Catalyst[]; note?: string };
// The funding verdict per coin, from /signals — the SAME verdict object the Board/ticket use
// (FADE LONG / FADE SHORT / WATCH). An impact can draft ONLY if its coin has one (which also
// guarantees a live mark + ≥60h tv/history for the H4 ATR stop) — no verdict ⇒ it stays a chip.
type Verdict = { verdict: "FADE" | "WATCH" | "NONE"; fadeDir: "LONG" | "SHORT" | "NONE"; ann: number };

// ── CATALYST → FROZEN THESIS (Grok gate) — an event drafts ONLY if it fills the object with
// NO invention: coin+side (the impact), live mark, stop = 1.2× H4 ATR14 (h4Atr14Frac — the ONE
// ruler the harness grades in), TP = 1.5R, 7d time-stop, why = the event sentence + the funding
// verdict object. baseRateAtEntry is NOT set here — it's frozen at PUBLISH from the reversion
// clock (the Thesis Engine's LiveRead). Same schema + prefill as a fade draft: it lands in the
// Thesis Engine looking like any other draft, and gradeCall grades the published dollars. No new
// grader, no LEAN/HIGH/fake E[R], RSI never enters. Returns false if the live data can't fill it.
const THESIS_DRAFT_KEY = "nexus_thesis_draft";
async function draftCatalyst(im: Impact, c: Catalyst, v: Verdict): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  let entry = 0, atrFrac: number | null = null;
  try {
    const j = await fetch(`https://api-evm.orderly.org/tv/history?symbol=${im.market}&resolution=60&from=${now - 100 * 3600}&to=${now}`).then((r) => r.json());
    if (j?.s === "ok" && Array.isArray(j.t) && Array.isArray(j.c) && Array.isArray(j.h) && Array.isArray(j.l)) {
      const hourly = j.t.map((t: number, i: number) => ({ t: Number(t), h: Number(j.h[i]), l: Number(j.l[i]), c: Number(j.c[i]) })).filter((p: { c: number }) => Number.isFinite(p.c) && p.c > 0);
      if (hourly.length) entry = hourly[hourly.length - 1].c;
      atrFrac = h4Atr14Frac(hourly);
    }
  } catch { /* fall through — the gate should prevent this; abort below if unfilled */ }
  if (!(entry > 0) || atrFrac == null) return false; // can't fill the frozen object → no draft
  const isShort = im.direction === "SHORT";
  const risk = entry * 1.2 * atrFrac, RR = 1.5;
  const dp = entry >= 1000 ? 0 : entry >= 1 ? 2 : 6;
  const round = (x: number) => Number(x.toFixed(dp));
  const stopLoss = round(isShort ? entry + risk : entry - risk);
  const takeProfit1 = round(isShort ? entry - RR * risk : entry + RR * risk);
  // The funding verdict comes straight from /signals — the floor now lives in readVerdict there
  // (one path owns it), so no client clamp: a below-floor pierce already arrives as WATCH.
  const fundLens = v.verdict === "FADE" ? `FADE ${v.fadeDir}` : v.verdict === "WATCH" ? "WATCH — funding not stretched" : "no funding edge";
  const fundNote = v.verdict === "FADE"
    ? (v.fadeDir === im.direction ? " (funding agrees)" : " (funding fades the other way — this is an event-driven directional call, not a funding fade)")
    : "";
  const draft = {
    symbol: im.coin,
    direction: im.direction,
    entryPrice: String(round(entry)),
    stopLoss: String(stopLoss),
    takeProfit1: String(takeProfit1),
    catalyst: `Event · ${c.question}`,
    targetWindow: "7d",
    notes: `${c.question} — ${im.rationale} (${im.coin} ${im.direction}). Funding lens: ${fundLens}${fundNote}. Frozen: entry at mark, stop 1.2× H4 ATR(14), TP +${RR}R, 7-day time-stop. Event-driven directional call, graded first-touch on published dollars.`,
  };
  try { window.localStorage.setItem(THESIS_DRAFT_KEY, JSON.stringify(draft)); } catch { /* private mode */ }
  try {
    window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "thesis" } }));
    window.dispatchEvent(new CustomEvent("nexus:thesis-draft"));
  } catch { /* non-browser — ignore */ }
  return true;
}

const CAT_LABEL: Record<string, string> = { RATES: "RATES", ECONOMY: "ECONOMY", CRYPTO_POLICY: "CRYPTO POLICY", GEOPOLITICS: "GEOPOLITICS", ELECTION: "ELECTION" };
const fmtVol = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`);
const fmtEnds = (iso: string | null) => { if (!iso) return null; const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };

function ImpactChip({ im, c, verdict }: { im: Impact; c: Catalyst; verdict?: Verdict }) {
  const col = im.direction === "LONG" ? C.pos : C.neg;
  // The gate (Grok): an impact can draft the frozen thesis ONLY when its coin has a funding
  // verdict object (⇒ live mark + deep tv/history for the H4 ATR stop, no invention). Else it
  // stays a calendar chip with no draft CTA — "not a trade yet."
  const canDraft = !!verdict && verdict.verdict !== "NONE";
  const [drafting, setDrafting] = useState(false);
  return (
    <div title={canDraft ? `Draft a graded thesis: ${im.coin} ${im.direction} — ${im.rationale}` : `${im.coin} has no funding verdict on the board — not a tradeable thesis yet`}
      style={{ display: "flex", alignItems: "center", gap: 8, background: C.inset, border: `1px solid ${C.border}`, borderLeft: `2px solid ${canDraft ? col : C.border}`, borderRadius: 5, padding: "7px 10px" }}>
      <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: C.text.bright, minWidth: 54 }}>{im.coin}</span>
      <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: col, letterSpacing: "0.04em" }}>{im.direction === "LONG" ? "▲ LONG" : "▼ SHORT"}</span>
      <span style={{ fontFamily: UI, fontSize: 11.5, color: C.text.fog, flex: 1, minWidth: 0 }}>{im.rationale}</span>
      {canDraft ? (
        <button onClick={async () => { if (drafting) return; setDrafting(true); const ok = await draftCatalyst(im, c, verdict!); if (!ok) setDrafting(false); }}
          className="nx-press"
          style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", color: C.accent, background: "none", border: `1px solid ${C.borderStrong}`, borderRadius: 4, padding: "4px 9px", cursor: "pointer", whiteSpace: "nowrap" }}>
          {drafting ? "drafting…" : "◆ DRAFT THESIS →"}
        </button>
      ) : (
        <span style={{ fontFamily: MONO, fontSize: 9, color: C.text.faint, whiteSpace: "nowrap" }} title="No funding verdict for this market — event stays a calendar chip until it can fill a frozen thesis">not a trade yet</span>
      )}
    </div>
  );
}

function CatalystCard({ c, verdicts }: { c: Catalyst; verdicts: Record<string, Verdict> }) {
  const ends = fmtEnds(c.endDate);
  const lensCol = c.riskLens === "RISK_ON" ? C.pos : c.riskLens === "RISK_OFF" ? C.neg : C.text.fog;
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surfaceAlt, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 11 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.1em", color: C.text.muted, border: `1px solid ${C.border}`, borderRadius: 3, padding: "1px 6px" }}>{CAT_LABEL[c.category] || c.category}</span>
        <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.08em", color: lensCol }}>{c.riskLens === "RISK_ON" ? "▲ RISK-ON" : "▼ RISK-OFF"}</span>
        <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9, color: C.text.faint }}>{fmtVol(c.volumeUsd)} vol{ends ? ` · ends ${ends}` : ""}</span>
      </div>

      <div style={{ fontFamily: UI, fontSize: 13.5, color: C.text.bright, lineHeight: 1.45 }}>{c.question}</div>

      {/* crowd probability — how priced it already is */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: C.text.muted }}>CROWD</span>
        <div style={{ flex: 1, height: 6, background: C.inset, border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: `${Math.max(2, Math.min(100, c.yesProbPct))}%`, height: "100%", background: C.accent, opacity: 0.8 }} />
        </div>
        <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: C.text.bright }}>{c.yesProbPct}% YES</span>
      </div>

      {/* tradeable impacts — the markets it moves, here */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {c.impacts.map((im, i) => <ImpactChip key={`${im.market}-${i}`} im={im} c={c} verdict={verdicts[im.coin.toUpperCase()]} />)}
      </div>
    </div>
  );
}

export function CatalystBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState(false);
  // The funding verdict per coin — the gate for drafting. From /signals (the SAME source The
  // Board reads), so a catalyst thesis and the funding read speak one verdict object. Fail-soft:
  // no verdicts ⇒ every impact reads "not a trade yet" (chip-only), never a fabricated draft.
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});

  useEffect(() => {
    let off = false;
    fetch(`${AGENT_API}/intel/catalysts-board`).then((r) => r.json())
      .then((d) => { if (!off) setBoard(d && Array.isArray(d.catalysts) ? d : { count: 0, catalysts: [] }); })
      .catch(() => { if (!off) setErr(true); });
    fetch(`${AGENT_API}/signals`).then((r) => r.json())
      .then((d) => {
        if (off) return;
        const m: Record<string, Verdict> = {};
        for (const s of (d?.signals || [])) {
          const coin = String(s.symbol || "").toUpperCase();
          if (coin && (s.verdict === "FADE" || s.verdict === "WATCH" || s.verdict === "NONE")) {
            m[coin] = { verdict: s.verdict, fadeDir: (s.fade_dir === "LONG" || s.fade_dir === "SHORT") ? s.fade_dir : "NONE", ann: Number(s.funding_annual_pct) || 0 };
          }
        }
        setVerdicts(m);
      })
      .catch(() => { /* no verdicts → all chips, honest */ });
    return () => { off = true; };
  }, []);

  return (
    <div>
      <SectionHeader eyebrow="CATALYSTS" title="World events → your trades" note="EVENT → A TRADE YOU CAN TAKE" />
      <div style={{ fontFamily: UI, fontSize: 13, color: C.text.fog, lineHeight: 1.6, maxWidth: 680, marginBottom: 14 }}>
        Liquid prediction-market events — rates, the economy, geopolitics — mapped to the markets they move on Nexus.
        A Strait-of-Hormuz de-escalation unwinds the crude risk premium → <b style={{ color: C.text.bright }}>short CL</b>; a rate cut lifts tech → <b style={{ color: C.text.bright }}>long NAS</b>.
        Where the moved market has a funding verdict on the board, one tap drafts a <b style={{ color: C.text.bright }}>frozen, graded thesis</b> (mark, 1.2× ATR stop, 1.5R, 7d, why = event + funding) — the rest stay event chips until they can. Not a signal.
      </div>

      {err || (board && board.catalysts.length === 0)
        ? <div style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint, padding: "10px 2px" }}>No tradeable catalysts on the board right now — quiet event tape.</div>
        : !board
        ? <div style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint, padding: "10px 2px" }}>reading the event tape…</div>
        : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12 }}>
            {board.catalysts.map((c, i) => <CatalystCard key={`${c.clobTokenId || c.question}-${i}`} c={c} verdicts={verdicts} />)}
          </div>
        )}
      <div style={{ fontFamily: MONO, fontSize: 8, color: C.text.faint, marginTop: 12, lineHeight: 1.5 }}>
        Event probabilities via Polymarket. Impact mapping is a transparent rule (not a black box), not a fair-value oracle. Not advice.
      </div>
    </div>
  );
}

export default CatalystBoard;
