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
  // Client-side navigation (react-router). Action tools use this to take the
  // user somewhere — they never execute orders or move funds.
  navigate?: (path: string) => void;
  // The user's live open positions (from the Orderly private query in the
  // assistant component) — provided so the position tool needs no extra auth.
  openPositions?: { symbol: string; qty: number; entry: number; mark: number; pnl: number }[];
}

export const THESIS_DRAFT_KEY = "nexus_thesis_draft";

export interface ToolDef {
  name: string;
  description: string;
  // JSON Schema for the input object.
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string>;
}

// Bare ticker, e.g. "perp_btc_usdc" / "BTC-USD" → "BTC".
function shortTicker(raw: string): string {
  return (raw || "").toUpperCase().replace("PERP_", "").replace("_USDC", "").replace("-USD", "").replace("USDT", "").replace("USDC", "").replace(/[^A-Z0-9]/g, "");
}
// Full Orderly perp symbol, e.g. "BTC" → "PERP_BTC_USDC".
function normSymbol(raw: string): string {
  const t = shortTicker(raw);
  return t ? `PERP_${t}_USDC` : "";
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
    name: "get_open_positions",
    description:
      "Get the user's LIVE open perp positions on Nexus: symbol, signed size, entry price, mark price, and unrealized PnL. Use for 'my positions', 'how am I doing right now', live exposure/risk questions. (This is live exchange data, distinct from their planned theses.)",
    input_schema: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      const pos = ctx.openPositions ?? [];
      if (!pos.length) return JSON.stringify({ positions: [], note: "no open positions (or wallet not authenticated to Orderly)" });
      return JSON.stringify({ count: pos.length, positions: pos, total_unrealized_pnl: pos.reduce((s, p) => s + (p.pnl || 0), 0) });
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
    name: "get_market_regime",
    description:
      "Get the broad market regime signals: crypto Fear & Greed index (0-100 + classification), total market-cap 24h change, and BTC dominance. Use for 'how's the market', risk-on/risk-off, or sentiment questions.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const out: Record<string, unknown> = {};
      try {
        const fng = await (await fetch("https://api.alternative.me/fng/?limit=1")).json();
        const d = fng?.data?.[0];
        if (d) out.fear_greed = { value: Number(d.value), classification: d.value_classification };
      } catch { /* skip */ }
      try {
        const g = (await (await fetch("https://api.coingecko.com/api/v3/global")).json())?.data;
        if (g) {
          out.total_mcap_change_24h_pct = g.market_cap_change_percentage_24h_usd;
          out.btc_dominance_pct = g.market_cap_percentage?.btc;
          out.eth_dominance_pct = g.market_cap_percentage?.eth;
        }
      } catch { /* skip */ }
      if (!Object.keys(out).length) return JSON.stringify({ error: "regime data unavailable" });
      return JSON.stringify(out);
    },
  },
  {
    name: "get_trader",
    description:
      "Analyze a specific trader by wallet: their PUBLIC published theses and a win/loss summary (graded by status). Use when the user is viewing or asks about a trader's track record. Only public theses are returned.",
    input_schema: {
      type: "object",
      properties: { wallet: { type: "string", description: "0x… wallet address." } },
      required: ["wallet"],
    },
    run: async (args) => {
      const w = String(args.wallet ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return JSON.stringify({ error: "invalid wallet address" });
      const res = await fetch(`${AGENT_API}/feed`);
      if (!res.ok) return JSON.stringify({ error: `feed fetch failed (${res.status})` });
      const all = (await res.json())?.feed ?? [];
      const theses = all.filter((t: { wallet?: string }) => String(t.wallet ?? "").toLowerCase() === w.toLowerCase());
      const wins = theses.filter((t: { status?: string }) => t.status === "HIT_TP").length;
      const losses = theses.filter((t: { status?: string }) => t.status === "STOPPED_OUT").length;
      return JSON.stringify({
        wallet: w,
        public_theses: theses.length,
        wins, losses,
        win_rate_pct: wins + losses ? Math.round((wins / (wins + losses)) * 100) : null,
        theses: theses.slice(0, 15).map((t: Record<string, unknown>) => ({
          symbol: t.symbol, direction: t.direction, status: t.status, rr: t.riskReward, entry: t.entryPrice, pnl: t.actualPnl,
        })),
      });
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

// ── ACTION tools (client-side navigation + thesis drafting) ──
// Still ZERO order execution / fund movement — they only take the user somewhere
// or pre-fill a planning form. The user reviews & commits everything themselves.
TOOLS.push(
  {
    name: "open_symbol",
    description: "Open the live trading page for a perp symbol (chart + order ticket). Use when the user wants to look at or trade a coin. Does NOT place any order.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker like BTC, ETH, SOL." } },
      required: ["symbol"],
    },
    run: async (args, ctx) => {
      const sym = normSymbol(String(args.symbol ?? ""));
      ctx.navigate?.(`/perp/${sym}`);
      return JSON.stringify({ navigated: `/perp/${sym}`, note: "Opened the trading page. The user places any order themselves." });
    },
  },
  {
    name: "open_trader",
    description: "Open a trader's public profile (track record, theses, rep score) by wallet address.",
    input_schema: {
      type: "object",
      properties: { wallet: { type: "string", description: "0x… wallet address." } },
      required: ["wallet"],
    },
    run: async (args, ctx) => {
      const w = String(args.wallet ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return JSON.stringify({ error: "invalid wallet address" });
      ctx.navigate?.(`/feed/trader/${w}`);
      return JSON.stringify({ navigated: `/feed/trader/${w}` });
    },
  },
  {
    name: "open_leaderboard",
    description: "Open the social Feed (ranks / verified callers). Use for 'show me the leaderboard' or to browse public theses.",
    input_schema: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      ctx.navigate?.(`/feed`);
      return JSON.stringify({ navigated: "/feed" });
    },
  },
  {
    name: "draft_thesis",
    description:
      "Pre-fill the Nexus Thesis Engine with a trade plan (symbol, direction, entry, stop, take-profit, notes) and open it for the user to review. This DRAFTS a plan only — it never places an order; the user reviews, adjusts sizing/risk, and saves or executes themselves.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker like BTC, ETH, SOL." },
        direction: { type: "string", enum: ["LONG", "SHORT"] },
        entryPrice: { type: "number" },
        stopLoss: { type: "number" },
        takeProfit1: { type: "number" },
        notes: { type: "string", description: "Short rationale for the thesis." },
      },
      required: ["symbol", "direction", "entryPrice", "stopLoss", "takeProfit1"],
    },
    run: async (args, ctx) => {
      const dir = String(args.direction ?? "").toUpperCase();
      if (dir !== "LONG" && dir !== "SHORT") return JSON.stringify({ error: "direction must be LONG or SHORT" });
      const entry = Number(args.entryPrice), stop = Number(args.stopLoss), tp = Number(args.takeProfit1);
      if (![entry, stop, tp].every((n) => Number.isFinite(n) && n > 0)) return JSON.stringify({ error: "entry/stop/takeProfit must be positive numbers" });
      const draft = {
        symbol: shortTicker(String(args.symbol ?? "")), // form expects bare ticker (e.g. "BTC")
        direction: dir,
        entryPrice: String(entry),
        stopLoss: String(stop),
        takeProfit1: String(tp),
        notes: String(args.notes ?? ""),
      };
      try { window.localStorage.setItem(THESIS_DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
      ctx.navigate?.(`/lab?tab=thesis`);
      return JSON.stringify({ drafted: draft, note: "Opened the Thesis Engine pre-filled. The user reviews risk/size and saves or executes — no order was placed." });
    },
  }
);

export const TOOL_BY_NAME: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ── Provider-specific tool-schema shapes ──
export function anthropicTools() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}
export function openaiTools() {
  return TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}
