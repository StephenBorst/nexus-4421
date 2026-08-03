// ── THE MISPRICED BOARD — price every market, surface the gap ─────────────────
// Borrowed framing (Quotient signal.quotient.social): don't just list calls — price
// every market and surface where it diverges from FAIR, ranked so the sort order IS
// the signal. On a perp there's no oracle fair value, but the FUNDING rate is the
// crowd's mispricing made explicit: persistently positive funding = the book is
// lopsided long = a mean-revert (fade) edge to the SHORT side, and vice-versa. We
// annualize it into a comparable edge %/yr and flag the extreme tail MISPRICED ·
// WATCHING. Alongside the mechanical funding read we show the graded, credible
// CALLERS' lean (merit-weighted) — so a market reads as agreement, or the more
// interesting DIVERGENCE ("funding fade = SHORT, sharp callers lean LONG").
//
// Two independent fail-soft fetches: /intel/mispriced (fast, KV-cached market data)
// and /theses/consensus (the caller lean), merged by coin here on the client.
import { useEffect, useMemo, useState } from "react";
import { C, MONO, UI, RADIUS } from "@/config/theme";
import { AGENT_API } from "./agentTypes";
import { useIsMobile } from "./useIsMobile";
import { SectionHeader } from "./components";

type Market = {
  symbol: string; coin: string; markPrice: number;
  funding8hPct: number; fundingAnnualPct: number; oiUsd: number;
  change24hPct: number | null; direction: "LONG" | "SHORT" | "NONE";
  edge: number; status: "MISPRICED" | "PRICED_FAIR";
};
type BoardResp = { asOf?: string; scanned?: number; mispricedCount?: number; markets?: Market[] };
type Lean = { side: "LONG" | "SHORT" | "SPLIT"; lean: number; longCount: number; shortCount: number; participants: number };
type ConsensusResp = { consensus?: Record<string, Lean> };

const fmtUsd = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;
const fmtPrice = (n: number) => n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toPrecision(4);

// Direction chips are POSITIONING, not P&L — kept monochrome per the design law
// (green = profit only, red = loss only). Only the 24h price move uses pos/neg.
const dirChip = (dir: string): React.CSSProperties => ({
  fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
  padding: "2px 6px", borderRadius: RADIUS.sm, whiteSpace: "nowrap",
  color: dir === "NONE" || dir === "SPLIT" ? C.text.faint : C.text.bright,
  background: C.surface, border: `1px solid ${C.border}`,
});

