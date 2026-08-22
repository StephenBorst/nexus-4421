import { SectionHeader } from "./components";
import { MacroEvents } from "./MacroEvents";
import { ForecastDivergence } from "./ForecastDivergence";
import { MacroCallers } from "./MacroCallers";
import { Collapsible } from "./Collapsible";
import { C } from "@/config/theme";

// ── MACRO tab — "what the world is pricing" ──────────────────────────────────
// The prediction-market / event lens, pulled out of Mispriced into its own premium
// surface (Phase 1 of the OBSERVE re-slice: Narrative → Positioning → Events). It reads
// the FORECASTING crowd (Polymarket) rather than the funding crowd: macro & geopolitical
// events with a directional risk lens, the crypto price-target divergence, and the
// trustless Macro Callers record beneath — the execution+grading seam a macro-intelligence
// partner plugs into.

export function MacroView() {
  return (
    <div>
      <SectionHeader
        eyebrow="MACRO & EVENTS"
        title="What could move crypto"
        note="INTELLIGENCE → A CRYPTO TRADE"
      />
      <div style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: 13.5, color: C.text.fog, lineHeight: 1.65, maxWidth: 660, marginBottom: 4 }}>
        Fed decisions, the economy, and crypto policy — the macro forces that move crypto, read as a textbook risk-on / risk-off lens.
        You don't trade the event here; you trade the <b style={{ color: C.text.bright }}>crypto expression</b> (BTC / ETH, long or short) on Nexus,
        and public price grades the call. The prediction market is the signal — the trade is one you can actually take. Not a fair-value oracle, not advice.
      </div>

      {/* the macro/geopolitical events board — the hero + the Quotient corner */}
      <MacroEvents />

      {/* trustless proof — who actually calls these right (kept visible; the differentiator) */}
      <div style={{ marginTop: 28, paddingTop: 4, borderTop: `1px solid ${C.border}` }}>
        <MacroCallers />
      </div>

      {/* the crypto price-target prediction lens — secondary, collapses under the events + proof */}
      <Collapsible title="◇ FORECAST DIVERGENCE" subtitle="crypto price-target markets — forecasters vs the leveraged tape" storageKey="nx_forecast_open">
        <ForecastDivergence />
      </Collapsible>
    </div>
  );
}

export default MacroView;
