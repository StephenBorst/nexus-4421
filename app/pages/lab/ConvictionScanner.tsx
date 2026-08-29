import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { C } from "@/config/theme";
import { rankConviction, convictionLevel } from "@/lib/conviction.mjs";

// ── CONVICTION SCANNER — the engine, market-wide ─────────────────────────────
// THE READ synthesizes ~12 orthogonal axes for ONE symbol you're drafting. This is
// the triage view over the whole board: for every funding-stretched market it tallies
// how many INDEPENDENT reads (funding fade + on-chain smart money + the graded caller
// crowd) point the SAME way, and ranks by agreement. The fade is only worth your
// attention where uncorrelated sources CONFIRM it — this surfaces those at a glance.
// Cheap by design: three cached batch endpoints, no per-coin fan-out. Click a row to
// draft the fade → THE READ shows the full multi-axis conviction for that symbol.

const AGENT_API = "https://og.nexustradinglabs.com";
const MONO = "var(--nx-font-mono)";

type Read = { label: string; ok: boolean; side?: "LONG" | "SHORT" };
type Row = { coin: string; direction: "LONG" | "SHORT"; fundingAnnualPct: number; extra: number; against: number; reads: Read[]; revertedPct: number | null; histWeak: boolean };

export function ConvictionScanner() {
  const [rows, setRows] = useState<Row[] | null>(null);
  // The BACKTEST base rate per coin (/intel/baserate) — the hist series the ticket/Quick Call
  // dock on (hit% · E[R] · n). The scanner's own edgeQuality is often UNPROVEN (reversion has
  // no data) while the backtest DOES (HYPE n=8 · 25% · −0.88R), so we must dock on THIS too —
  // else "♦ HIGH" survives on a −0.88R clock (Grok). Fetched for the ranked coins, cached 1h server-side.
  const [histMap, setHistMap] = useState<Record<string, { hitRate: number; expectancyR: number } | null>>({});
  const navigate = useNavigate();

  useEffect(() => {
    let off = false;
    const load = () => {
      Promise.all([
        fetch(`${AGENT_API}/intel/mispriced`).then((r) => r.json()).catch(() => null),
        fetch(`${AGENT_API}/smart/consensus`).then((r) => r.json()).catch(() => null),
        fetch(`${AGENT_API}/theses/consensus`).then((r) => r.json()).catch(() => null),
      ]).then(([mp, sm, cons]) => {
        if (off) return;
        // Shared ranker (same logic the copilot's get_conviction uses — one source of truth).
        setRows(rankConviction(mp?.markets || [], sm?.consensus || {}, cons?.consensus || {}, 8) as Row[]);
      }).catch(() => { if (!off) setRows([]); });
    };
    load();
    const id = setInterval(load, 60000);
    return () => { off = true; clearInterval(id); };
  }, []);

  // Pull the backtest base rate for whatever coins are on the board, so the diamond docks.
  useEffect(() => {
    if (!rows || !rows.length) return;
    let off = false;
    Promise.all(rows.map(async (r) => {
      try { const d = await (await fetch(`${AGENT_API}/intel/baserate/${r.coin}`)).json(); return [r.coin, d && d.available && Number.isFinite(d.hitRate) ? { hitRate: d.hitRate, expectancyR: d.expectancyR } : null] as const; }
      catch { return [r.coin, null] as const; }
    })).then((entries) => { if (!off) setHistMap(Object.fromEntries(entries)); });
    return () => { off = true; };
  }, [rows]);

  const draft = (r: Row) => {
    const crowd = r.direction === "SHORT" ? "long" : "short";
    const d = {
      symbol: r.coin, direction: r.direction,
      catalyst: `Funding fade · ${r.fundingAnnualPct >= 0 ? "+" : ""}${r.fundingAnnualPct}%/yr, crowd offside ${crowd}`,
      notes: `Multi-axis conviction scan flagged this fade. Open THE READ for the full breakdown; set your own entry, stop and target.`,
    };
    try { window.localStorage.setItem("nexus_thesis_draft", JSON.stringify(d)); } catch { /* private mode */ }
    try { window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "thesis" } })); window.dispatchEvent(new CustomEvent("nexus:thesis-draft")); } catch { /* ignore */ }
    navigate(`/lab?tab=thesis`);
  };

  if (rows === null) return <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.text.faint, padding: "8px 0" }}>Scanning the board…</div>;
  if (!rows.length) return null;

  const CONV: Record<string, { word: string; color: string }> = {
    HIGH: { word: "HIGH", color: C.pos },
    MODERATE: { word: "MODERATE", color: "#8fdcb8" },
    CONFLICTED: { word: "CONFLICTED", color: C.warn },
    FUNDING_ONLY: { word: "FUNDING-ONLY", color: C.text.muted },
  };
  const convOf = (r: Row) => CONV[convictionLevel(r)] || CONV.FUNDING_ONLY;

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: C.text.bright }}>◆ CONVICTION SCANNER</span>
        <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.text.faint, letterSpacing: "0.05em" }}>the engine, market-wide · funding × smart money × graded callers</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {rows.map((r) => {
          const conv = convOf(r);
          const dc = r.direction === "LONG" ? C.pos : C.neg;
          // Dock the diamond on EITHER hist clock (Grok): the backtest base rate (hit% · E[R])
          // OR the reversion. The backtest is the one that has HYPE's number (25% / −0.88R) when
          // reversion is UNPROVEN, so it's what kills "♦ HIGH" on a losing clock. Show its hit%.
          const bw = histMap[r.coin];
          const baseWeak = !!bw && (bw.hitRate < 40 || bw.expectancyR < 0);
          const histPct = baseWeak && bw ? bw.hitRate : r.revertedPct;
          const weak = baseWeak || r.histWeak;
          return (
            <button key={r.coin} onClick={() => draft(r)} style={{ appearance: "none", WebkitAppearance: "none", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", width: "100%", textAlign: "left", cursor: "pointer", background: C.surfaceAlt, border: `1px solid ${C.border}`, borderLeft: `2px solid ${weak ? C.warn : conv.color}`, borderRadius: 6, padding: "9px 12px" }}>
              <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.text.bright, minWidth: 52 }}>{r.coin}</span>
              {/* The verdict word (Grok): FADE LONG / FADE SHORT — not "↑ LONG". */}
              <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: dc, minWidth: 70 }}>{r.direction === "LONG" ? "FADE LONG" : "FADE SHORT"}</span>
              {/* A weak hist (backtest OR reversion) reads "HIST X%" amber, never ◆ HIGH. */}
              {weak && histPct != null
                ? <span title="Fading this has historically underperformed — can't read HIGH conviction" style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: C.warn, minWidth: 92 }}>HIST {histPct}%</span>
                : <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: conv.color, minWidth: 92 }}>◆ {conv.word}</span>}
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
                {r.reads.map((rd) => (
                  <span key={rd.label} title={!rd.ok && rd.side ? `${rd.label} lean ${rd.side} — opposes this ${r.direction} fade` : undefined} style={{ fontFamily: MONO, fontSize: 8.5, color: rd.ok ? C.pos : C.neg, border: `1px solid ${rd.ok ? "#2a3a30" : "#3a2530"}`, borderRadius: 3, padding: "1px 5px" }}>{rd.ok ? "✓" : "✗"} {rd.label}{!rd.ok && rd.side ? ` ${rd.side}` : ""}</span>
                ))}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.text.fog }}>{r.fundingAnnualPct >= 0 ? "+" : ""}{r.fundingAnnualPct}%/yr</span>
              <span style={{ fontFamily: MONO, fontSize: 9, color: C.accent }}>⚡ READ →</span>
            </button>
          );
        })}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 8, color: C.text.faint, marginTop: 7, lineHeight: 1.5 }}>Ranked by how many independent reads confirm the fade — open THE READ for the full breakdown. Not advice.</div>
    </div>
  );
}

export default ConvictionScanner;
