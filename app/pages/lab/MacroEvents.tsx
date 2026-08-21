import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { THESIS_DRAFT_KEY } from "@/config/assistantTools";

// ── Macro / Events card — the intelligence corner for event traders ──────────
// Sibling of Forecast Divergence, but for MACRO & geopolitical events (Fed, recession,
// war, ceasefires, elections, crypto policy) rather than asset price-targets. Reads the
// most liquid Polymarket markets, classifies the macro ones, and — where the relationship
// is textbook — attaches a directional RISK LENS (rate cut → risk-on, war → risk-off).
// We never claim a fair value or the crypto mapping: the lens is a starting point to
// stake a GRADED thesis and execute it on Nexus. This is the execution-layer seam an
// intelligence partner (macro-event discovery) plugs into. Fail-soft.

const AGENT_API = "https://og.nexustradinglabs.com";
const BONE = "#ededf0", DIM = "#71717a", FAINT = "#52525b";
const POS = "#3ecf8e", NEG = "#f7525f";

interface MacroEvent {
  id: string | null;
  question: string;
  category: "RATES" | "ECONOMY" | "GEOPOLITICS" | "CRYPTO_POLICY" | "ELECTION";
  riskLens: "RISK_ON" | "RISK_OFF" | null;
  actionable: boolean;
  yesProbPct: number;
  volumeUsd: number;
  liquidityUsd: number;
  endDate: string | null;
  slug: string | null;
}

const CAT_LABEL: Record<string, string> = {
  RATES: "RATES", ECONOMY: "ECONOMY", GEOPOLITICS: "GEO", CRYPTO_POLICY: "POLICY", ELECTION: "ELECTION",
};
function fmtUsd(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}
function fmtEnds(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}
// RISK_ON = crypto-supportive (treat as up/pos), RISK_OFF = headwind (down/neg) — directional data.
const lensColor = (l: string | null) => (l === "RISK_ON" ? POS : l === "RISK_OFF" ? NEG : DIM);
const lensLabel = (l: string | null) => (l === "RISK_ON" ? "RISK-ON" : l === "RISK_OFF" ? "RISK-OFF" : "—");

