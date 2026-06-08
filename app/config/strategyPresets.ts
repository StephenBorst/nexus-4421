// Deployable agent-strategy presets — the "Strategy Library", but executable.
// Each preset is a Partial<AgentConfig> a user can one-click load into the agent,
// review, and save. All presets stay in PAPER mode for safety; the user opts into
// live. PRO presets use advanced signal modes and are gated by useSubscription.
import type { AgentConfig } from "@/pages/lab/types";

export interface StrategyPreset {
  id: string;
  name: string;
  tag: string;       // risk/style label
  accent: string;
  blurb: string;
  pro?: boolean;
  config: Partial<AgentConfig>;
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: "funding-harvester",
    name: "Funding Harvester",
    tag: "CONSERVATIVE",
    accent: "#00ff88",
    blurb: "Fade funding + OI extremes on BTC only. Low leverage, tight caps — the slow-and-steady default.",
    config: {
      symbols: ["PERP_BTC_USDC"], signalMode: "CONFLUENCE", leverage: 3, capitalPerTrade: 30,
      tpPercent: 1.2, slPercent: 0.6, maxHoldHours: 6, maxTradesPerDay: 6, maxDailyLossUsdc: 10,
      fundingThreshold: 0.015, oiChangeThreshold: 0, mode: "PAPER",
    },
  },
  {
    id: "blue-chip-confluence",
    name: "Blue-Chip Confluence",
    tag: "BALANCED",
    accent: "#4a9fff",
    blurb: "Confluence across BTC + ETH. Both funding and OI must agree — fewer, higher-quality entries.",
    config: {
      symbols: ["PERP_BTC_USDC", "PERP_ETH_USDC"], signalMode: "CONFLUENCE", leverage: 5, capitalPerTrade: 40,
      tpPercent: 1.5, slPercent: 0.75, maxHoldHours: 4, maxTradesPerDay: 8, maxDailyLossUsdc: 12,
      fundingThreshold: 0.01, mode: "PAPER",
    },
  },
  {
    id: "oi-divergence-hunter",
    name: "OI Divergence Hunter",
    tag: "BALANCED",
    accent: "#a855f7",
    blurb: "Trade open-interest divergence alone on BTC + ETH. Catches positioning unwinds funding misses.",
    config: {
      symbols: ["PERP_BTC_USDC", "PERP_ETH_USDC"], signalMode: "OI_ONLY", leverage: 5, capitalPerTrade: 40,
      tpPercent: 1.5, slPercent: 0.8, maxHoldHours: 4, maxTradesPerDay: 8, maxDailyLossUsdc: 12,
      oiChangeThreshold: 0.5, mode: "PAPER",
    },
  },
  {
    id: "funding-scalper",
    name: "Funding Scalper",
    tag: "AGGRESSIVE",
    accent: "#fbbf24",
    blurb: "Fast funding-only entries across BTC/ETH/SOL. Higher leverage, tight TP/SL, more trades/day.",
    config: {
      symbols: ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC"], signalMode: "FUNDING_ONLY", leverage: 8,
      capitalPerTrade: 30, tpPercent: 0.8, slPercent: 0.5, maxHoldHours: 2, maxTradesPerDay: 14,
      maxDailyLossUsdc: 12, fundingThreshold: 0.008, mode: "PAPER",
    },
  },
  {
    id: "momentum-rider",
    name: "Momentum Rider",
    tag: "PRO · TREND",
    accent: "#ff8800",
    pro: true,
    blurb: "Trade WITH a price move above threshold across majors. Rides strength — noisy, test in paper.",
    config: {
      symbols: ["PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC"], signalMode: "MOMENTUM", leverage: 8,
      capitalPerTrade: 40, tpPercent: 2, slPercent: 1, maxHoldHours: 4, maxTradesPerDay: 10,
      maxDailyLossUsdc: 15, priceChangeThreshold: 0.6, mode: "PAPER",
    },
  },
  {
    id: "mean-reversion-fade",
    name: "Mean Reversion Fade",
    tag: "PRO · FADE",
    accent: "#ff4c6a",
    pro: true,
    blurb: "Fade sharp moves on BTC + ETH — buy the dip, sell the rip above your price threshold.",
    config: {
      symbols: ["PERP_BTC_USDC", "PERP_ETH_USDC"], signalMode: "MEAN_REVERSION", leverage: 6, capitalPerTrade: 30,
      tpPercent: 1.5, slPercent: 1, maxHoldHours: 3, maxTradesPerDay: 10, maxDailyLossUsdc: 12,
      priceChangeThreshold: 0.7, mode: "PAPER",
    },
  },
];
