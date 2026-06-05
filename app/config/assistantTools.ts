/**
 * Nexus AI Assistant — tool definitions (v2: read-only, agentic).
 *
 * Each tool is provider-agnostic: a name + description + JSON-schema input + an
 * async executor that fetches from Nexus/Orderly public endpoints and returns a
 * compact string the model reads. All v2 tools are READ-ONLY (no orders, no
 * writes) — safe to call autonomously, and they keep the "analysis not advice"
 * line clean. The browser calls these directly (same BYOK, no Nexus server).
 */

const ORDERLY_API = "https://api-evm.orderly.org";
const AGENT_API = "https://og.nexustradinglabs.com";

export interface ToolCtx {
  wallet: string | null;
}

export interface ToolDef {
  name: string;
  description: string;
  // JSON Schema for the input object.
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string>;
}

function normSymbol(raw: string): string {
  const s = (raw || "").toUpperCase().trim();
  if (s.startsWith("PERP_")) return s;
  return `PERP_${s.replace("-USD", "").replace("USDT", "").replace("USDC", "").replace(/[^A-Z0-9]/g, "")}_USDC`;
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_market",
    description:
      "Get live perp market data for a symbol on Nexus/Orderly: mark price, last funding rate (per 8h), open interest, and 24h volume. Use for any question about current price, funding, or OI of a coin.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker like BTC, ETH, SOL (or full PERP_BTC_USDC)." } },
      required: ["symbol"],
    },
    run: async (args) => {
      const sym = normSymbol(String(args.symbol ?? ""));
      const res = await fetch(`${ORDERLY_API}/v1/public/futures/${sym}`);
      if (!res.ok) return JSON.stringify({ error: `no market for ${sym} (${res.status})` });
      const d = (await res.json())?.data ?? {};
      return JSON.stringify({
        symbol: sym,
        mark_price: d.mark_price,
        last_funding_rate_8h: d.last_funding_rate,
        open_interest: d.open_interest,
        volume_24h: d["24h_amount"] ?? d.volume,
      });
    },
  },
  {
    name: "get_agent_status",
    description:
      "Get the connected user's autonomous trading agent: mode (PAPER/ASSISTED/AUTONOMOUS), active flag, current open position, daily counters, and recent trades. Use for 'what is my agent doing', performance, or status questions.",
    input_schema: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      if (!ctx.wallet) return JSON.stringify({ error: "wallet not connected" });
      const res = await fetch(`${AGENT_API}/agent/${ctx.wallet}`);
      if (!res.ok) return JSON.stringify({ error: `agent fetch failed (${res.status})` });
      const d = await res.json();
      const s = d?.state ?? {};
      const c = d?.config ?? {};
      return JSON.stringify({
        mode: c.mode,
        active: !!s.active,
        current_position: s.current_position ?? null,
        trades_today: s.trades_today ?? 0,
        daily_pnl: s.daily_pnl ?? 0,
        recent_paper_trades: (s.paper_trades ?? []).slice(0, 5),
      });
    },
  },
  {
    name: "get_top_agents",
    description:
      "Get the public TRUSTLESS autonomous-agent leaderboard: agents ranked by risk-adjusted score over their real on-chain-anchored trade ledger. Use to compare agent strategies or answer 'who are the top agents'.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const res = await fetch(`${AGENT_API}/agents/leaderboard`);
      if (!res.ok) return JSON.stringify({ error: `leaderboard failed (${res.status})` });
      const d = await res.json();
      const rows = (d?.leaderboard ?? d?.agents ?? d ?? []).slice?.(0, 10) ?? [];
      return JSON.stringify({ count: rows.length, leaderboard: rows });
    },
  },
  {
    name: "get_verified_callers",
    description:
      "Get the TRUSTLESS human-caller leaderboard: traders ranked by objectively-graded public thesis calls (first-touch TP-vs-SL vs public price), needing >=5 resolved calls. Use for 'best callers' or social-proof questions.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const res = await fetch(`${AGENT_API}/theses/leaderboard`);
      if (!res.ok) return JSON.stringify({ error: `callers leaderboard failed (${res.status})` });
      const d = await res.json();
      return JSON.stringify({ criteria: d?.criteria?.grading ?? null, leaderboard: (d?.leaderboard ?? []).slice(0, 10) });
    },
  },
];

export const TOOL_BY_NAME: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ── Provider-specific tool-schema shapes ──
export function anthropicTools() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}
export function openaiTools() {
  return TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}
