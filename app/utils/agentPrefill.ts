// Cross-tab bridge: hand a partial agent config to the Agent tab and jump there.
// Mirrors the AI assistant's thesis-draft handoff (localStorage + ?tab= deep-link),
// so any surface — a thesis, a Market Intel signal, a feed call — can turn "here's
// an idea" into "the agent is set up for it" in one click. AgentView consumes the
// key on mount, merges it into the editor, and clears it.
import type { AgentConfig } from "@/pages/lab/types";

export const AGENT_PREFILL_KEY = "nexus_agent_prefill";

export type AgentPrefill = {
  config: Partial<AgentConfig>;
  source?: string;
  // Optional persistent expectation the receiving tab surfaces as a dismissible
  // banner. Used to set correct expectations when the source's semantics differ
  // from the agent's (e.g. a directional thesis handed to a signal-driven bot).
  notice?: string;
  ts: number;
};

// Write the prefill and navigate to the Agent tab. `source` is shown in a toast so
// the user knows where the config came from ("from your BTC thesis"). `notice`, if
// given, is surfaced as a persistent banner explaining any semantic mismatch.
export function deployToAgent(config: Partial<AgentConfig>, source?: string, notice?: string) {
  try {
    const payload: AgentPrefill = { config, source, notice, ts: Date.now() };
    window.localStorage.setItem(AGENT_PREFILL_KEY, JSON.stringify(payload));
  } catch { /* ignore quota/availability */ }
  // Full navigation keeps this robust from any route (Lab tabs or the Feed).
  window.location.assign("/lab?tab=agent");
}

// Derive an agent config from a thesis. IMPORTANT: the agent is a funding/OI
// SIGNAL bot, not a directional order — it trades this SYMBOL when its own signal
// fires (possibly either direction), using the thesis TP/SL as risk bounds. So we
// carry over the risk GEOMETRY (TP/SL %, leverage) but deliberately NOT entry or
// direction, which the agent doesn't act on. capitalPerTrade is left to the user:
// the thesis's account size ≠ the agent's balance, and an oversized value trips
// Orderly -1101 (margin insufficient). thesisAgentNotice() sets the expectation.
export function thesisToAgentConfig(t: {
  symbol: string;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit1?: number;
  leverage?: number;
}): Partial<AgentConfig> {
  const cfg: Partial<AgentConfig> = { symbols: [t.symbol] };
  const e = t.entryPrice;
  if (e && e > 0) {
    if (t.takeProfit1 && t.takeProfit1 > 0) cfg.tpPercent = Math.round((Math.abs(t.takeProfit1 - e) / e) * 10000) / 100;
    if (t.stopLoss && t.stopLoss > 0) cfg.slPercent = Math.round((Math.abs(t.stopLoss - e) / e) * 10000) / 100;
  }
  // Carry the thesis's leverage as a starting point, clamped to the agent's band.
  if (t.leverage && t.leverage > 0) cfg.leverage = Math.max(1, Math.min(50, Math.round(t.leverage)));
  return cfg;
}

// The honest one-liner shown when a thesis is pushed to the agent. Prevents the
// "I wrote a LONG but the bot shorted me" trust break: the agent is signal-driven.
export function thesisAgentNotice(t: { symbol: string; direction?: string }): string {
  const tk = t.symbol.replace("PERP_", "").replace("_USDC", "");
  const dir = t.direction ? `${t.direction} ` : "";
  return `The agent trades ${tk} on funding/OI signals — it won't just place your ${dir}thesis as-is. It may enter EITHER direction when a signal fires, using your thesis TP/SL and leverage as risk bounds. Review the config below, then Save or Backtest before activating.`;
}
