// Cross-tab bridge: hand a partial agent config to the Agent tab and jump there.
// Mirrors the AI assistant's thesis-draft handoff (localStorage + ?tab= deep-link),
// so any surface — a thesis, a Market Intel signal, a feed call — can turn "here's
// an idea" into "the agent is set up for it" in one click. AgentView consumes the
// key on mount, merges it into the editor, and clears it.
import type { AgentConfig } from "@/pages/lab/types";

export const AGENT_PREFILL_KEY = "nexus_agent_prefill";

export type AgentPrefill = { config: Partial<AgentConfig>; source?: string; ts: number };

// Write the prefill and navigate to the Agent tab. `source` is shown in a toast so
// the user knows where the config came from ("from your BTC thesis").
export function deployToAgent(config: Partial<AgentConfig>, source?: string) {
  try {
    const payload: AgentPrefill = { config, source, ts: Date.now() };
    window.localStorage.setItem(AGENT_PREFILL_KEY, JSON.stringify(payload));
  } catch { /* ignore quota/availability */ }
  // Full navigation keeps this robust from any route (Lab tabs or the Feed).
  window.location.assign("/lab?tab=agent");
}

// Derive TP/SL percents from a thesis's price levels so a manual plan becomes an
// agent risk profile. Returns only the fields it can compute.
export function thesisToAgentConfig(t: { symbol: string; entryPrice?: number; stopLoss?: number; takeProfit1?: number }): Partial<AgentConfig> {
  const cfg: Partial<AgentConfig> = { symbols: [t.symbol] };
  const e = t.entryPrice;
  if (e && e > 0) {
    if (t.takeProfit1 && t.takeProfit1 > 0) cfg.tpPercent = Math.round((Math.abs(t.takeProfit1 - e) / e) * 10000) / 100;
    if (t.stopLoss && t.stopLoss > 0) cfg.slPercent = Math.round((Math.abs(t.stopLoss - e) / e) * 10000) / 100;
  }
  return cfg;
}
