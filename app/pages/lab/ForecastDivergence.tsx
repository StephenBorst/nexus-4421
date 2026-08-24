import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { THESIS_DRAFT_KEY } from "@/config/assistantTools";
import { C } from "@/config/theme";
import { ProjectionBand } from "@/components/ProjectionBand";

// ── Forecast Divergence card (the prediction-market lens) ────────────────────
// Quotient-informed sibling of the Mispriced Board: reads the FORECASTING crowd
// (Polymarket) instead of the funding crowd, joins it to our tape, and — on
// near-money price-target markets — flags where the forecast lean disagrees with
// leveraged positioning. We never claim a fair probability; a divergence is a
// prompt to INVESTIGATE and to stake a GRADED thesis on the gap. Fail-soft:
// renders a quiet "no linked forecasts" line when the feed is sparse (by design).

const AGENT_API = "https://og.nexustradinglabs.com";
// Palette repointed to the canonical design tokens (app/config/theme.ts) — collapses
// the local-hex drift so this corner matches the Mispriced Board + the rest of the Lab.
const BONE = C.text.bright, DIM = C.text.muted, FAINT = C.text.faint;
const WARN = C.warn, POS = C.pos, NEG = C.neg;
const SURFACE = C.surface, BORDER = C.border, BORDER_STRONG = C.borderStrong, FOG = C.text.fog;

interface ForecastMarket {
  id: string | null;
  coin: string;
  symbol: string | null;
  question: string;
  slug: string | null;
  forecastProbPct: number;
  clobTokenId: string | null;
  volumeUsd: number;
  liquidityUsd: number;
  endDate: string | null;
  markPrice: number | null;
  target: number | null;
  targetDirection: "UP" | "DOWN" | null;
  distancePct: number | null;
  forecastLean: "UP" | "DOWN" | null;
  nearMoney: boolean | null;
  fundingLean: "UP" | "DOWN" | null;
  alignment: "ALIGNED" | "DIVERGENT" | null;
  divergence: boolean;
}

function fmtUsd(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}
function fmtPrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(n < 10 ? 3 : 2)}`;
}
function fmtEnds(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Lean → chip color: the FORECAST lean sides with the prediction crowd; UP/DOWN
// gets profit/loss chroma only as directional data (consistent with the P&L rule).
const leanColor = (l: string | null) => (l === "UP" ? POS : l === "DOWN" ? NEG : DIM);

// Client-side Orderly candle fetch (same public endpoint the Mispriced Board uses).
// Fail-soft: null until loaded, [] on error — the chart simply doesn't render.
function useOrderlyPrice(coin: string, days: number): { t: number; c: number }[] | null {
  const [price, setPrice] = useState<{ t: number; c: number }[] | null>(null);
  useEffect(() => {
    let live = true; setPrice(null);
    const to = Math.floor(Date.now() / 1000), from = to - days * 86400;
    fetch(`https://api-evm.orderly.org/tv/history?symbol=PERP_${coin}_USDC&resolution=60&from=${from}&to=${to}`)
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        if (d && d.s === "ok" && Array.isArray(d.t) && Array.isArray(d.c))
          setPrice(d.t.map((t: number, i: number) => ({ t: t * 1000, c: Number(d.c[i]) })).filter((p: { c: number }) => p.c > 0));
        else setPrice([]);
      })
      .catch(() => { if (live) setPrice([]); });
    return () => { live = false; };
  }, [coin, days]);
  return price;
}

