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
        title="What the world is pricing"
        note="POLYMARKET · GRADED"
      />
      <div style={{ fontFamily: "var(--nx-font-ui, sans-serif)", fontSize: 13.5, color: C.text.fog, lineHeight: 1.65, maxWidth: 660, marginBottom: 4 }}>
        The forecasting crowd, not the funding crowd. Fed decisions, geopolitics, and policy — the biggest prediction markets, with a
        textbook risk-on / risk-off lens where it's earned. See a read you believe, draft it into a call, and let public price grade it.
        Not a fair-value oracle and not advice — the seam a macro-intelligence partner plugs into.
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
