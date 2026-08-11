/**
 * Nexus AI Assistant — tool definitions (v2: read-only, agentic).
 *
 * Each tool is provider-agnostic: a name + description + JSON-schema input + an
 * async executor that fetches from Nexus/Orderly public endpoints and returns a
 * compact string the model reads. All v2 tools are READ-ONLY (no orders, no
 * writes) — safe to call autonomously, and they keep the "analysis not advice"
 * line clean. The browser calls these directly (same BYOK, no Nexus server).
 */

import { deployDirectiveFromThesis } from "@/utils/agentPrefill";
// Same synthesis the Lab renders — the copilot must speak with ONE point of view,
// not answer from an older, narrower readout while the terminal shows another.
import { buildOperatorProfile, profileNarrative } from "@/lib/operatorProfile.mjs";

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
  // Pre-computed realized-performance summary (from /v1/position_history).
  performance?: Record<string, unknown> | null;
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
    name: "explain_move",
    description:
      "Explain WHY a market may be moving. Returns the live move (24h % change, funding, OI, volume) plus recent NEWS HEADLINES for that specific asset (works for crypto, commodities like CL/WTI crude or GC/gold, and equities). Use for 'why is oil pumping', 'what's moving BTC', 'why is X dumping'. IMPORTANT when you answer: the headlines are CANDIDATE context, not proven causes — synthesize the most likely drivers, CITE the specific headlines you used (by title), and frame it as a hypothesis ('possible drivers'), never as confirmed causation. If nothing relevant is in the headlines, say the move isn't clearly explained by current news rather than inventing a reason. Offer to draft a thesis from the read.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker like BTC, CL (WTI crude), GC (gold), SOL." } },
      required: ["symbol"],
    },
    run: async (args) => {
      const t = shortTicker(String(args.symbol ?? ""));
      if (!t) return JSON.stringify({ error: "symbol required" });
      const res = await fetch(`${AGENT_API}/intel/catalysts/${t}`);
      if (!res.ok) return JSON.stringify({ error: `catalyst fetch failed for ${t} (${res.status})` });
      const d = await res.json();
      type HL = { title: string; source: string; link: string; pubDate: string };
      // Headlines are fetched HERE, in the browser (per-user IP), NOT in the worker:
      // rss2json blocks Cloudflare Worker IPs, so /intel/catalysts returns only the live
      // `move` + meta and leaves the news to us. ⚠ We do NOT use Google News search —
      // rss2json fetches that feed but extracts ZERO items from it (can't parse Google's
      // RSS). It DOES parse CoinTelegraph's per-asset TAG feeds, which are the real
      // asset-specific source (verified 10 relevant items each for BTC/ETH/SOL).
      const rss = async (u: string) => { try { return await (await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(u)}`)).json(); } catch { return null; } };
      const toHL = (items: { title?: string; link?: string; pubDate?: string }[], source: string): HL[] =>
        (items ?? []).map((it) => ({ title: String(it.title ?? "").trim(), source, link: it.link ?? "", pubDate: it.pubDate ?? "" })).filter((h) => h.title);
      let headlines: HL[] = [];
      try {
        if (d.assetClass === "crypto" && d.name) {
          // CoinTelegraph per-asset tag feed, e.g. .../rss/tag/ethereum
          const tag = String(d.name).toLowerCase().replace(/\s+/g, "-");
          const nd = await rss(`https://cointelegraph.com/rss/tag/${tag}`);
          if (nd?.status === "ok" && nd.items?.length) headlines = toHL(nd.items, "Cointelegraph").slice(0, 6);
        }
        if (!headlines.length) {
          // Non-crypto (or a crypto tag miss): filter the broad finance/crypto feeds by
          // the asset name/ticker. Thinner coverage, but honest — empty → AI says the
          // move isn't clearly explained by current news rather than inventing one.
          const BROAD = [
            { u: "https://finance.yahoo.com/news/rssindex", s: "Yahoo Finance" },
            { u: "https://www.coindesk.com/arc/outboundfeeds/rss/", s: "CoinDesk" },
            { u: "https://cointelegraph.com/rss", s: "Cointelegraph" },
          ];
          const results = await Promise.all(BROAD.map((f) => rss(f.u)));
          const terms = [d.name, d.ticker].filter(Boolean).map((s: string) => String(s).toLowerCase()).filter((s) => s.length >= 2);
          if (terms.length) {
            const rx = new RegExp(`\\b(${terms.map((s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
            const all = results.flatMap((nd, i) => (nd?.status === "ok" && Array.isArray(nd.items) ? toHL(nd.items, BROAD[i].s) : []));
            headlines = all.filter((h) => rx.test(`${h.title} ${h.source}`)).slice(0, 6);
          }
        }
      } catch { /* fail-soft — return move-only */ }
      return JSON.stringify({
        asset: d.name, ticker: d.ticker, assetClass: d.assetClass,
        move: d.move, headlines,
        guidance: d.note ?? "Headlines are candidate context, not confirmed causes.",
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
    name: "get_my_performance",
    description:
      "Get the user's REALIZED trading track record from their closed trades on Nexus: win rate, total PnL, best/worst trade, and per-symbol breakdown. Use for 'how have I been trading', 'review my performance', 'what am I doing wrong', or any coaching on their actual results (distinct from planned theses or live positions).",
    input_schema: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      if (!ctx.performance) return JSON.stringify({ error: "no closed trades found (or wallet not authenticated to Orderly)" });
      return JSON.stringify(ctx.performance);
    },
  },
  {
    name: "get_my_edge",
    description:
      "Get the user's PERSONALIZED EDGE — a coach's read derived purely from their own realized results: which symbols and which direction (long vs short) they actually make money on, and where they bleed, with per-symbol win rate + avg PnL. Use for 'what am I good at', 'where's my edge', 'what should I stop trading', or to ground any coaching in the user's real record (not vibes). Respect the sample_note (small samples are directional, not conclusive), and keep to analysis — never a 'trade this now' instruction.",
    input_schema: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      const edge = (ctx.performance as { edge?: unknown } | null)?.edge;
      if (!edge) return JSON.stringify({ error: "no closed trades yet — an edge readout needs a realized record (or wallet not authenticated to Orderly)" });
      return JSON.stringify(edge);
    },
  },
  {
    name: "get_operator_profile",
    description:
      "Get the OPERATOR PROFILE — the Lab's single synthesized read of a trader, and the RIGHT starting point for any 'how am I doing', 'what kind of trader am I', 'what should I work on' question. Composes the graded-call record into: an archetype (e.g. 'Fat-tail trend-follower'), expectancy + profit factor, WHICH MARKET REGIME their edge lives and dies in, plan quality (were the calls well-formed when posted), and conviction calibration (do they size up on their best ideas). Omit `wallet` for the connected user; pass a wallet to read any public profile. PREFER THIS OVER get_my_edge for overall assessment — get_my_edge is only the per-symbol/per-side realized P&L slice. Everything here is graded from public price, so it is verifiable, not self-reported. Respect the `tier` field: FORMING means small sample — say so rather than stating conclusions.",
    input_schema: { type: "object", properties: { wallet: { type: "string", description: "Optional wallet address; defaults to the connected user." } } },
    run: async (args, ctx) => {
      const addr = String(args.wallet || ctx.wallet || "").trim();
      if (!addr) return JSON.stringify({ error: "no wallet — connect one or pass a wallet address" });
      const res = await fetch(`${AGENT_API}/theses/process/${addr}`);
      if (!res.ok) return JSON.stringify({ error: `process read failed (${res.status})` });
      const process = await res.json();
      if (!process?.calls) {
        return JSON.stringify({
          calls: 0,
          note: "No resolved public calls yet, so there is no graded record to read. A profile needs calls posted PUBLIC that have since resolved against real price. Say this plainly instead of inferring a profile from nothing.",
        });
      }
      const profile = buildOperatorProfile({ process });
      return JSON.stringify({
        tier: profile.tier,
        gradedCalls: profile.gradedCalls,
        archetype: profile.archetype?.label ?? null,
        headline: profile.headline,
        reads: profile.reads.map((r: { kind: string; text: string }) => ({ kind: r.kind, text: r.text })),
        narrative: profileNarrative(profile, { publicOnly: true, voice: args.wallet ? "third" : "second" }),
        unlocks: profile.unlocks,
      });
    },
  },
  {
    name: "get_call_advice",
    description:
      "Sanity-check a SPECIFIC trade idea BEFORE it is posted or taken. Given a symbol (and optionally direction + entry/stop/target), returns: the market regime that symbol is in RIGHT NOW (trending up/down or chopping, and its volatility), the user's own graded record IN THAT REGIME, and any defects in the proposed plan — entry the market has already run past, a stop inside the noise, a stop too wide to be risk control, or an R:R that doesn't match the levels. Use whenever the user is considering a trade, asks 'should I take this', or drafts a thesis. This runs the SAME functions that will grade the call later, so the warnings match how it will actually be judged. Report what it returns; do not turn it into an instruction to trade.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker or perp symbol, e.g. BTC or PERP_BTC_USDC" },
        direction: { type: "string", description: "LONG or SHORT (optional — omit if the user hasn't picked a side)" },
        entryPrice: { type: "number" }, stopLoss: { type: "number" }, takeProfit1: { type: "number" },
        riskReward: { type: "number" },
      },
      required: ["symbol"],
    },
    run: async (args, ctx) => {
      const res = await fetch(`${AGENT_API}/theses/advice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: ctx.wallet, ...args }),
      });
      if (!res.ok) return JSON.stringify({ error: `advice failed (${res.status})` });
      return JSON.stringify(await res.json());
    },
  },
  {
    name: "get_top_agents",
    description:
      "Get the public TRUSTLESS autonomous-agent leaderboard: agents ranked by risk-adjusted score over their real on-chain-anchored trade ledger. Use to compare agent strategies or answer 'who are the top agents'. The user can ⚡ Autocopy any of these — their own agent mirrors the leader's trades at their own risk (see open_autocopy).",
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
    name: "get_arena",
    description:
      "Get the NEXUS ARENA board: external AI trading agents (built by anyone — Bankr bots, LangChain scripts, LLM loops) that registered a wallet and trade through the venue's webhook rail. Records are graded by the venue engine (paper = simulated at public mark price, live = real Orderly orders on the anchored ledger) — never self-reported. Use for 'what is the arena', 'which AI agents are competing', or when the user asks how to plug their own bot in (point them to /arena and trade.nexustradinglabs.com/arena-api.md).",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const res = await fetch(`${AGENT_API}/arena/agents`);
      if (!res.ok) return JSON.stringify({ error: `arena board failed (${res.status})` });
      const d = await res.json();
      return JSON.stringify({
        count: d?.count ?? 0,
        agents: (d?.agents ?? []).slice(0, 15),
        register_docs: "https://trade.nexustradinglabs.com/arena-api.md",
      });
    },
  },
  {
    name: "get_market_regime",
    description:
      "Get the broad market TAPE: crypto Fear & Greed index (0-100 + classification), total market-cap 24h change, and BTC dominance. Use for 'how's the market', risk-on/risk-off, or sentiment questions. Call this the 'tape' in your answer, NOT the 'regime' — in Nexus, 'regime' means the PER-SYMBOL trend/volatility classification used to grade calls (see get_my_edge / Regime Edge), and conflating the two confuses the user.",
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
    name: "get_smart_money",
    description:
      "Get what the top on-chain traders (Smart Money) are doing right now: the highest-conviction CONSENSUS coins (where multiple top traders hold the same side), the top-ranked traders with their live positions, and the most recent opens/closes. Sourced live from Orderly + Hyperliquid public settlement data. Use for 'what is smart money doing', 'are the whales long or short X', 'who's the best trader on-chain', or to sanity-check a directional idea against the crowd.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Optional ticker (BTC, ETH, SOL…) to focus the answer on." } },
    },
    run: async (args) => {
      const [b, e] = await Promise.all([
        fetch(`${AGENT_API}/smart/board`).then((r) => r.json()).catch(() => null),
        fetch(`${AGENT_API}/smart/events`).then((r) => r.json()).catch(() => null),
      ]);
      const traders = b?.traders ?? [];
      if (!traders.length) return JSON.stringify({ error: "smart money data unavailable" });
      // Consensus: coins where ≥2 top traders share a side (agreement > any one whale).
      const byCoin = new Map<string, { sym: string; side: string; traders: Set<string>; netUsd: number }>();
      for (const t of traders) for (const p of (t.positions ?? [])) {
        if (!p.sym) continue;
        const k = `${p.sym}|${p.side}`;
        const c = byCoin.get(k) ?? { sym: p.sym, side: p.side, traders: new Set(), netUsd: 0 };
        c.traders.add(t.address); c.netUsd += p.szUsd; byCoin.set(k, c);
      }
      let consensus = [...byCoin.values()].filter((c) => c.traders.size >= 2)
        .map((c) => ({ coin: c.sym, side: c.side, traders: c.traders.size, netUsd: Math.round(c.netUsd) }))
        .sort((a, b) => b.traders - a.traders || b.netUsd - a.netUsd);
      const focus = String(args.symbol ?? "").replace("PERP_", "").replace("_USDC", "").toUpperCase();
      if (focus) consensus = consensus.filter((c) => c.coin.toUpperCase() === focus);
      const topTraders = traders.slice(0, 8).map((t: { address: string; source: string; pnl: number; pnlLabel: string; positions?: { side: string; sym: string; szUsd: number }[] }) => ({
        address: t.address, source: t.source, pnl: t.pnl, pnlLabel: t.pnlLabel,
        positions: (t.positions ?? []).slice(0, 4).map((p) => `${p.side} ${p.sym} $${Math.round(p.szUsd / 1000)}k`),
      }));
      const recentMoves = (e?.events ?? []).slice(0, 8).map((ev: { sym: string; side: string; type: string; szUsd: number; source?: string }) => ({ coin: ev.sym, side: ev.side, type: ev.type, szUsd: ev.szUsd, source: ev.source ?? "hl" }));
      return JSON.stringify({ note: "Smart money is context, often early AND often wrong — not a signal.", consensus: consensus.slice(0, 8), topTraders, recentMoves });
    },
  },
  {
    name: "get_mispriced",
    description:
      "Get the MISPRICED BOARD — every liquid perp priced by its funding rate as a mispricing signal. Persistently positive funding means the book is lopsided LONG, so the mean-revert (fade) edge is SHORT — and vice-versa; rates are annualized so |edge| is comparable across markets. Returns the most stretched markets (fade direction + annualized edge %/yr + raw 8h funding + 24h move), the scan counts, and — where the graded, credible CALLERS have a stance — their merit-weighted lean beside each, flagging DIVERGENCE (funding fade vs. the sharp callers disagree). Use for 'what's mispriced', 'where is funding extreme', 'what should I fade', 'where is the crowd offside'. Pass a symbol to read one market even if it's priced fair. This is a POSITIONING lens, NOT advice — the fade is a mean-reversion tendency, not a guarantee, and a market can stay stretched for a long time; say so. Offer to draft a thesis on a standout (draft_thesis).",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Optional ticker (BTC, ETH…) to focus on one market." } },
    },
    run: async (args) => {
      const [board, cons] = await Promise.all([
        fetch(`${AGENT_API}/intel/mispriced`).then((r) => r.json()).catch(() => null),
        fetch(`${AGENT_API}/theses/consensus`).then((r) => r.json()).catch(() => null),
      ]);
      type M = { coin: string; direction: string; fundingAnnualPct: number; funding8hPct: number; change24hPct: number | null; status: string; edgeQuality?: { tier: string; revertedPct: number | null; samples: number } };
      const markets: M[] = board?.markets ?? [];
      if (!markets.length) return JSON.stringify({ error: "mispriced board unavailable" });
      const lean: Record<string, { side: string; participants: number }> = cons?.consensus ?? {};
      const focus = shortTicker(String(args.symbol ?? ""));
      const picked = focus ? markets.filter((m) => m.coin === focus) : markets.filter((m) => m.status === "MISPRICED");
      const rows = picked.slice(0, 12).map((m) => {
        const l = lean[m.coin];
        const diverges = !!l && l.side !== "SPLIT" && m.direction !== "NONE" && l.side !== m.direction;
        const q = m.edgeQuality;
        return {
          coin: m.coin, fade: m.direction, edge_annual_pct: m.fundingAnnualPct,
          funding_8h_pct: m.funding8hPct, change_24h_pct: m.change24hPct, status: m.status,
          // Has fading this HISTORICALLY paid? PROVEN/TRAP/MIXED/UNPROVEN — the honest half.
          edge_quality: q ? { tier: q.tier, reverted_pct: q.revertedPct, samples: q.samples } : undefined,
          sharp_callers: l ? { lean: l.side, n: l.participants } : null,
          divergence: diverges || undefined,
        };
      });
      return JSON.stringify({
        scanned: board?.scanned ?? null,
        mispriced_count: board?.mispricedCount ?? null,
        markets: rows,
        note: "Funding annualized = the crowd's mispricing; fade = the mean-revert edge. edge_quality is the honest half — whether fading THIS market has historically reverted: TRAP means funding is stretched but the fade has LOST (do NOT blindly fade it), PROVEN means it's paid, UNPROVEN means not enough recorded history. Always surface a TRAP. Positioning lens, not advice. 'divergence' = the sharp callers lean the other way.",
      });
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
      "Get the TRUSTLESS human-caller leaderboard: traders ranked by objectively-graded public thesis calls (first-touch TP-vs-SL vs public price), needing >=5 resolved calls. Each entry also carries a `contrarian` record ({calls, avgR, edge, score} or null) — how they do on calls made AGAINST the crowd's consensus lean, so you can name who's right when they fade the crowd. Use for 'best callers', 'who's a good contrarian', or social-proof questions.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const res = await fetch(`${AGENT_API}/theses/leaderboard`);
      if (!res.ok) return JSON.stringify({ error: `callers leaderboard failed (${res.status})` });
      const d = await res.json();
      return JSON.stringify({ criteria: d?.criteria?.grading ?? null, leaderboard: (d?.leaderboard ?? []).slice(0, 10) });
    },
  },
  {
    name: "get_contested",
    description:
      "Get the DISAGREEMENT board: symbols where credible, merit-weighted callers currently hold OPPOSING directions right now — and which SIDE has the better graded record (win rate + avg-R). Consensus is cheap; disagreement between people with track records is the signal. Use for 'where do the smart callers disagree', 'what's contested', or to find high-information standoffs before taking a side.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const res = await fetch(`${AGENT_API}/theses/contested`);
      if (!res.ok) return JSON.stringify({ error: `contested failed (${res.status})` });
      const d = await res.json();
      const party = (p: Record<string, any>) => ({ name: p.displayName || p.wallet, rank: p.meritRank?.title ?? null, record: p.record ?? null, contrarian: p.contrarian ?? null });
      const rows = (d?.contested ?? []).slice(0, 8).map((r: Record<string, any>) => ({
        symbol: r.symbol, split: r.balance, edge: r.edge ?? null,
        longs: (r.longs ?? []).map(party),
        shorts: (r.shorts ?? []).map(party),
      }));
      return JSON.stringify({ count: rows.length, contested: rows, note: "`edge` names the side with the better graded avg-R (withheld until both sides have >=3 graded calls). `contrarian` on a participant = their fade-the-crowd record." });
    },
  },
  {
    name: "get_contrarians",
    description:
      "Get the CONTRARIANS board: callers who are provably RIGHT when they FADE the crowd — ranked by their record on calls made AGAINST the merit-weighted consensus lean that preceded them (graded from persisted stance snapshots, first-touch vs public price). The purest 'right when everyone's wrong' signal. Use for 'who's the best contrarian', 'who's right fading the crowd', or to find non-consensus edge. Sparse until stance history accrues.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const res = await fetch(`${AGENT_API}/theses/contrarians`);
      if (!res.ok) return JSON.stringify({ error: `contrarians failed (${res.status})` });
      const d = await res.json();
      const rows = (d?.contrarians ?? []).slice(0, 10).map((r: Record<string, any>) => ({
        name: r.displayName || r.wallet, rank: r.meritRank?.title ?? null,
        contrarianCalls: r.contrarianCalls, contrarianAvgR: r.contrarianAvgR, contrarianWinRate: r.contrarianWinRate,
        edgeVsCrowd: r.edge,
      }));
      return JSON.stringify({ count: rows.length, contrarians: rows, note: "contrarianAvgR = avg R on calls made against the crowd; edgeVsCrowd = how much better they do fading vs following consensus." });
    },
  },
  {
    name: "xray_wallet",
    description:
      "X-ray ANY wallet's perp record from public data — no login, works on wallets that have never touched Nexus. Reads BOTH Hyperliquid (trade-by-trade history) and the Orderly network incl. Nexus (per-market settled PnL + live open positions), PLUS the wallet's Tracked Record — a graded consistency read (Consistency Score / trend / green-day rate) that separates a lucky single print from a wallet that's consistently profitable over time. Use when the user pastes a wallet address, asks 'is this trader any good', or wants to vet someone before copying them.",
    input_schema: {
      type: "object",
      properties: { wallet: { type: "string", description: "0x… wallet address." } },
      required: ["wallet"],
    },
    run: async (args) => {
      const w = String(args.wallet ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return JSON.stringify({ error: "invalid wallet address" });

      const [hlRes, ordRes, trkRes] = await Promise.allSettled([
        fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "userFills", user: w.toLowerCase() }),
        }).then((r) => r.json()),
        fetch(`${AGENT_API}/smart/xray?address=${encodeURIComponent(w)}`).then((r) => r.json()),
        // Self-seeding: reading the history also begins/extends this wallet's Tracked
        // Record, so vetting a wallet starts grading its consistency over time.
        fetch(`${AGENT_API}/smart/xray/history?address=${encodeURIComponent(w)}`).then((r) => r.json()),
      ]);

      // Hyperliquid: closed fills only → count / net pnl / win rate.
      let hyperliquid: Record<string, unknown> = { closed_trades: 0 };
      if (hlRes.status === "fulfilled" && Array.isArray(hlRes.value)) {
        const closed = hlRes.value.filter(
          (f: { dir?: string; closedPnl?: string }) =>
            /^Close/.test(String(f.dir ?? "")) || parseFloat(f.closedPnl ?? "0") !== 0,
        );
        const pnls = closed.map(
          (f: { closedPnl?: string; fee?: string }) =>
            parseFloat(f.closedPnl ?? "0") - Math.abs(parseFloat(f.fee ?? "0")),
        );
        const wins = pnls.filter((p: number) => p > 0).length;
        hyperliquid = {
          closed_trades: closed.length,
          net_pnl: Math.round(pnls.reduce((s: number, p: number) => s + p, 0)),
          win_rate_pct: pnls.length ? Math.round((wins / pnls.length) * 100) : null,
        };
      }

      // Orderly: per-market aggregates per broker (ours flagged). NO per-trade tape
      // exists publicly, so never claim hold-time/timing stats from this side.
      const ord = ordRes.status === "fulfilled" ? ordRes.value : null;
      const orderly = ord?.venues?.length
        ? {
            venues: ord.venues.map((v: Record<string, unknown>) => ({
              broker: v.brokerId, is_nexus: v.isNexus, realized: v.realized,
              unrealized: v.unrealized, markets: v.markets,
              profitable_markets_pct: v.profitableMarketsPct, open_positions: v.openPositions,
              top_markets: (v.bySymbol as Record<string, unknown>[] ?? []).slice(0, 5)
                .map((s) => ({ sym: s.sym, realized: s.realized, open: s.open, side: s.side })),
            })),
            total_realized: ord.totalRealized,
          }
        : null;

      // Tracked Record: the accruing, self-grading consistency read (realized-PnL
      // DELTAS between daily snapshots, not lifetime). Lets the AI separate a lucky
      // single print from a wallet that is consistently profitable over time.
      const trk = trkRes.status === "fulfilled" ? (trkRes.value?.track as Record<string, unknown> | undefined) : undefined;
      const tracked_record = trk
        ? (trk.building
            ? { status: "tracking_started", snapshots: trk.points }
            : {
                days_tracked: trk.daysTracked,
                net_realized_while_tracked: trk.netRealized,
                green_day_rate_pct: trk.winWindowRate,   // null until daily-cadence data accrues
                consistency_score: trk.operatorScore,    // 0-100, null until ~4 daily windows
                tier: (trk.tier as { title?: string } | null)?.title ?? null,
                trend: trk.trend,
                graded_windows: trk.gradedWindows,
              })
        : null;

      return JSON.stringify({
        wallet: w, hyperliquid, orderly, tracked_record,
        note: orderly
          ? "Orderly figures are per-MARKET settled totals (no public per-trade tape), so hold-time/timing stats are Hyperliquid-only. tracked_record grades the CHANGE in realized PnL between daily snapshots — consistency_score/tier are EARNED from consistency over time and stay null until enough daily windows accrue; long gaps in watching are excluded so a month can't pose as a green day."
          : "No Orderly-network history found for this wallet (sub-accounts aren't resolvable from an address).",
        full_report: `/analyze?address=${w}`,
      });
    },
  },
  {
    name: "get_forecasts",
    description:
      "Get the FORECAST DIVERGENCE board — Polymarket prediction-market forecasts on assets we trade, joined to our funding/positioning. On price-target markets it flags where the FORECASTING crowd (folded probability → directional lean) disagrees with the LEVERAGED tape (funding lean), but ONLY for near-money strikes where that read is meaningful (a far tail strike carries no directional signal and is surfaced, not flagged). Use for 'what do prediction markets say about BTC', 'where do forecasters and the tape disagree', 'is the crowd's forecast offside vs positioning'. Pass a symbol to focus one asset. This is NOT a fair-value oracle and NOT advice — we do not compute a fair probability (that's not ours to claim); it's a divergence worth INVESTIGATING and staking a graded thesis on. Offer to draft_thesis on a standout divergence.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Optional ticker (BTC, ETH, SOL…) to focus one asset." } },
    },
    run: async (args) => {
      const focus = shortTicker(String(args.symbol ?? ""));
      const url = focus ? `${AGENT_API}/intel/forecasts/${focus}` : `${AGENT_API}/intel/forecasts`;
      const board = await fetch(url).then((r) => r.json()).catch(() => null);
      type F = { coin: string; question: string; forecastProbPct: number; target: number | null; targetDirection: string | null; distancePct: number | null; forecastLean: string | null; fundingLean: string | null; nearMoney: boolean | null; alignment: string | null; divergence: boolean; volumeUsd: number; endDate: string | null };
      const markets: F[] = board?.markets ?? [];
      if (!markets.length) return JSON.stringify({ error: "no linked prediction markets right now (sparse by design — mostly BTC/ETH/SOL + major narratives)" });
      // Lead with flagged divergences, then near-money reads, then context.
      const rows = markets.slice(0, 12).map((m) => ({
        coin: m.coin, question: m.question, forecast_yes_pct: m.forecastProbPct,
        target: m.target, target_dir: m.targetDirection, distance_pct: m.distancePct,
        forecast_lean: m.forecastLean, funding_lean: m.fundingLean,
        near_money: m.nearMoney, alignment: m.alignment,
        divergence: m.divergence || undefined, volume_usd: m.volumeUsd, ends: m.endDate,
      }));
      return JSON.stringify({
        divergent_count: board?.divergentCount ?? null,
        markets: rows,
        note: "forecast_yes_pct is Polymarket's crowd probability; forecast_lean folds it (low YES on an 'up' bet = a DOWN lean). A DIVERGENCE = near-money forecast lean vs funding lean disagree with conviction — a prompt to investigate, not a signal to trade. Far strikes are context only. Offer to draft a graded thesis on a standout.",
      });
    },
  },
  {
    name: "get_defi",
    description:
      "Get DeFi macro context from DeFiLlama: total DeFi TVL, the top chains by TVL, and (if a chain is named) that chain's TVL + rank. Use for 'how's DeFi TVL', 'which chains are growing', 'where's the liquidity', or to frame an asset's chain in macro terms. Read-only, free public data.",
    input_schema: {
      type: "object",
      properties: { chain: { type: "string", description: "Optional chain name (Ethereum, Base, Solana, Arbitrum…)." } },
    },
    run: async (args) => {
      // DeFiLlama is free + CORS-friendly → direct client fetch (no key, no proxy).
      const chains = await fetch("https://api.llama.fi/v2/chains").then((r) => r.json()).catch(() => null);
      if (!Array.isArray(chains) || !chains.length) return JSON.stringify({ error: "DeFiLlama unavailable" });
      const sorted = [...chains].sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
      const total = sorted.reduce((s, c) => s + (Number(c.tvl) || 0), 0);
      const top = sorted.slice(0, 8).map((c, i) => ({ rank: i + 1, chain: c.name, tvl_usd: Math.round(c.tvl || 0) }));
      const want = String(args.chain ?? "").trim().toLowerCase();
      let focus: Record<string, unknown> | undefined;
      if (want) {
        const idx = sorted.findIndex((c) => String(c.name || "").toLowerCase() === want || String(c.tokenSymbol || "").toLowerCase() === want);
        if (idx >= 0) focus = { chain: sorted[idx].name, tvl_usd: Math.round(sorted[idx].tvl || 0), rank: idx + 1 };
      }
      return JSON.stringify({ total_defi_tvl_usd: Math.round(total), top_chains: top, focus, note: "Snapshot TVL from DeFiLlama. Macro liquidity context, not a trade signal." });
    },
  },
  {
    name: "get_macro",
    description:
      "Get TradFi macro quotes (via TwelveData): price + daily change for indices/FX/commodities like SPX, NDX, DXY, GOLD, US10Y. Use to frame crypto against risk-on/risk-off (e.g. 'how's the dollar', 'is risk bid today', 'what's SPX doing'). Read-only. Returns 'not configured' if the data key isn't set on the worker.",
    input_schema: {
      type: "object",
      properties: { symbols: { type: "string", description: "Comma-separated, e.g. 'SPX,DXY,GOLD'. Defaults to SPX,DXY,GOLD." } },
    },
    run: async (args) => {
      const symbols = String(args.symbols ?? "SPX,DXY,GOLD").replace(/\s+/g, "");
      const r = await fetch(`${AGENT_API}/proxy/twelvedata?symbols=${encodeURIComponent(symbols)}`).then((x) => x.json()).catch(() => null);
      if (!r || r.error) return JSON.stringify({ error: r?.error ?? "macro data unavailable" });
      return JSON.stringify({ quotes: r.quotes ?? r, note: "TradFi context to frame crypto risk appetite — not a trade signal." });
    },
  },
  {
    name: "get_indicators",
    description:
      "Get technical indicators for a crypto pair (via TAAPI): RSI, MACD, and other common reads on a chosen interval. Use when the user asks 'is BTC overbought', 'what's the RSI', 'MACD on ETH 4h'. Read-only, and TA is a lagging lens — frame it as context, never as advice. Returns 'not configured' if the data key isn't set on the worker.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker like BTC, ETH, SOL." },
        interval: { type: "string", description: "Candle interval: 1h, 4h, 1d (default 1h)." },
        indicators: { type: "string", description: "Comma-separated subset of rsi,macd,ema,bbands (default rsi,macd)." },
      },
      required: ["symbol"],
    },
    run: async (args) => {
      const sym = shortTicker(String(args.symbol ?? ""));
      if (!sym) return JSON.stringify({ error: "symbol required" });
      const interval = String(args.interval ?? "1h");
      const indicators = String(args.indicators ?? "rsi,macd").replace(/\s+/g, "");
      const r = await fetch(`${AGENT_API}/proxy/taapi?symbol=${sym}&interval=${encodeURIComponent(interval)}&indicators=${encodeURIComponent(indicators)}`).then((x) => x.json()).catch(() => null);
      if (!r || r.error) return JSON.stringify({ error: r?.error ?? "indicator data unavailable" });
      return JSON.stringify({ symbol: sym, interval, indicators: r.indicators ?? r, note: "TA is a lagging context lens, not advice. An overbought reading can stay overbought." });
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
    name: "open_xray",
    description: "Open the full Wallet X-Ray report page for an address (charts, per-market breakdown, and ⚡ copy-to-agent on any live position). Use after xray_wallet when the user wants the visual breakdown, or when they ask to 'x-ray' a wallet.",
    input_schema: {
      type: "object",
      properties: { wallet: { type: "string", description: "0x… wallet address." } },
      required: ["wallet"],
    },
    run: async (args, ctx) => {
      const w = String(args.wallet ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return JSON.stringify({ error: "invalid wallet address" });
      ctx.navigate?.(`/analyze?address=${w}`);
      return JSON.stringify({ navigated: `/analyze?address=${w}` });
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
    name: "open_autocopy",
    description:
      "Open the autonomous-agent leaderboard (TOP AGENTS) in the Lab, where the user can ⚡ Autocopy a proven agent — their OWN agent then mirrors the leader's trades at their own size, mode and guardrails, graded on-chain (trustless copy-trading). Use when the user wants to copy/follow a top-performing agent, or asks 'who should I copy' after get_top_agents.",
    input_schema: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      ctx.navigate?.(`/lab?tab=agent`);
      try { window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "agent" } })); } catch { /* not in Lab yet — the ?tab= deep-link handles it */ }
      return JSON.stringify({ navigated: "/lab?tab=agent", note: "TOP AGENTS board — tap ⚡ Autocopy on any ranked agent to mirror it with your own agent" });
    },
  },
  {
    name: "open_mispriced",
    description:
      "Open the MISPRICED BOARD in the Lab — the funding-edge lens, markets ranked by how stretched positioning is, with the sharp-callers' merit-weighted lean beside each. Use when the user wants to browse what's mispriced / where funding is extreme. Read-only view; places no order.",
    input_schema: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      ctx.navigate?.(`/lab?tab=mispriced`);
      try { window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "mispriced" } })); } catch { /* deep-link handles it */ }
      return JSON.stringify({ navigated: "/lab?tab=mispriced", note: "Opened the Mispriced Board. Each row can be drafted into a thesis." });
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
        catalyst: { type: "string", description: "Optional near-term 'why now' — the trigger the market may move on (e.g. 'CPI Thu', 'funding reset', 'range breakout'). Makes it a Signal, not just a plan." },
        targetWindow: { type: "string", description: "Optional defined exit horizon — when the trader will know they were right or wrong (e.g. '7D', '48h', 'by FOMC')." },
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
        catalyst: args.catalyst ? String(args.catalyst) : undefined,
        targetWindow: args.targetWindow ? String(args.targetWindow) : undefined,
      };
      try { window.localStorage.setItem(THESIS_DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
      ctx.navigate?.(`/lab?tab=thesis`);
      // Fire events so it works even when the Lab is already open on the Thesis tab
      // (a re-navigate to the same URL is a no-op → the mount-only reader never ran).
      // nexus:lab-tab switches the tab via local state; nexus:thesis-draft tells an
      // already-mounted ThesisView to re-read + prefill the draft.
      try {
        window.dispatchEvent(new CustomEvent("nexus:lab-tab", { detail: { tab: "thesis" } }));
        window.dispatchEvent(new CustomEvent("nexus:thesis-draft"));
      } catch { /* non-browser / SSR — ignore */ }
      return JSON.stringify({ drafted: draft, note: "Opened the Thesis Engine pre-filled. The user reviews risk/size and saves or executes — no order was placed." });
    },
  },
  {
    name: "draft_directive",
    description:
      "Hand the user's autonomous agent an EXACT directional trade to review and arm (the ▶ TRADE flow). Unlike draft_thesis (just a plan) or the signal bot (which picks its OWN direction), a directive makes the agent enter the user's specified direction and manage the exit for them (scale-out, trailing stop, breakeven, timeout), then stop — one-shot. This DRAFTS it and opens the Agent review panel; it NEVER arms or places anything — the user picks PAPER or live, reviews, and signs. Use when the user wants to AUTOMATE a specific trade (e.g. 'run my BTC long on the agent', 'automate this exact setup'). Only one directive is active at a time — check get_agent_directive first if unsure.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker like BTC, ETH, SOL." },
        direction: { type: "string", enum: ["LONG", "SHORT"] },
        entryPrice: { type: "number", description: "Planned entry (also the trigger if the user later chooses a resting LIMIT entry)." },
        stopLoss: { type: "number" },
        takeProfit1: { type: "number" },
        takeProfit2: { type: "number", description: "Optional second target — becomes the runner leg of a scale-out ladder." },
        leverage: { type: "number", description: "Optional; defaults to the agent's configured leverage." },
      },
      required: ["symbol", "direction", "entryPrice", "stopLoss", "takeProfit1"],
    },
    run: async (args, ctx) => {
      const dir = String(args.direction ?? "").toUpperCase();
      if (dir !== "LONG" && dir !== "SHORT") return JSON.stringify({ error: "direction must be LONG or SHORT" });
      const entry = Number(args.entryPrice), stop = Number(args.stopLoss), tp = Number(args.takeProfit1);
      if (![entry, stop, tp].every((n) => Number.isFinite(n) && n > 0)) return JSON.stringify({ error: "entry/stop/takeProfit must be positive numbers" });
      // Direction-side sanity (mirrors the exec guard) so we never draft a contradiction.
      if (dir === "LONG" && !(stop < entry && tp > entry)) return JSON.stringify({ error: "for a LONG: need stop < entry < takeProfit1" });
      if (dir === "SHORT" && !(stop > entry && tp < entry)) return JSON.stringify({ error: "for a SHORT: need takeProfit1 < entry < stop" });
      const tp2 = Number(args.takeProfit2), lev = Number(args.leverage);
      const sym = shortTicker(String(args.symbol ?? ""));
      deployDirectiveFromThesis({
        symbol: sym,
        direction: dir as "LONG" | "SHORT",
        entryPrice: entry, stopLoss: stop, takeProfit1: tp,
        takeProfit2: Number.isFinite(tp2) && tp2 > 0 ? tp2 : undefined,
        leverage: Number.isFinite(lev) && lev > 0 ? lev : undefined,
      }, ctx.navigate);
      // Edge-aware sizing: surface the user's OWN record on this symbol/direction
      // so the model can factor it into position size. Analysis, NOT an auto-size —
      // a small historical sample must never mechanically set risk.
      let edge_note: string | undefined;
      const edge = (ctx.performance as { edge?: { by_symbol?: { symbol: string; trades: number; winRatePct: number; pnl: number }[]; by_side?: Record<string, { trades: number; winRatePct: number; pnl: number }> } } | null)?.edge;
      if (edge) {
        const row = edge.by_symbol?.find((r) => r.symbol === sym);
        const sideRow = edge.by_side?.[dir];
        const fmt = (p: number) => `${p >= 0 ? "+" : "-"}$${Math.abs(p)}`;
        const parts: string[] = [];
        if (row && row.trades >= 3) parts.push(`your ${sym} record: ${row.winRatePct}% over ${row.trades} trades (${fmt(row.pnl)})`);
        if (sideRow && sideRow.trades >= 3) parts.push(`your ${dir.toLowerCase()} record: ${sideRow.winRatePct}% (${fmt(sideRow.pnl)})`);
        if (parts.length) edge_note = `Edge check — ${parts.join("; ")}. Factor this into size (analysis, not an instruction); a small sample isn't destiny.`;
      }
      return JSON.stringify({ drafted: { symbol: sym, direction: dir, entry, stop, takeProfit1: tp }, edge_note, note: "Opened the Agent DIRECTIVE panel pre-filled. The user picks PAPER/live, reviews the levels, and arms it — nothing was placed or armed." });
    },
  },
  {
    name: "get_agent_directive",
    description:
      "Get the connected user's current directional DIRECTIVE (the exact one-shot trade the agent is running or waiting to run): status (ARMED = waiting to fill, LIVE = position open), direction, entry type (MARKET/LIMIT) + trigger price, stop, and targets. Also returns whether Telegram alerts are linked. Use for 'what is my agent set to trade', or before drafting a new directive (only one is active at a time).",
    input_schema: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      if (!ctx.wallet) return JSON.stringify({ error: "wallet not connected" });
      const res = await fetch(`${AGENT_API}/agent/${ctx.wallet}`);
      if (!res.ok) return JSON.stringify({ error: `agent fetch failed (${res.status})` });
      const d = await res.json();
      return JSON.stringify({ directive: d?.directive ?? null, telegram_linked: !!d?.tgLinked });
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
