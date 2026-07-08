// Cross-tab bridge: hand a partial agent config to the Agent tab and jump there.
// Mirrors the AI assistant's thesis-draft handoff (localStorage + ?tab= deep-link),
// so any surface — a thesis, a Market Intel signal, a feed call — can turn "here's
// an idea" into "the agent is set up for it" in one click. AgentView consumes the
// key on mount, merges it into the editor, and clears it.
import type { AgentConfig } from "@/pages/lab/types";

export const AGENT_PREFILL_KEY = "nexus_agent_prefill";

// Theses store a bare ticker ("BTC"); the agent/exec key everything by the Orderly
// perp symbol ("PERP_BTC_USDC"). Normalize at the handoff so signals/orders match.
export function toPerpSymbol(s: string): string {
  return s.startsWith("PERP_") ? s : `PERP_${s.toUpperCase()}_USDC`;
}

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
// Pass `navigate` (react-router's useNavigate) so the jump is CLIENT-SIDE — a full
// reload re-mounts OrderlyProvider and forces the wallet-reconnect/deposit intro,
// which is jarring mid-flow. Falls back to a hard nav only if navigate is absent.
export function deployToAgent(config: Partial<AgentConfig>, source?: string, notice?: string, navigate?: (to: string) => void) {
  try {
    const payload: AgentPrefill = { config, source, notice, ts: Date.now() };
    window.localStorage.setItem(AGENT_PREFILL_KEY, JSON.stringify(payload));
  } catch { /* ignore quota/availability */ }
  goAgentTab(navigate);
}

// Switch to the Lab's Agent tab. A client-side navigate is a NO-OP when the URL is
// already ?tab=agent (tab clicks change local state, not the URL — so it desyncs),
// which silently strands the user on the current tab. So we ALSO fire an event the
// Lab listens for to force the switch same-route; navigate still handles the
// cross-route case (mounting the Lab, which reads ?tab= on mount).
function goAgentTab(navigate?: (to: string) => void) {
  try { window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "agent" } })); } catch { /* ignore */ }
  const to = "/lab?tab=agent";
  if (navigate) navigate(to);
  else window.location.assign(to);
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
  const cfg: Partial<AgentConfig> = { symbols: [toPerpSymbol(t.symbol)] };
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

// ─── Directional directive bridge ("▶ TRADE managed") ────────────────────────
// The counterpart to the signal-watch handoff: this hands the agent the user's
// EXACT directional trade (direction honored verbatim). Writes a draft the Agent
// tab reviews → the user picks PAPER/AUTONOMOUS, signs, and POSTs /agent/:a/directive.
export const DIRECTIVE_PREFILL_KEY = "nexus_directive_prefill";

export type DirectiveDraft = {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryType?: "MARKET" | "LIMIT"; // MARKET fills now; LIMIT waits for entryPrice
  entryPrice: number;
  entryTolerancePct?: number;
  maxChasePct?: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2?: number;
  tp1SizePct?: number;
  leverage?: number;
  thesisId?: string;
  source?: string;
};

// Build a directive draft from a thesis and jump to the Agent tab to review + arm it.
// Pass `navigate` (useNavigate) for a client-side jump — see deployToAgent above.
export function deployDirectiveFromThesis(t: {
  id?: string; symbol: string; direction: "LONG" | "SHORT";
  entryPrice: number; stopLoss: number; takeProfit1: number; takeProfit2?: number; leverage?: number;
}, navigate?: (to: string) => void): void {
  const draft: DirectiveDraft = {
    symbol: toPerpSymbol(t.symbol),
    direction: t.direction,
    entryPrice: t.entryPrice,
    stopLoss: t.stopLoss,
    takeProfit1: t.takeProfit1,
    takeProfit2: t.takeProfit2 && t.takeProfit2 > 0 ? t.takeProfit2 : undefined,
    tp1SizePct: t.takeProfit2 && t.takeProfit2 > 0 ? 50 : undefined,
    leverage: t.leverage && t.leverage > 0 ? Math.round(t.leverage) : undefined,
    thesisId: t.id,
    source: "THESIS",
  };
  try { window.localStorage.setItem(DIRECTIVE_PREFILL_KEY, JSON.stringify({ draft, ts: Date.now() })); }
  catch { /* ignore quota/availability */ }
  goAgentTab(navigate);
}