export function MispricedBoard() {
  const isMobile = useIsMobile();
  const [board, setBoard] = useState<BoardResp | null>(null);
  const [lean, setLean] = useState<Record<string, Lean>>({});
  const [err, setErr] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => {
      fetch(`${AGENT_API}/intel/mispriced`).then((r) => r.json())
        .then((d: BoardResp) => { if (live) setBoard(d || {}); })
        .catch(() => { if (live) { setBoard({ markets: [] }); setErr(true); } });
      // Caller lean is a companion — its absence never blocks the board.
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
  const scanned = board?.scanned ?? 0;
  const mispricedCount = board?.mispricedCount ?? 0;

  return (
    <div>
      <SectionHeader
        eyebrow="// MISPRICED BOARD"
        title="Where the crowd is overpaying"
        note={scanned > 0 ? <span><span style={{ color: C.text.bright }}>{scanned}</span> scanned · <span style={{ color: C.accent }}>{mispricedCount}</span> mispriced</span> : "FUNDING-EDGE LENS"}
      />

      <p style={{ fontFamily: UI, fontSize: 13, color: C.text.fog, lineHeight: 1.6, maxWidth: 680, margin: "0 0 16px" }}>
        Funding is the crowd's mispricing made explicit. Positive funding means longs are paying to hold —
        the book is lopsided, and the mean-revert edge is to <b style={{ color: C.text.bright }}>fade it</b>. Annualized and
        ranked, so the top of the list is where positioning is most stretched right now. Beside each market:
        where the graded, credible callers actually lean.
      </p>

      {markets === null ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint, padding: "12px 2px" }}>loading board…</div>
      ) : markets.length === 0 ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.text.faint, padding: "12px 2px" }}>
          {err ? "Market data unavailable — retrying." : "No liquid markets to price right now."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Column header (desktop) */}
          {!isMobile && (
            <div style={{ display: "grid", gridTemplateColumns: "120px 96px 1fr 150px 128px", gap: 12, padding: "0 12px", alignItems: "center" }}>
              {["MARKET", "PRICE", "FUNDING EDGE (ANNUALIZED)", "FADE / STATUS", "SHARP CALLERS"].map((h) => (
                <span key={h} style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.12em", color: C.text.faint }}>{h}</span>
              ))}
            </div>
          )}
          {markets.map((m) => {
            const l = lean[m.coin];
            const mispriced = m.status === "MISPRICED";
            const barPct = Math.min(100, (m.edge / maxEdge) * 100);
            // Divergence: the funding fade and the sharp callers point opposite ways.
            const diverges = l && l.side !== "SPLIT" && m.direction !== "NONE" && l.side !== m.direction;
            return (
              <div key={m.symbol} style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "120px 96px 1fr 150px 128px",
                gap: isMobile ? 8 : 12, alignItems: "center",
                background: mispriced ? C.surface : C.inset,
                border: `1px solid ${mispriced ? C.borderStrong : C.border}`,
                borderLeft: `2px solid ${mispriced ? C.accent : "transparent"}`,
                borderRadius: RADIUS.md, padding: isMobile ? "10px 12px" : "9px 12px",
              }}>
                {/* Market */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: C.text.bright }}>{m.coin}</span>
                  <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.text.faint }}>{fmtUsd(m.oiUsd)} OI</span>
                </div>
                {/* Price + 24h */}
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: C.text.fog }}>${fmtPrice(m.markPrice)}</span>
                  {m.change24hPct != null && (
                    <span style={{ fontFamily: MONO, fontSize: 9, color: m.change24hPct >= 0 ? C.pos : C.neg }}>
                      {m.change24hPct >= 0 ? "+" : ""}{m.change24hPct}%
                    </span>
                  )}
                </div>
                {/* Funding edge bar */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 60, height: 5, background: C.inset, borderRadius: 3, overflow: "hidden", border: `1px solid ${C.border}` }}>
                    <div style={{ width: `${barPct}%`, height: "100%", background: mispriced ? C.accent : C.borderStrong, borderRadius: 3 }} />
                  </div>
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: mispriced ? C.text.bright : C.text.muted, minWidth: 54, textAlign: "right" }}>
                    {m.fundingAnnualPct >= 0 ? "+" : ""}{m.fundingAnnualPct}%
                  </span>
                </div>
                {/* Fade direction + status */}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {m.direction !== "NONE" && <span style={dirChip(m.direction)}>FADE {m.direction}</span>}
                  <span style={{
                    fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.06em", whiteSpace: "nowrap",
                    color: mispriced ? C.accent : C.text.faint,
                  }}>{mispriced ? "◆ WATCHING" : "PRICED FAIR"}</span>
                </div>
                {/* Sharp-callers lean */}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {l ? (
                    <>
                      <span style={dirChip(l.side)}>{l.side}</span>
                      <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.text.faint }}>{l.participants}</span>
                      {diverges && <span title="Funding fade and the sharp callers disagree" style={{ fontFamily: MONO, fontSize: 9, color: C.warn }}>⚡</span>}
                    </>
                  ) : (
                    <span style={{ fontFamily: MONO, fontSize: 9, color: C.text.faint }}>—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ fontFamily: MONO, fontSize: 9.5, color: C.text.faint, lineHeight: 1.6, marginTop: 16, letterSpacing: "0.02em" }}>
        Funding annualized (per-8h × 1095). |edge| ≥ 8%/yr on a market with ≥ $50k OI ⇒ MISPRICED · WATCHING.
        Caller lean is merit-weighted from open positions + active public calls. A read on positioning, not advice.
      </p>
    </div>
  );
}
