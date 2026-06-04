export type ThesisStatus = "ACTIVE" | "HIT_TP" | "STOPPED_OUT" | "INVALIDATED";

export interface ThesisTrade {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskPercent: number;
  accountSize: number;
  fundingRate: number;
  notes: string;
  createdAt: number;
  positionSize: number;
  leverage: number;
  riskReward: number;
  fundingCost8h: number;
  fundingCost24h: number;
  fundingCost72h: number;
  status: ThesisStatus;
  actualPnl: number | null;
  isPublic?: boolean;
  holdersOnly?: boolean; // shared to the $NEXUS Holders Room only (excluded from public feed)
  pfp?: string;
  displayName?: string;
  onChainId?: number;
  onChainTxHash?: string;
  copiedFromWallet?: string;
  copyCount?: number;
}

// ─── Lab view + agent types (extracted from index.tsx) ───────────────────────
export type TabId = "analytics" | "tradelog" | "thesis" | "copies" | "intel" | "agent" | "holders" | "quicktrade";

export interface DayGroup {
  pnl: number;
  trades: number;
  wins: number;
  tradeList: ProcessedTrade[];
}

export interface ProcessedTrade {
  symbol: string;
  direction: "LONG" | "SHORT";
  side: string;
  pnl: number;
  qty: number;
  price: number;
  entryPrice?: number;
  timestamp: number;
  openTimestamp?: number;
  leverage?: number;
}

export interface AgentConfig {
  symbols: string[];
  leverage: number;
  capitalPerTrade: number;
  tpPercent: number;
  slPercent: number;
  maxHoldHours: number;
  maxTradesPerDay: number;
  maxDailyLossUsdc: number;
  fundingThreshold: number;
  signalMode: "CONFLUENCE" | "FUNDING_ONLY" | "OI_ONLY";
  oiChangeThreshold: number; // % min OI move for the OI-divergence rule to count (0 = any)
  mode: "ASSISTED" | "AUTONOMOUS" | "PAPER";
}

export interface AgentState {
  active: boolean;
  daily_pnl: number;
  trades_today: number;
  paper_trades?: AgentTrade[];
  current_position: {
    symbol: string;
    direction: "LONG" | "SHORT";
    entry_price: number;
    current_price: number;
    pnl_percent: number;
    opened_at: number;
    paper?: boolean;
  } | null;
  last_signal: {
    symbol: string;
    direction: string;
    funding: number;
    confidence: number;
    timestamp: number;
  } | null;
}

export interface AgentTrade {
  id: string;
  symbol: string;
  direction: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  reason: string;
  opened_at: string;
  closed_at: string;
}

export interface AgentLeaderboardEntry {
  rank: number;
  wallet: string;
  displayName: string | null;
  pfp: string | null;
  trades: number;
  winRate: number;
  netPnl: number;
  profitFactor: number;
  daysActive: number;
  score: number;
  config: Partial<AgentConfig> | null;
}

export interface AgentPendingThesis {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  confidence: number;
  funding: number;
  source: string;
  generatedAt: number;
  status: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  symbols: ["PERP_BTC_USDC"],
  leverage: 5,
  capitalPerTrade: 50,
  tpPercent: 1.5,
  slPercent: 0.75,
  maxHoldHours: 4,
  maxTradesPerDay: 10,
  maxDailyLossUsdc: 5,
  fundingThreshold: 0.01,
  signalMode: "CONFLUENCE", // validated default — both funding + OI must agree
  oiChangeThreshold: 0, // any OI move counts by default
  mode: "PAPER", // new users start in risk-free simulation by default
};
