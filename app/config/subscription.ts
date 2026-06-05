/**
 * Nexus PRO — subscription / freemium model (single source of truth).
 *
 * Revenue strategy (kept clean re: Howey):
 *  - PRO is a SOFTWARE subscription — real business revenue, priced in USDC.
 *    Charging money for software is ordinary commerce, not a token-value scheme.
 *  - $NEXUS adds CONSUMPTIVE utility, not investment promises:
 *      • pay in $NEXUS → discount (genuine "use" of the token)
 *      • hold enough $NEXUS → PRO unlocked (access, the model we already run)
 *  - No revenue-share / dividends / staking-yield to holders (that's the
 *    security-maker line — do NOT add).
 *
 * ⚠️ TUNE: prices + the holder-unlock tier are product decisions — adjust freely.
 * ⚠️ PAYMENTS_LIVE stays false until the treasury receiving address + on-chain
 *    verification are wired (mirrors NEXUS_TREASURY_ADDRESS deferral).
 */

import type { NexusTier } from "@/hooks/useNexusTier";

export const PRO_MONTHLY_USDC = 20;          // USD/month, billed in USDC
export const NEXUS_PAY_DISCOUNT_PCT = 25;    // % off when paying in $NEXUS
export const PRO_HOLDER_TIER: NexusTier = "ARCHITECT"; // hold this tier → PRO free
export const PAYMENTS_LIVE = false;          // flip on when the USDC rail is wired

// Tier ranking for "hold X → unlock" comparisons.
export const TIER_RANK: Record<NexusTier, number> = {
  NONE: 0, OPERATOR: 1, ARCHITECT: 2, ORACLE: 3,
};

export type ProFeatureKey =
  | "agentStrategies"
  | "advancedAnalytics"
  | "priorityCopy"
  | "dataApi"
  | "unlimitedTheses"
  | "prioritySupport";

/** What PRO unlocks — the public benefits list (additive value, not paywalling core). */
export const PRO_FEATURES: { key: ProFeatureKey; label: string; desc: string }[] = [
  { key: "agentStrategies",   label: "Full agent arsenal",   desc: "All strategy modes, more concurrent agent slots & higher capital caps." },
  { key: "advancedAnalytics", label: "Advanced analytics",   desc: "Deeper breakdowns, exports, and longer history on your track record." },
  { key: "priorityCopy",      label: "Priority copy",        desc: "Early access to copy hot traders & top agents before slots fill." },
  { key: "dataApi",           label: "Verified data API",    desc: "Programmatic access to the trustless, on-chain-anchored leaderboard." },
  { key: "unlimitedTheses",   label: "Unlimited theses",     desc: "No cap on saved/published theses in the Nexus Thesis Engine." },
  { key: "prioritySupport",   label: "Priority support",     desc: "Front-of-line help + early access to new Lab features." },
];

export const nexusDiscountedPrice = () =>
  +(PRO_MONTHLY_USDC * (1 - NEXUS_PAY_DISCOUNT_PCT / 100)).toFixed(2);

/**
 * FREE vs PRO split (the spec gating reads from).
 *  FREE: Thesis Engine, paper agent w/ CORE strategies, Quick Trade, Feed,
 *        basic analytics — a genuinely useful free tier that attracts.
 *  PRO:  advanced agent strategies, deep analytics, data API, unlimited theses,
 *        priority copy.
 * Advanced (PRO-only) agent signal modes — the rest are free.
 */
export const PRO_AGENT_STRATEGIES = ["MOMENTUM", "MEAN_REVERSION"] as const;
export const isProStrategy = (mode: string) =>
  (PRO_AGENT_STRATEGIES as readonly string[]).includes(mode);
