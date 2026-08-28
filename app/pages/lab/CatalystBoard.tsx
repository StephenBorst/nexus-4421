// ── CATALYST READ — world events → the Nexus markets you can trade ───────────
// The event layer of the engine. Liquid Polymarket macro/geopolitical markets, mapped
// to the LISTED markets they move here: oil-region geopolitics → CL (crude), rates →
// NAS, risk-on/off → BTC/SPX. The crowd probability shows how PRICED it already is. A
// setup to stake a graded thesis + execute here — not a fair-value oracle, not advice.
import { useEffect, useState } from "react";
import { SectionHeader } from "./components";
import { C } from "@/config/theme";
import { AGENT_API } from "./agentTypes";

const MONO = "var(--nx-font-mono)";
const UI = "var(--nx-font-ui, sans-serif)";

type Impact = { coin: string; market: string; direction: "LONG" | "SHORT"; rationale: string };
type Catalyst = { question: string; category: string; riskLens: string; yesProbPct: number; volumeUsd: number; endDate: string | null; clobTokenId: string | null; impacts: Impact[] };
type Board = { asOf?: string; count: number; catalysts: Catalyst[]; note?: string };

const CAT_LABEL: Record<string, string> = { RATES: "RATES", ECONOMY: "ECONOMY", CRYPTO_POLICY: "CRYPTO POLICY", GEOPOLITICS: "GEOPOLITICS", ELECTION: "ELECTION" };
const fmtVol = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`);
const fmtEnds = (iso: string | null) => { if (!iso) return null; const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };

function ImpactChip({ im }: { im: Impact }) {
  const col = im.direction === "LONG" ? C.pos : C.neg;
  return (
    <a href={`/perp/${im.market}`} title={`Trade ${im.coin} on Nexus — ${im.rationale}`}
      style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none", background: C.inset, border: `1px solid ${C.border}`, borderLeft: `2px solid ${col}`, borderRadius: 5, padding: "7px 10px" }}>
      <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: C.text.bright, minWidth: 54 }}>{im.coin}</span>
      <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: col, letterSpacing: "0.04em" }}>{im.direction === "LONG" ? "▲ LONG" : "▼ SHORT"}</span>
      <span style={{ fontFamily: UI, fontSize: 11.5, color: C.text.fog, flex: 1, minWidth: 0 }}>{im.rationale}</span>
      <span style={{ fontFamily: MONO, fontSize: 9, color: C.text.faint, whiteSpace: "nowrap" }}>TRADE →</span>
    </a>
  );
}

function CatalystCard({ c }: { c: Catalyst }) {
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
        {c.impacts.map((im, i) => <ImpactChip key={`${im.market}-${i}`} im={im} />)}
      </div>
    </div>
  );
}

export function CatalystBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let off = false;
    fetch(`${AGENT_API}/intel/catalysts-board`).then((r) => r.json())
      .then((d) => { if (!off) setBoard(d && Array.isArray(d.catalysts) ? d : { count: 0, catalysts: [] }); })
      .catch(() => { if (!off) setErr(true); });
    return () => { off = true; };
  }, []);

  return (
    <div>
      <SectionHeader eyebrow="CATALYSTS" title="World events → your trades" note="EVENT → A TRADE YOU CAN TAKE" />
      <div style={{ fontFamily: UI, fontSize: 13, color: C.text.fog, lineHeight: 1.6, maxWidth: 680, marginBottom: 14 }}>
        Liquid prediction-market events — rates, the economy, geopolitics — mapped to the markets they move on Nexus.
        A Strait-of-Hormuz de-escalation unwinds the crude risk premium → <b style={{ color: C.text.bright }}>short CL</b>; a rate cut lifts tech → <b style={{ color: C.text.bright }}>long NAS</b>.
        The crowd probability shows how priced it already is. A setup to stake a graded thesis and <b style={{ color: C.text.bright }}>execute here</b> — not a signal.
      </div>

      {err || (board && board.catalysts.length === 0)
        ? <div style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint, padding: "10px 2px" }}>No tradeable catalysts on the board right now — quiet event tape.</div>
        : !board
        ? <div style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint, padding: "10px 2px" }}>reading the event tape…</div>
        : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12 }}>
            {board.catalysts.map((c, i) => <CatalystCard key={`${c.clobTokenId || c.question}-${i}`} c={c} />)}
          </div>
        )}
      <div style={{ fontFamily: MONO, fontSize: 8, color: C.text.faint, marginTop: 12, lineHeight: 1.5 }}>
        Event probabilities via Polymarket. Impact mapping is a transparent rule (not a black box), not a fair-value oracle. Not advice.
      </div>
    </div>
  );
}

export default CatalystBoard;
