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

const stanceLabel = (dir: string) => dir === "SHORT" ? "Crowd over-long" : dir === "LONG" ? "Crowd over-short" : "Balanced";

// Plain-English translation — the readability layer. A first-timer reads this; a pro
// reads the numbers above it. Both are true, neither is dumbed down.
const plainRead = (m: Market) => {
  const pct = Math.abs(m.fundingAnnualPct);
  if (m.direction === "SHORT") return `Traders are paying ${pct}%/yr to stay long ${m.coin} — the crowd is one-sided. That crowding usually unwinds, so the edge is to lean short.`;
  if (m.direction === "LONG") return `Shorts are paying ${pct}%/yr to stay short ${m.coin} — the crowd is one-sided the other way, so the edge is to lean long.`;
  return `${m.coin} funding is close to balanced — no clear crowd to fade right now.`;
};

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

export function MispricedBoard() {
  const isMobile = useIsMobile();
  const [board, setBoard] = useState<BoardResp | null>(null);
  const [lean, setLean] = useState<Record<string, Lean>>({});
  const [err, setErr] = useState(false);
  const [openCoin, setOpenCoin] = useState<string | null>(null);

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
  const draftFade = (m: Market) => {
    if (m.direction === "NONE") return;
    const crowd = m.direction === "SHORT" ? "long" : "short";
    const draft = {
      symbol: m.coin,
      direction: m.direction,
      catalyst: `Funding fade · ${m.fundingAnnualPct >= 0 ? "+" : ""}${m.fundingAnnualPct}%/yr, crowd offside ${crowd}`,
      notes: `Funding is ${m.funding8hPct}%/8h — the book is lopsided ${crowd}. Fading the crowd for the mean-revert; set your own entry, stop and target.`,
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
    return (
      <div>
        <button onClick={() => setOpenCoin(null)} className="nx-card-interactive" style={{
          display: "inline-flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em",
          color: C.text.muted, background: "none", border: `1px solid ${C.border}`, borderRadius: RADIUS.sm,
          padding: "6px 11px", cursor: "pointer", marginBottom: 16,
        }}>← BACK TO BOARD</button>

        <div style={{ display: isMobile ? "block" : "grid", gridTemplateColumns: "minmax(0,430px) 1fr", gap: 28, alignItems: "start" }}>
          {/* The card */}
          <div style={{ position: "relative", border: `1px solid ${C.border}`, borderLeft: `2px solid ${C.accent}`, borderRadius: RADIUS.lg, padding: 22, background: "linear-gradient(180deg,#17171a 0%,#0d0d0f 100%)", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: C.text.muted }}>
              <span style={{ color: C.text.fog }}>◆ Nexus · Funding edge</span>
              <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.08em", color: C.accent }}>◆ WATCHING</span>
            </div>
            <div style={{ fontFamily: UI, fontSize: 14, color: C.text.fog, marginTop: 18 }}>{m.coin} perpetual</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 1 }}>
              <span style={{ fontFamily: MONO, fontSize: 40, fontWeight: 600, color: C.text.bright, letterSpacing: "-0.02em", lineHeight: 1 }}>${fmtPrice(m.markPrice)}</span>
              {change != null && <span style={{ fontFamily: MONO, fontSize: 14, color: change >= 0 ? C.pos : C.neg }}>{change >= 0 ? "+" : ""}{change}% today</span>}
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
                  {m.fundingAnnualPct >= 0 ? "+" : ""}{m.fundingAnnualPct}%<span style={{ fontSize: 11, color: C.text.faint }}>/yr</span>
                </span>
              </div>
              <PositionBar m={m} maxEdge={maxEdge} big />
            </div>

            <p style={{ fontFamily: UI, fontSize: 13, lineHeight: 1.55, color: C.text.fog, marginTop: 14, padding: "11px 12px", background: "rgba(237,237,240,0.03)", border: `1px solid ${C.border}`, borderRadius: RADIUS.md }}>
              {plainRead(m)}
            </p>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontFamily: MONO, fontSize: 10 }}>
              <span style={{ color: C.text.faint, textTransform: "uppercase", letterSpacing: "0.12em", fontSize: 8.5 }}>Second opinion</span>
              <Callers m={m} lean={l} />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
              <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.text.faint }}>Live read · funding + open interest</span>
              <button onClick={() => draftFade(m)} className="nx-card-interactive" style={{
                marginLeft: "auto", fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em",
                color: C.accent, background: "none", border: `1px solid ${C.borderStrong}`, borderRadius: RADIUS.md, padding: "9px 15px", cursor: "pointer",
              }}>Draft this fade →</button>
            </div>
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
            <div style={{ fontFamily: MONO, fontSize: 9, color: C.text.faint, letterSpacing: "0.05em", marginTop: 4, lineHeight: 1.6 }}>
              Coming next: a funding-history line through the poles + what price did the last time it looked this stretched.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── BOARD — scan them all ────────────────────────────────────────────────────
  return (
    <div>
      <SectionHeader
        eyebrow="// MISPRICED BOARD"
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
                      style={{ position: "relative", border: `1px solid ${C.borderStrong}`, borderLeft: `2px solid ${C.accent}`, borderRadius: RADIUS.lg, padding: "16px 16px 14px", background: "linear-gradient(180deg,#161619 0%,#101012 100%)", cursor: "pointer", overflow: "hidden" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                        <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.text.bright }}>{m.coin}</span>
                        <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.text.faint }}>{fmtUsd(m.oiUsd)} open interest</span>
                        <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.08em", color: C.accent }}>WATCHING</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
                        <div>
                          <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: C.text.muted, marginBottom: 4 }}>Funding edge</div>
                          <div style={{ fontFamily: MONO, fontSize: 34, fontWeight: 600, color: C.text.bright, lineHeight: 0.9, letterSpacing: "-0.02em" }}>
                            {m.fundingAnnualPct >= 0 ? "+" : ""}{m.fundingAnnualPct}<span style={{ fontSize: 13, color: C.text.faint }}>%/yr</span>
                          </div>
                        </div>
                      </div>
                      <div style={{ margin: "14px 0 2px" }}><PositionBar m={m} maxEdge={maxEdge} /></div>
                      <p style={{ fontFamily: UI, fontSize: 12.5, lineHeight: 1.5, color: C.text.fog, marginTop: 12, padding: "9px 11px", background: "rgba(237,237,240,0.03)", border: `1px solid ${C.border}`, borderRadius: RADIUS.md }}>
                        {plainRead(m)}
                      </p>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, fontFamily: MONO, fontSize: 11, color: C.text.fog }}>
                        <span>${fmtPrice(m.markPrice)}</span>
                        {m.change24hPct != null && <span style={{ color: m.change24hPct >= 0 ? C.pos : C.neg }}>{m.change24hPct >= 0 ? "+" : ""}{m.change24hPct}% today</span>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}`, fontFamily: MONO, fontSize: 10 }}>
                        <span style={{ color: C.text.faint, textTransform: "uppercase", letterSpacing: "0.12em", fontSize: 8.5 }}>Top callers</span>
                        <Callers m={m} lean={l} />
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); draftFade(m); }} style={{
                        marginTop: 13, width: "100%", fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                        color: C.accent, border: `1px solid ${C.borderStrong}`, borderRadius: RADIUS.md, padding: 9, background: "transparent", cursor: "pointer",
                      }}>→ Draft this fade as a trade</button>
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
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.text.muted, textAlign: "right" }}>{m.fundingAnnualPct >= 0 ? "+" : ""}{m.fundingAnnualPct}%/yr</span>
                    <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.08em", color: C.text.faint, textAlign: "right" }}>FAIR</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <p style={{ fontFamily: MONO, fontSize: 9.5, color: C.text.faint, lineHeight: 1.6, marginTop: 18, letterSpacing: "0.02em" }}>
        Funding annualized (per-8h × 1095). |edge| ≥ 8%/yr on a market with ≥ $50k open interest ⇒ Mispriced · Watching; else priced fair.
        Caller lean is merit-weighted from open positions + active public calls. A read on positioning, not advice — a stretched market can stay stretched.
      </p>
    </div>
  );
}
