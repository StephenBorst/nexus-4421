// Deployable agent-strategy presets — the "Strategy Library", but executable.
// Each preset is a Partial<AgentConfig> a user can one-click load into the agent,
// review, and save. Presets set strategy + risk params only — they do NOT set
// `mode`, so loading preserves the user's current mode (PAPER / ASSISTED /
// AUTONOMOUS). PRO presets use advanced signal modes and are gated by useSubscription.
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
    id: "proven-edge",
    name: "Proven Edge ⭐",
    tag: "BACKTESTED",
    accent: "#00ff88",
    blurb: "Fade funding only when it hits a top-5% extreme vs its own history — then a breakeven stop makes the trade risk-free once it's +1%. The most selective setup we've backtested net-positive on BTC (profit factor ~1.2, fees in). Paper-test before going live.",
    config: {
      symbols: ["PERP_BTC_USDC"], signalMode: "FUNDING_ONLY", leverage: 5, capitalPerTrade: 50,
      tpPercent: 1.5, slPercent: 0.75, maxHoldHours: 4, maxTradesPerDay: 4, maxDailyLossUsdc: 5,
      fundingThreshold: 0.01, fundingPercentileMin: 95,
      // Breakeven at a LATE trigger (1.0% ≈ 0.66× the TP distance) — backtest showed
      // it lifts BTC net +3.5→+6.6 / PF 1.1→1.21 vs the flat exit and never hurt
      // in-sample (early triggers choke the fade like trailing does — 1.0 is the floor).
      breakevenTriggerPct: 1.0,
    },
  },
  {
    id: "funding-harvester",
    name: "Funding Harvester",
    tag: "CONSERVATIVE",
    accent: "#00ff88",
    blurb: "Fade funding + OI extremes on BTC only. Low leverage, tight caps — the slow-and-steady default.",
    config: {
      symbols: ["PERP_BTC_USDC"], signalMode: "CONFLUENCE", leverage: 3, capitalPerTrade: 30,
      tpPercent: 1.2, slPercent: 0.6, maxHoldHours: 6, maxTradesPerDay: 6, maxDailyLossUsdc: 10,
      fundingThreshold: 0.015, oiChangeThreshold: 0,
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
      fundingThreshold: 0.01,
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
      oiChangeThreshold: 0.5,
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
      maxDailyLossUsdc: 12, fundingThreshold: 0.008,
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
      maxDailyLossUsdc: 15, priceChangeThreshold: 0.6,
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
      priceChangeThreshold: 0.7,
    },
  },
];