// ── THE FORECAST CHART — the Quotient "Silver" view on our tape ────────────────
// Price over the window with the prediction market's TARGET drawn as a level (the
// forecast's "median"), the gap between price and target shaded (the implied move),
// a right-edge current-price value box, and date ticks. Honest: one target + one
// probability (we don't fake quartiles), colored by the forecast lean.
function ForecastChart({ coin, markPrice, target, forecastLean, forecastProbPct }: {
  coin: string; markPrice: number | null; target: number | null; forecastLean: string | null; forecastProbPct: number;
}) {
  const price = useOrderlyPrice(coin, 21);
  const pc = (price || []).filter((p) => Number.isFinite(p.c) && p.c > 0);
  if (pc.length < 2) return null;

  const VB_W = 440, padL = 3, gutterR = 62, plotW = VB_W - padL - gutterR;
  const top = 13, H = 150, plotBot = H - 18;
  const cs = pc.map((p) => p.c);
  const tgt = target != null && Number.isFinite(target) ? target : null;
  const mk = markPrice != null && Number.isFinite(markPrice) ? markPrice : cs[cs.length - 1];
  const vals = [...cs, mk]; if (tgt != null) vals.push(tgt);
  const lo = Math.min(...vals), hi = Math.max(...vals), sp = (hi - lo) || 1, pad = sp * 0.08;
  const py = (c: number) => plotBot - ((c - (lo - pad)) / ((hi + pad) - (lo - pad))) * (plotBot - top);
  const t0 = pc[0].t, t1 = pc[pc.length - 1].t, tspan = (t1 - t0) || 1;
  const X = (t: number) => padL + ((t - t0) / tspan) * plotW;
  const line = pc.map((p) => `${X(p.t).toFixed(1)},${py(p.c).toFixed(1)}`).join(" ");
  const area = `${line} L${X(t1).toFixed(1)},${plotBot} L${X(t0).toFixed(1)},${plotBot} Z`;
  const lastY = py(cs[cs.length - 1]);
  const tgtY = tgt != null ? py(tgt) : null;
  const lc = leanColor(forecastLean);
  const ticks = [0, 1, 2].map((i) => {
    const tt = t0 + (tspan * i) / 2;
    const anchor: "start" | "middle" | "end" = i === 0 ? "start" : i === 2 ? "end" : "middle";
    return { x: X(tt), label: new Date(tt).toLocaleDateString(undefined, { month: "short", day: "numeric" }), anchor };
  });
  const MF = "var(--nx-font-mono)";
  return (
    <svg viewBox={`0 0 ${VB_W} ${H}`} style={{ display: "block", width: "100%", height: "auto", margin: "2px 0 8px" }} role="img" aria-label={`${coin} price with the ${forecastProbPct}% forecast target level.`}>
      {/* implied-move zone: current price → forecast target */}
      {tgtY != null && <rect x={padL} y={Math.min(lastY, tgtY)} width={plotW} height={Math.abs(tgtY - lastY) || 1} fill={lc} opacity="0.08" />}
      <path d={area} fill={BONE} opacity="0.04" />
      <polyline points={line} fill="none" stroke={FOG} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
      {tgtY != null && <>
        <line x1={padL} y1={tgtY} x2={plotW} y2={tgtY} stroke={lc} strokeWidth="1" strokeDasharray="4 3" opacity="0.9" />
        <text x={padL + 2} y={tgtY - 3.5} fill={lc} fontFamily={MF} fontSize="7.5" fontWeight="700">TARGET {fmtPrice(tgt)} · {forecastProbPct}% {forecastLean}</text>
      </>}
      <circle cx={X(t1)} cy={lastY} r="2.5" fill={BONE} />
      <line x1={X(t1)} y1={lastY} x2={VB_W - gutterR} y2={lastY} stroke={BORDER_STRONG} strokeWidth="0.5" strokeDasharray="2 2" />
      <rect x={VB_W - gutterR} y={lastY - 8} width={gutterR - 6} height={16} rx="2" fill={SURFACE} stroke={BORDER_STRONG} />
      <text x={VB_W - gutterR + 4} y={lastY + 3.4} fill={BONE} fontFamily={MF} fontSize="8.5" fontWeight="700">{fmtPrice(cs[cs.length - 1])}</text>
      <line x1={padL} y1={plotBot + 4} x2={plotW} y2={plotBot + 4} stroke={BORDER} strokeWidth="0.75" />
      {ticks.map((tk, i) => <text key={i} x={Math.max(padL, Math.min(plotW, tk.x))} y={plotBot + 13} textAnchor={tk.anchor} fill={FAINT} fontFamily={MF} fontSize="7.5">{tk.label}</text>)}
    </svg>
  );
}

