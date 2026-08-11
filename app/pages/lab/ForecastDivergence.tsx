import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { THESIS_DRAFT_KEY } from "@/config/assistantTools";

// ── Forecast Divergence card (the prediction-market lens) ────────────────────
// Quotient-informed sibling of the Mispriced Board: reads the FORECASTING crowd
// (Polymarket) instead of the funding crowd, joins it to our tape, and — on
// near-money price-target markets — flags where the forecast lean disagrees with
// leveraged positioning. We never claim a fair probability; a divergence is a
// prompt to INVESTIGATE and to stake a GRADED thesis on the gap. Fail-soft:
// renders a quiet "no linked forecasts" line when the feed is sparse (by design).

const AGENT_API = "https://og.nexustradinglabs.com";
const BONE = "#ededf0", DIM = "#71717a", FAINT = "#52525b";
const WARN = "#fbbf24", POS = "#3ecf8e", NEG = "#f7525f";

interface ForecastMarket {
  id: string | null;
  coin: string;
  symbol: string | null;
  question: string;
  slug: string | null;
  forecastProbPct: number;
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
        background: "#141416", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 2, padding: "14px 16px",
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
                  <div key={m.id ?? m.question} style={{
                    border: `1px solid ${WARN}44`, background: "#1c1608", borderRadius: 2, padding: "10px 12px",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                      <span style={{ color: WARN, fontFamily: "var(--nx-font-mono)", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", border: `1px solid ${WARN}55`, borderRadius: 2, padding: "1px 6px" }}>◆ DIVERGENT</span>
                      <span style={{ color: BONE, fontFamily: "var(--nx-font-mono)", fontSize: 12, fontWeight: 700 }}>{m.coin}</span>
                      <span style={{ color: FAINT, fontSize: 10, fontFamily: "var(--nx-font-mono)" }}>{fmtPrice(m.markPrice)}</span>
                      {m.endDate ? <span style={{ color: FAINT, fontSize: 10, fontFamily: "var(--nx-font-mono)", marginLeft: "auto" }}>ends {fmtEnds(m.endDate)}</span> : null}
                    </div>
                    <div style={{ color: "#c4c4cc", fontSize: 12, lineHeight: 1.45, marginBottom: 8 }}>{m.question}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>
                      <span style={{ color: DIM }}>forecast <b style={{ color: BONE }}>{m.forecastProbPct}%</b> → lean <b style={{ color: leanColor(m.forecastLean) }}>{m.forecastLean}</b></span>
                      <span style={{ color: DIM }}>tape (funding) <b style={{ color: leanColor(m.fundingLean) }}>{m.fundingLean}</b></span>
                      {m.target != null ? <span style={{ color: DIM }}>{fmtPrice(m.target)} target ({m.distancePct}%)</span> : null}
                      <span style={{ color: FAINT }}>{fmtUsd(m.volumeUsd)} vol</span>
                      <button
                        type="button"
                        onClick={() => draftFrom(m)}
                        className="nx-press"
                        style={{ marginLeft: "auto", color: BONE, background: "transparent", border: "1px solid #33333a", borderRadius: 2, padding: "3px 10px", fontFamily: "var(--nx-font-mono)", fontSize: 10, cursor: "pointer" }}
                      >◆ draft thesis</button>
                    </div>
                  </div>
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
                      <span style={{ color: "#9a9aa2", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.question}</span>
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
