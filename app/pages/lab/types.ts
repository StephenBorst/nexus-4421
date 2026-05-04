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
  pfp?: string;
  displayName?: string;
  onChainId?: number;       // thesisId returned by ThesisRegistry contract on Arbitrum
  onChainTxHash?: string;   // tx hash of the registerThesis() call
}