// ── FORECAST-PROBABILITY LINE — the crowd's conviction over time ──────────────
// Polymarket's YES probability plotted as a line (via /intel/events/history), paired
// under the price+target chart so you see BOTH the market and how belief is trending.
// 50% coin-flip midline, right-edge current-% box, date ticks, colored by the lean.
// Fail-soft: renders nothing while loading or if history is unavailable.
function ForecastProbLine({ token, lean, question }: { token: string | null; lean: string | null; question: string }) {
  const [hist, setHist] = useState<{ t: number; p: number }[] | null>(null);
  useEffect(() => {
    if (!token) { setHist([]); return; }
    let live = true; setHist(null);
    fetch(`${AGENT_API}/intel/events/history?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d) => { if (live) setHist(Array.isArray(d?.history) ? d.history.filter((x: { p: number }) => Number.isFinite(x.p)) : []); })
      .catch(() => { if (live) setHist([]); });
    return () => { live = false; };
  }, [token]);

  const h = (hist || []).filter((x) => Number.isFinite(x.p) && Number.isFinite(x.t));
  if (h.length < 4) return null; // loading or no series → the price chart already carries the card

  const c = leanColor(lean);
  const VB_W = 440, padL = 3, gutterR = 44, plotW = VB_W - padL - gutterR;
  const top = 12, H = 96, plotBot = H - 17;
  const ps = h.map((x) => x.p * 100);
  const lo = Math.max(0, Math.min(...ps) - 6), hi = Math.min(100, Math.max(...ps) + 6), sp = (hi - lo) || 1;
  const py = (v: number) => plotBot - ((v - lo) / sp) * (plotBot - top);
  const t0 = h[0].t, t1 = h[h.length - 1].t, tspan = (t1 - t0) || 1;
  const X = (t: number) => padL + ((t - t0) / tspan) * plotW;
  const line = h.map((x) => `${X(x.t).toFixed(1)},${py(x.p * 100).toFixed(1)}`).join(" ");
  const area = `${line} L${X(t1).toFixed(1)},${plotBot} L${X(t0).toFixed(1)},${plotBot} Z`;
  const lastPct = ps[ps.length - 1], lastY = py(lastPct);
  const mid = lo <= 50 && hi >= 50 ? py(50) : null;
  const chg = Math.round((lastPct - ps[0]) * 10) / 10;
  const ticks = [0, 1, 2].map((i) => {
    const tt = t0 + (tspan * i) / 2;
    const anchor: "start" | "middle" | "end" = i === 0 ? "start" : i === 2 ? "end" : "middle";
    return { x: X(tt), label: new Date(tt).toLocaleDateString(undefined, { month: "short", day: "numeric" }), anchor };
  });
  const MF = "var(--nx-font-mono)";
  return (
    <div style={{ margin: "0 0 8px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 1 }}>
        <span style={{ color: FAINT, fontFamily: MF, fontSize: 8.5, letterSpacing: "0.12em" }}>FORECAST PROBABILITY · YES</span>
        <span style={{ color: chg >= 0 ? POS : NEG, fontFamily: MF, fontSize: 8.5 }}>{chg >= 0 ? "+" : ""}{chg}pt · 30d</span>
      </div>
      <svg viewBox={`0 0 ${VB_W} ${H}`} style={{ display: "block", width: "100%", height: "auto" }} role="img" aria-label={`YES probability over time for: ${question}`}>
        {mid != null && <>
          <line x1={padL} y1={mid} x2={plotW} y2={mid} stroke={BORDER_STRONG} strokeWidth="0.75" strokeDasharray="3 4" />
          <text x={padL + 2} y={mid - 3} fill={FAINT} fontFamily={MF} fontSize="6.5" letterSpacing="0.5">50% · COIN-FLIP</text>
        </>}
        <path d={area} fill={c} opacity="0.07" />
        <polyline points={line} fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" opacity="0.92" />
        <circle cx={X(t1)} cy={lastY} r="2.5" fill={c} />
        <line x1={X(t1)} y1={lastY} x2={VB_W - gutterR} y2={lastY} stroke={BORDER_STRONG} strokeWidth="0.5" strokeDasharray="2 2" />
        <rect x={VB_W - gutterR} y={lastY - 8} width={gutterR - 6} height={16} rx="2" fill={SURFACE} stroke={c + "88"} />
        <text x={VB_W - gutterR + 4} y={lastY + 3.4} fill={c} fontFamily={MF} fontSize="8.5" fontWeight="700">{Math.round(lastPct)}%</text>
        <line x1={padL} y1={plotBot + 4} x2={plotW} y2={plotBot + 4} stroke={BORDER} strokeWidth="0.75" />
        {ticks.map((tk, i) => <text key={i} x={Math.max(padL, Math.min(plotW, tk.x))} y={plotBot + 13} textAnchor={tk.anchor} fill={FAINT} fontFamily={MF} fontSize="7.5">{tk.label}</text>)}
      </svg>
    </div>
  );
}

// One divergent market — the flagged signal, now with the premium price+target chart.
function DivergentCard({ m, onDraft }: { m: ForecastMarket; onDraft: (m: ForecastMarket) => void }) {
  return (
    <div style={{ border: `1px solid ${WARN}44`, background: "#1c1608", borderRadius: 2, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ color: WARN, fontFamily: "var(--nx-font-mono)", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", border: `1px solid ${WARN}55`, borderRadius: 2, padding: "1px 6px" }}>◆ DIVERGENT</span>
        <span style={{ color: BONE, fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700 }}>{m.coin}</span>
        <span style={{ color: FAINT, fontSize: 10, fontFamily: "var(--nx-font-mono)" }}>{fmtPrice(m.markPrice)}</span>
        {m.endDate ? <span style={{ color: FAINT, fontSize: 10, fontFamily: "var(--nx-font-mono)", marginLeft: "auto" }}>ends {fmtEnds(m.endDate)}</span> : null}
      </div>
      <div style={{ color: FOG, fontSize: 12, lineHeight: 1.45, marginBottom: 8 }}>{m.question}</div>
      <ForecastChart coin={m.coin} markPrice={m.markPrice} target={m.target} forecastLean={m.forecastLean} forecastProbPct={m.forecastProbPct} />
      <ForecastProbLine token={m.clobTokenId} lean={m.forecastLean} question={m.question} />
      {/* PROJECTION — the expected-move cone, a third independent forward lens next to the
          prediction-market forecast + the crypto tape. */}
      <div style={{ margin: "8px 0" }}>
        <ProjectionBand symbol={m.coin} height={196} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>
        <span style={{ color: DIM }}>forecast <b style={{ color: BONE }}>{m.forecastProbPct}%</b> → lean <b style={{ color: leanColor(m.forecastLean) }}>{m.forecastLean}</b></span>
        <span style={{ color: DIM }}>tape (funding) <b style={{ color: leanColor(m.fundingLean) }}>{m.fundingLean}</b></span>
        {m.target != null ? <span style={{ color: DIM }}>{fmtPrice(m.target)} target ({m.distancePct}%)</span> : null}
        <span style={{ color: FAINT }}>{fmtUsd(m.volumeUsd)} vol</span>
        <button type="button" onClick={() => onDraft(m)} className="nx-press"
          style={{ marginLeft: "auto", color: BONE, background: "transparent", border: `1px solid ${BORDER_STRONG}`, borderRadius: 2, padding: "3px 10px", fontFamily: "var(--nx-font-mono)", fontSize: 10, cursor: "pointer" }}
        >◆ draft thesis</button>
      </div>
    </div>
  );
}

export function ForecastDivergence() {
  const [markets, setMarkets] = useState<ForecastMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`${AGENT_API}/intel/forecasts`);
        const d = await r.json();
        if (!cancelled) setMarkets(Array.isArray(d?.markets) ? d.markets : []);
      } catch { if (!cancelled) setMarkets([]); }
      finally { if (!cancelled) setLoading(false); }
    };
    load();
    const iv = setInterval(load, 120_000); // 2-min poll (endpoint is KV-cached 5-min)
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  // Turn a divergence into a graded thesis: side with the forecasting crowd against
  // the offside tape. Pre-fills symbol/direction/entry/notes; the user sets risk.
  const draftFrom = (m: ForecastMarket) => {
    const dir = m.forecastLean === "UP" ? "LONG" : "SHORT";
    const draft = {
      symbol: m.coin,
      direction: dir,
      entryPrice: m.markPrice != null ? String(m.markPrice) : "",
      stopLoss: "",
      takeProfit1: "",
      notes: `Forecast divergence — Polymarket crowd leans ${m.forecastLean} (${m.forecastProbPct}% on "${m.question}") while funding leans ${m.fundingLean}. Thesis: the forecasters are right and the leveraged tape is offside.`,
      catalyst: "prediction-market divergence",
      targetWindow: m.endDate ? `by ${fmtEnds(m.endDate)}` : undefined,
    };
    try { window.localStorage.setItem(THESIS_DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
    navigate(`/lab?tab=thesis`);
    try {
      window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "thesis" } }));
      window.dispatchEvent(new CustomEvent("nexus:thesis-draft"));
    } catch { /* SSR — ignore */ }
  };

  const divergent = markets.filter((m) => m.divergence);
  const nearOther = markets.filter((m) => m.nearMoney && !m.divergence).slice(0, 4);
  const context = markets.filter((m) => !m.nearMoney).slice(0, 5);

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: FAINT, fontFamily: "var(--nx-font-mono)", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 5 }}>
          Forecasters vs the tape
        </div>
        <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: 19, fontWeight: 700, color: BONE, lineHeight: 1.1, letterSpacing: "-0.01em" }}>
          Forecast Divergence
        </div>
      </div>

      <div style={{
        background: "#141416", border: `1px solid ${BORDER}`, borderRadius: 2, padding: "14px 16px",
      }}>
        {loading ? (
          <div style={{ color: FAINT, fontSize: 11, fontFamily: "var(--nx-font-mono)" }}>Reading prediction markets…</div>
        ) : !markets.length ? (
          <div style={{ color: DIM, fontSize: 11, fontFamily: "var(--nx-font-mono)", lineHeight: 1.6 }}>
            No linked prediction markets right now — sparse by design (mostly BTC / ETH / SOL + major narratives).
          </div>
        ) : (
          <>
            {/* Flagged near-money divergences — the signal */}
            {divergent.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {divergent.map((m) => (
                  <DivergentCard key={m.id ?? m.question} m={m} onDraft={draftFrom} />
                ))}
              </div>
            ) : (
              <div style={{ color: DIM, fontSize: 11, fontFamily: "var(--nx-font-mono)", lineHeight: 1.6 }}>
                No forecast divergences right now — the forecasting crowd and the leveraged tape agree on the near-money strikes. Context below.
              </div>
            )}

            {/* Near-money agreements + far context — surfaced, not flagged */}
            {(nearOther.length > 0 || context.length > 0) && (
              <div style={{ marginTop: divergent.length ? 14 : 12, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10 }}>
                <div style={{ color: FAINT, fontSize: 9, fontFamily: "var(--nx-font-mono)", letterSpacing: "0.14em", marginBottom: 8 }}>CONTEXT · what the crowd is forecasting</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {[...nearOther, ...context].slice(0, 6).map((m) => (
                    <div key={m.id ?? m.question} style={{ display: "flex", alignItems: "baseline", gap: 8, fontFamily: "var(--nx-font-mono)", fontSize: 10, lineHeight: 1.4 }}>
                      <span style={{ color: BONE, fontWeight: 700, minWidth: 34 }}>{m.coin}</span>
                      <span style={{ color: BONE, minWidth: 40 }}>{m.forecastProbPct}%</span>
                      <span style={{ color: FOG, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.question}</span>
                      {m.alignment === "ALIGNED" ? <span style={{ color: POS, fontSize: 9 }}>aligned</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginTop: 12, color: FAINT, fontSize: 9, fontFamily: "var(--nx-font-mono)", lineHeight: 1.6 }}>
              Forecasts from Polymarket, joined to Orderly funding. A divergence = the forecasting crowd and leveraged positioning
              disagree on a near-money strike — a prompt to investigate, not a signal. Not a fair-value oracle. Not advice.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default ForecastDivergence;
