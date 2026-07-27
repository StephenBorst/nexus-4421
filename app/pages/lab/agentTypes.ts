// ── Agent-surface constants + local types ──
// Extracted from AgentView.tsx (god-file split). Kept separate from ./types (which
// holds the shared Lab domain model) because these are specific to the agent tab.

export const AGENT_API = "https://og.nexustradinglabs.com";

// The Telegram bot username for the alerts deep-link. ⚠️ Must match the bot whose
// token is set as TELEGRAM_TOKEN on the workers. Change here if it differs.
export const TG_BOT = "nexustradinglabs_bot";

export const AVAILABLE_SYMBOLS = [
  "PERP_BTC_USDC", "PERP_ETH_USDC", "PERP_SOL_USDC", "PERP_ARB_USDC",
  "PERP_HYPE_USDC", "PERP_ORDER_USDC", "PERP_AVAX_USDC", "PERP_XMR_USDC",
  "PERP_ZEC_USDC", "PERP_PUMP_USDC", "PERP_PENGU_USDC",
  "PERP_SPX500_USDC", "PERP_NAS100_USDC",
];

// The directional directive as returned by GET /agent/:address (read-only mirror).
export type ActiveDirective = {
  id: string; symbol: string; direction: "LONG" | "SHORT"; status: string;
  entryType?: "MARKET" | "LIMIT"; entryPrice: number; stopLoss: number; takeProfit1: number; takeProfit2?: number;
  tp1SizePct?: number; leverage?: number; validUntil?: number; filledPrice?: number; result?: string;
};

// This agent's own leaderboard standing (mirrors lab-api /agents/standing).
export type AgentStandingCriterion = { key: string; label: string; met: boolean; value: number; target: number };
export type AgentStanding = {
  eligible: boolean;
  metCount: number;
  total: number;
  criteria: AgentStandingCriterion[];
  stats: { trades: number; daysActive: number; winRate: number; netPnl: number; profitFactor: number; score: number; avgWin: number; avgLoss: number; firstTradeAt: number } | null;
};
