export type ThesisStatus = "ACTIVE" | "HIT_TP" | "STOPPED_OUT" | "INVALIDATED";

/** One append-only entry on a thesis's lifecycle timeline (app/lib/lifecycle.mjs). */
export interface ThesisUpdate {
  at: number;
  kind: "ADD" | "TRIM" | "STOP_MOVED" | "TARGET_MOVED" | "FLIP" | "CLOSED" | "NOTE";
  price?: number;
  sizePct?: number;
  note?: string;
}

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
  // Signal framing (borrowed from Quotient): a thesis becomes a "Signal" when it
  // names a near-term CATALYST (why the market may move to your levels NOW) and a
  // defined EXIT WINDOW (when you'll know you were right or wrong). Both optional +
  // free-text; they ride along in KV and surface on cards / Proof of Edge.
  catalyst?: string;      // the near-term "why now"
  targetWindow?: string;  // defined exit horizon — e.g. "7D", "48h", "by FOMC"
  // The historical base rate of this funding-fade setup AT THE MOMENT the call was made,
  // frozen so ticket honesty survives publish (Grok): "taken vs 25% hit · −0.88R · n=8". A
  // truthful, un-drifting record of the odds the trader faced — from /intel/baserate. If the
  // hist was weak, the card SAYS so, even for a call the trader chose to take anyway.
  baseRateAtEntry?: { hitRate: number; expectancyR: number; samples: number };
  createdAt: number;
  positionSize: number;
  leverage: number;
  riskReward: number;
  fundingCost8h: number;
  fundingCost24h: number;
  fundingCost72h: number;
  status: ThesisStatus;              // self-reported (legacy). Prefer effectiveStatus().
  gradedOutcome?: "WIN" | "LOSS";    // objective grade from public price (server-stamped)
  gradedR?: number;
  gradedAt?: number;
  actualPnl: number | null;
  // Append-only lifecycle timeline (add/trim/move stop/flip/close/note). See
  // app/lib/lifecycle.mjs. ⚠️ ADDITIVE ONLY — grading and the anchored call ledger
  // read the ORIGINAL levels above, never these, so an update can't re-grade a call.
  updates?: ThesisUpdate[];
  // Loss postmortem — WHY it lost, from the fixed taxonomy in app/lib/postmortem.mjs.
  // Self-reported introspection, so it never feeds the trustless leaderboard; it
  // powers the private leak profile + the anonymous community leak report.
  lossReason?: string;
  // Optional chart images (TradingView snapshot, X image, imgur). Traders reason in
  // charts and usually across timeframes — hence a list, capped at MAX_CHARTS.
  // ⚠️ User-supplied URLs: ALWAYS render via chartImageList()/chartImageSrc(), never
  // raw. See helpers.ts for why.
  chartUrls?: string[];
  /** @deprecated single-chart field from the first cut — read via chartImageList(). */
  chartUrl?: string;
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
export type TabId = "analytics" | "tradelog" | "thesis" | "copies" | "intel" | "agent" | "holders" | "quicktrade" | "smart" | "mispriced";

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
  fundingPercentileMin?: number; // 0=off; fade only when funding is ≥ this percentile vs its history
  volTargetPct?: number; // 0=off; volatility-targeted sizing — scale capital inversely to recent realized vol
  signalMode: "CONFLUENCE" | "FUNDING_ONLY" | "OI_ONLY" | "MOMENTUM" | "MEAN_REVERSION";
  oiChangeThreshold: number; // % min OI move for the OI-divergence rule to count (0 = any)
  priceChangeThreshold: number; // % price move on the tick that triggers MOMENTUM / MEAN_REVERSION
  respectRegime?: boolean; // opt-in: brain skips NEW entries that fight a strong market regime
  respectSmartMoney?: boolean; // opt-in: brain skips NEW entries that fight strong smart-money consensus
  invertSignal?: boolean; // opt-in: flip every entry to the OPPOSITE direction (fade a systematically-wrong signal)
  tradeSessions?: ("ASIA" | "EUROPE" | "US")[]; // opt-in regime gate: only enter in these UTC sessions (unset = all)
  minVolAtrPct?: number; // opt-in regime gate: only enter when recent ATR% ≥ this (fades want high vol)
  maxVolAtrPct?: number; // opt-in regime gate: only enter when recent ATR% ≤ this (mean-rev wants calm)
  maxSignalAgeSec?: number; // opt-in: skip a house signal older than this (fast edges revert — enter fresh or not at all). 0/unset = 10min hard cap only
  volScaledStops?: boolean; // opt-in: TP/SL scaled to each symbol's ATR instead of a flat %
  slAtrMult?: number;       // optional: stop = slAtrMult × ATR (default 1.0 in exec)
  // Multi-level take-profit ladder (scale-out). Unset = single 100% TP at tpPercent
  // (legacy). Ascending pct levels; sizePct = fraction of the original position.
  takeProfits?: { pct: number; sizePct: number }[];
  trailingStopPct?: number;  // 0/unset = off; trails the stop this % below peak P&L
  trailActivatePct?: number; // P&L% the trail arms at (default = first TP level)
  // Breakeven / "risk-free trade" stop. Once P&L reaches breakevenTriggerPct, the
  // stop latches up to entry + breakevenBufferPct — the trade can no longer close
  // at a real loss. 0/unset trigger = off.
  breakevenTriggerPct?: number;
  breakevenBufferPct?: number; // % above entry the stop locks to once armed (default 0)
  // DCA / safety-order mode (PRO). The whole ladder fits inside capitalPerTrade;
  // TP is taken off the blended average. dcaEnabled gates the behavior.
  dcaEnabled?: boolean;
  dca?: {
    maxSafetyOrders: number;       // how many averaging orders to allow
    safetyOrderStepPct: number;    // % adverse move to the first safety order
    safetyOrderStepScale: number;  // widen each subsequent step by this factor
    safetyOrderVolumeScale: number;// scale each safety order's size (martingale)
  };
  mode: "ASSISTED" | "AUTONOMOUS" | "PAPER";
  // Autocopy — trustless copy-trading. When enabled, a FLAT agent mirrors a followed
  // leader's currently-open position (symbol+direction), executed at THIS agent's own
  // mode/sizing/guardrails. Written through the normal config path; consumed by exec.
  autocopy?: { enabled: boolean; leaders: string[] };
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
  qty?: number;            // base units filled (older trades: absent)
  leverage?: number | null; // leverage used at entry (older trades: absent/null)
  pnl: number;
  pnl_percent?: number;    // P&L as % of margin
  reason: string;
  strategy?: string | null; // "DAY · FUNDING_ONLY" — stamped at entry (older trades: null)
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
  copiers?: number; // how many traders autocopy this agent (public social proof)
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
  maxTradesPerDay: 4, // selectivity wins — backtest showed high-frequency configs bleed out
  maxDailyLossUsdc: 5,
  fundingThreshold: 0.01,
  // ⭐ The one BACKTESTED net-positive config (60d BTC/ETH/SOL): FUNDING_ONLY +
  // fundingPercentileMin 95 → fade the crowd ONLY when funding is in its top 5%
  // most extreme vs history. Flipped the strategy from -$55 to +$22 (PF ~1.45,
  // 56% win). CONFLUENCE stays available (the flagship) and becomes backtestable
  // automatically once recorded oi:hist matures — the engine gates on OI coverage.
  fundingPercentileMin: 95,
  volTargetPct: 0, // off by default; >0 enables vol-targeted sizing (exec computes realized vol)
  signalMode: "FUNDING_ONLY",
  oiChangeThreshold: 0, // any OI move counts by default
  priceChangeThreshold: 0.5, // % tick move to trigger momentum / mean-reversion
  mode: "PAPER", // new users start in risk-free simulation by default
};