export function MacroEvents() {
  const [events, setEvents] = useState<MacroEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`${AGENT_API}/intel/events`);
        const d = await r.json();
        if (!cancelled) setEvents(Array.isArray(d?.events) ? d.events : []);
      } catch { if (!cancelled) setEvents([]); }
      finally { if (!cancelled) setLoading(false); }
    };
    load();
    const iv = setInterval(load, 120_000); // 2-min poll (endpoint is KV-cached 5-min)
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  // Express the macro view as a graded thesis. We default the crypto expression to BTC
  // (the macro-beta proxy) with the direction the lens implies — the trader changes the
  // symbol and sets the levels/risk. We never claim the mapping; it's their thesis.
  const draftFrom = (e: MacroEvent) => {
    const dir = e.riskLens === "RISK_ON" ? "LONG" : "SHORT";
    const draft = {
      symbol: "BTC",
      direction: dir,
      entryPrice: "",
      stopLoss: "",
      takeProfit1: "",
      notes: `Macro/event thesis — Polymarket: "${e.question}" at ${e.yesProbPct}% (${e.category}). Risk lens: ${lensLabel(e.riskLens)} → ${dir} the macro proxy (default BTC — change to your preferred expression). Your read: why does this resolve the way you think, and how does it move crypto?`,
      catalyst: e.question.length > 60 ? `${e.question.slice(0, 57)}…` : e.question,
      targetWindow: e.endDate ? `by ${fmtEnds(e.endDate)}` : undefined,
    };
    try { window.localStorage.setItem(THESIS_DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
    navigate(`/lab?tab=thesis`);
    try {
      window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "thesis" } }));
      window.dispatchEvent(new CustomEvent("nexus:thesis-draft"));
    } catch { /* SSR — ignore */ }
  };

  const actionable = events.filter((e) => e.actionable);
  const context = events.filter((e) => !e.actionable).slice(0, 6);

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: FAINT, fontFamily: "var(--nx-font-mono)", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 5 }}>
          What could move crypto
        </div>
        <div style={{ fontFamily: "var(--nx-font-serif)", fontSize: 19, fontWeight: 700, color: BONE, lineHeight: 1.1, letterSpacing: "-0.01em" }}>
          Macro &amp; Events
        </div>
      </div>

      <div style={{ background: "#141416", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 2, padding: "14px 16px" }}>
        {loading ? (
          <div style={{ color: FAINT, fontSize: 11, fontFamily: "var(--nx-font-mono)" }}>Reading the macro tape…</div>
        ) : !events.length ? (
          <div style={{ color: DIM, fontSize: 11, fontFamily: "var(--nx-font-mono)", lineHeight: 1.6 }}>
            No liquid macro events right now — check back; the board tracks the biggest Fed / geopolitical / policy markets.
          </div>
        ) : (
          <>
            {actionable.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {actionable.map((e) => (
                  <div key={e.id ?? e.question} style={{
                    border: `1px solid ${lensColor(e.riskLens)}33`, background: "#101012", borderRadius: 2, padding: "10px 12px",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                      <span style={{ color: lensColor(e.riskLens), fontFamily: "var(--nx-font-mono)", fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", border: `1px solid ${lensColor(e.riskLens)}55`, borderRadius: 2, padding: "1px 6px" }}>
                        {lensLabel(e.riskLens)}
                      </span>
                      <span style={{ color: FAINT, fontFamily: "var(--nx-font-mono)", fontSize: 8.5, letterSpacing: "0.1em", border: "1px solid #2a2a30", borderRadius: 2, padding: "1px 5px" }}>{CAT_LABEL[e.category] ?? e.category}</span>
                      {e.endDate ? <span style={{ color: FAINT, fontSize: 10, fontFamily: "var(--nx-font-mono)", marginLeft: "auto" }}>ends {fmtEnds(e.endDate)}</span> : null}
                    </div>
                    <div style={{ color: "#c4c4cc", fontSize: 12, lineHeight: 1.45, marginBottom: 8 }}>{e.question}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", fontFamily: "var(--nx-font-mono)", fontSize: 10 }}>
                      <span style={{ color: DIM }}>crowd <b style={{ color: BONE }}>{e.yesProbPct}%</b> yes</span>
                      <span style={{ color: FAINT }}>{fmtUsd(e.volumeUsd)} vol</span>
                      <button
                        type="button"
                        onClick={() => draftFrom(e)}
                        className="nx-press"
                        style={{ marginLeft: "auto", color: BONE, background: "transparent", border: "1px solid #33333a", borderRadius: 2, padding: "3px 10px", fontFamily: "var(--nx-font-mono)", fontSize: 10, cursor: "pointer" }}
                      >◆ draft thesis</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: DIM, fontSize: 11, fontFamily: "var(--nx-font-mono)", lineHeight: 1.6 }}>
                No actionable macro reads right now — the liquid events don't carry a clean directional lens. Context below.
              </div>
            )}

            {context.length > 0 && (
              <div style={{ marginTop: actionable.length ? 14 : 12, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10 }}>
                <div style={{ color: FAINT, fontSize: 9, fontFamily: "var(--nx-font-mono)", letterSpacing: "0.14em", marginBottom: 8 }}>CONTEXT · what the event crowd is pricing</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {context.map((e) => (
                    <div key={e.id ?? e.question} style={{ display: "flex", alignItems: "baseline", gap: 8, fontFamily: "var(--nx-font-mono)", fontSize: 10, lineHeight: 1.4 }}>
                      <span style={{ color: DIM, minWidth: 54 }}>{CAT_LABEL[e.category] ?? e.category}</span>
                      <span style={{ color: BONE, minWidth: 40 }}>{e.yesProbPct}%</span>
                      <span style={{ color: "#9a9aa2", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.question}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginTop: 12, color: FAINT, fontSize: 9, fontFamily: "var(--nx-font-mono)", lineHeight: 1.6 }}>
              Macro & geopolitical markets from Polymarket. The RISK-ON / RISK-OFF lens is a textbook directional read
              (risk-on = crypto-supportive), not a fair value and not advice — a prompt to stake a graded thesis. You pick the expression.
              {" "}
              <span onClick={() => navigate("/proof")} style={{ color: DIM, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>
                See who calls these right →
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default MacroEvents;
