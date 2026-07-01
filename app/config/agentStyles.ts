// Trading-style presets + taxonomy for the agent workbench.
//
// A "style" is really just hold-time + frequency + stop magnitude — all config
// params we already have. So style is a friendly on-ramp over the raw config AND
// the organizing axis for the strategy marketplace.
//
// HONEST SCOPE: the agent runs on a 1-min cron over hourly data with a funding
// edge, so its real home is DAY→SWING (exactly "the middle"). Scalping (secs–min)
// isn't backtestable on hourly data or executable on this cron — we don't fake it.
// Position trading (months) is buy-and-hold, not this tool.
import type { AgentConfig } from "@/pages/lab/types";

export type TradingStyle = "DAY" | "SWING";

export const STYLE_PRESETS: Record<TradingStyle, { label: string; blurb: string; config: Partial<AgentConfig> }> = {
  DAY: {
    label: "Day",
    blurb: "Hours, flat by day's end. Tighter stops, selective entries.",
    config: { maxHoldHours: 6, tpPercent: 1.5, slPercent: 0.75, maxTradesPerDay: 4, fundingThreshold: 0.02, signalMode: "CONFLUENCE" },
  },
  SWING: {
    label: "Swing",
    blurb: "Days-long holds. Wider targets, fewer higher-conviction entries.",
    config: { maxHoldHours: 72, tpPercent: 4, slPercent: 2, maxTradesPerDay: 2, fundingThreshold: 0.015, signalMode: "CONFLUENCE" },
  },
};

// The style a config expresses, keyed off hold time (the defining axis).
export function deriveStyle(config?: { maxHoldHours?: number }): "DAY" | "SWING" | "POSITION" {
  const h = config?.maxHoldHours ?? 0;
  if (h <= 8) return "DAY";
  if (h <= 120) return "SWING";
  return "POSITION"; // labeled for completeness; not a first-class preset
}
