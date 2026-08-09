// ── Agents routes (public boards) ──
// LIVE NOW open positions, the public strategy board, the agent leaderboard, a single
// agent's "why am I / am I not ranked" standing, and the verifiable agent ledger.
//
// Third family out of index.js (migration rules in shared.mjs). Read-only: every
// number is derived from public mark price or the graded trade record — uPnL here is
// RECOMPUTED server-side and never taken from a client claim. Nothing moves funds.
//
// ⚠️ Note the two chunks: /agents/live was separated from the rest by the signals and
// desks routes in index.js. They're merged here because /agents/* cannot overlap
// those paths, so dispatch order is unaffected.
//
// ⚠️ Pure move — logic byte-identical to what shipped.
import { json } from "./shared.mjs";
import { AGENT_BOARD, aggregateAgentTrades, agentStanding, rankCaller } from "./logic.mjs";
// Shared with the agent-config route in index.js, so it lives there and is imported
// back here rather than duplicated.
import { revalidateStrategy } from "./strategies.mjs";

export async function handleAgents(parts, request, env, ctx) {
  if (parts[0] !== "agents") return null;
  const url = new URL(request.url);

  // ── /agents/live — LIVE NOW feed: currently-OPEN positions (agents + opted-in ──
  // humans), with uPnL recomputed from PUBLIC mark price. Agents come from
  // agent:state (real, non-paper); humans from their ephemeral live:human snapshot.
  // Pure public read. Verifiable — the PnL is derived from public price, not claimed.
  if (parts[0] === "agents" && parts[1] === "live") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;

    // Agents: open, non-paper current_position per agent:users.
    const usersRaw = await AGENT_KV.get("agent:users");
    const users = usersRaw ? JSON.parse(usersRaw) : [];
    const agentStates = await Promise.all(users.map(async (w) => {
      const s = await AGENT_KV.get(`agent:state:${w}`);
      return { w, p: s ? (JSON.parse(s).current_position || null) : null };
    }));
    const rows = [];
    for (const { w, p } of agentStates) {
      if (p && !p.paper && p.symbol && p.entry_price && p.qty) {
        rows.push({ wallet: w, agent: true, displayName: null, pfpUrl: null, symbol: p.symbol, direction: p.direction, entry_price: Number(p.entry_price), qty: Number(p.qty), opened_at: p.opened_at || null });
      }
    }

    // Humans: ephemeral opted-in snapshots (live:human:*), still within TTL.
    try {
      const list = await AGENT_KV.list({ prefix: "live:human:", limit: 1000 });
      const snaps = await Promise.all(list.keys.map(async (k) => {
        const raw = await AGENT_KV.get(k.name);
        return raw ? { wallet: k.name.slice("live:human:".length), ...JSON.parse(raw) } : null;
      }));
      for (const sn of snaps) {
        if (!sn) continue;
        for (const p of sn.positions || []) {
          rows.push({ wallet: sn.wallet, agent: false, displayName: sn.displayName || null, pfpUrl: sn.pfpUrl || null, symbol: p.symbol, direction: p.direction, entry_price: Number(p.entry_price), qty: Number(p.qty), opened_at: p.opened_at || null });
        }
      }
    } catch (e) { console.error("[live] human snapshot list error:", e); }

    // One public mark-price fetch per unique symbol → recompute uPnL.
    const markBy = {};
    await Promise.all([...new Set(rows.map((r) => r.symbol))].map(async (sym) => {
      try { markBy[sym] = Number((await (await fetch(`https://api-evm.orderly.org/v1/public/futures/${sym}`)).json())?.data?.mark_price) || null; }
      catch { markBy[sym] = null; }
    }));
    const positions = rows.map((r) => {
      const mark = markBy[r.symbol], entry = r.entry_price, qty = r.qty;
      const move = mark ? (r.direction === "LONG" ? mark - entry : entry - mark) : null;
      return {
        wallet: r.wallet, agent: r.agent, displayName: r.displayName, pfpUrl: r.pfpUrl,
        symbol: r.symbol, direction: r.direction, entry_price: entry, mark_price: mark, qty,
        notional: Number((entry * qty).toFixed(2)),
        unrealized_pnl: move != null ? Number((move * qty).toFixed(2)) : null,
        unrealized_pnl_pct: move != null ? Number(((move / entry) * 100).toFixed(2)) : null,
        opened_at: r.opened_at,
      };
    }).sort((a, b) => (b.opened_at || 0) - (a.opened_at || 0));
    return json({ count: positions.length, positions }, request);
  }

  // ── /signals — machine-readable current funding + OI-divergence reads ────────
  // The agent's actual edge, exposed as data: per symbol, the funding-extreme
  // (fade-the-crowd) + OI-divergence reads + confluence, classified by the SAME
  // rules as the autonomous agent (confluenceSignal, tested). Deltas are vs the
  // brain's ~5-min prior snapshot (market:prev:{symbol}). The premium x402 product.

  // ── GET /agents/strategies/public — browse shared strategies ─────────────
  // Community strategy marketplace. Ranked by the AUTHOR's GRADED agent record
  // (the trustless signal) — NOT by backtest, which is shown only as a labeled
  // hypothesis. Optional ?style=DAY|SWING|POSITION filter (derived from hold time).
  if (parts[0] === "agents" && parts[1] === "strategies" && parts[2] === "public") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;
    const styleFilter = url.searchParams.get("style");
    const derive = (h) => (h <= 8 ? "DAY" : h <= 120 ? "SWING" : "POSITION");
    const listing = await AGENT_KV.list({ prefix: "agent:strategies:" });
    const collected = [];
    for (const k of listing.keys.slice(0, 300)) {
      const owner = k.name.slice("agent:strategies:".length);
      const raw = await AGENT_KV.get(k.name);
      if (!raw) continue;
      let arr; try { arr = JSON.parse(raw); } catch { continue; }
      for (const s of arr) {
        if (!s.public || !s.config) continue;
        const style = derive(s.config.maxHoldHours ?? 0);
        if (styleFilter && style !== styleFilter) continue;
        collected.push({ owner, id: s.id, name: s.name, style, config: s.config, backtest: s.stats || null, validation: s.validation || null, publishedAt: s.publishedAt || s.createdAt });
      }
    }
    // Attach each author's GRADED standing — the trust signal we rank on.
    const owners = [...new Set(collected.map((c) => c.owner))];
    const standings = {};
    if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      await Promise.all(owners.map(async (o) => {
        try {
          const res = await fetch(`${env.SUPABASE_URL}/rest/v1/agent_trades?select=pnl,closed_at&wallet_address=ilike.${o}&limit=10000`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } });
          if (res.ok) standings[o] = agentStanding(aggregateAgentTrades(await res.json())).stats;
        } catch { /* skip */ }
      }));
    }
    // Self-heal badges: (re)validate strategies that are missing a verdict, stuck
    // "validating", or "pending_oi" — the latter auto-flips to a real verdict once OI
    // matures (no re-publish needed). Bounded per request + idempotent to cap load.
    if (ctx?.waitUntil) {
      const stale = (v) => !v || v.status === "validating" || v.status === "error" ||
        (v.status === "pending_oi" && Date.now() - (v.checkedAt || 0) > 6 * 3600 * 1000);
      const needing = collected.filter((c) => stale(c.validation)).slice(0, 3);
      for (const c of needing) ctx.waitUntil(revalidateStrategy(c.owner, c.id, c.config, env));
    }
    const items = collected
      .map((c) => ({ ...c, author: standings[c.owner] || null }))
      .sort((a, b) => (b.author?.score || 0) - (a.author?.score || 0) || (b.author?.netPnl || 0) - (a.author?.netPnl || 0));
    return json({ strategies: items.slice(0, 50), rankedBy: "author_graded_record" }, request);
  }

  if (parts[0] === "agents" && parts[1] === "leaderboard") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;

    const MIN_TRADES = AGENT_BOARD.minTrades;  // anti-gaming: meaningful sample
    const MIN_DAYS = AGENT_BOARD.minDays;       // anti-gaming: spread over time
    const TOP_N = 25;

    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return json({ leaderboard: [], criteria: { minTrades: MIN_TRADES, minDays: MIN_DAYS } }, request);
    }

    // One pull of all live agent trades; group per wallet in-worker, then score
    // each via the SAME shared helper /agents/standing uses (no drift).
    let rows = [];
    try {
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/agent_trades?select=wallet_address,pnl,closed_at&order=closed_at.desc&limit=10000`,
        { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
      );
      if (res.ok) rows = await res.json();
    } catch (e) { console.error("[leaderboard] supabase error:", e); }

    const rowsByWallet = {};
    for (const r of rows) {
      const w = (r.wallet_address || "").toLowerCase();
      if (!w) continue;
      (rowsByWallet[w] = rowsByWallet[w] || []).push(r);
    }

    const eligible = [];
    for (const [wallet, wRows] of Object.entries(rowsByWallet)) {
      const standing = agentStanding(aggregateAgentTrades(wRows));
      if (!standing.eligible) continue;
      eligible.push({ wallet, ...standing.stats });
    }

    eligible.sort((x, y) => y.score - x.score || y.netPnl - x.netPnl);
    const top = eligible.slice(0, TOP_N);

    // Enrich top entries with profile + copyable (strategy-only) config.
    const enriched = await Promise.all(top.map(async (e, i) => {
      const [configRaw, profileRaw, copiersRaw] = await Promise.all([
        AGENT_KV.get(`agent:config:${e.wallet}`),
        env.LAB_STORE.get(`profile:${e.wallet}`),
        AGENT_KV.get(`copy:copiers:${e.wallet}`),
      ]);
      const cfg = configRaw ? JSON.parse(configRaw) : null;
      const profile = profileRaw ? JSON.parse(profileRaw) : {};
      let copiers = 0;
      try { copiers = copiersRaw ? (JSON.parse(copiersRaw) || []).length : 0; } catch { copiers = 0; }
      const sharedConfig = cfg ? {
        symbols: cfg.symbols, leverage: cfg.leverage, tpPercent: cfg.tpPercent,
        slPercent: cfg.slPercent, maxHoldHours: cfg.maxHoldHours,
        maxTradesPerDay: cfg.maxTradesPerDay, fundingThreshold: cfg.fundingThreshold,
      } : null;
      return {
        rank: i + 1, wallet: e.wallet,
        displayName: profile.displayName || null, pfp: profile.pfp || null,
        trades: e.trades, winRate: e.winRate, netPnl: e.netPnl,
        profitFactor: e.profitFactor, daysActive: e.daysActive, score: e.score,
        config: sharedConfig, copiers,
      };
    }));

    return json({ leaderboard: enriched, criteria: { minTrades: MIN_TRADES, minDays: MIN_DAYS } }, request);
  }

  // ── /agents/standing/:address — this agent's own leaderboard standing ──────
  // Tells an owner exactly WHY their agent is / isn't on the board (e.g. "2 of 3
  // criteria met — needs net-positive P&L") so an unranked-but-recording agent
  // reads as a known state, not a bug. Uses the SAME gate as the board.
  if (parts[0] === "agents" && parts[1] === "standing" && parts[2]) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    const addr = String(parts[2]).toLowerCase();
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return json({ eligible: false, criteria: [], stats: null, criteriaConfig: AGENT_BOARD }, request);
    }
    let rows = [];
    try {
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/agent_trades?select=pnl,closed_at&wallet_address=ilike.${addr}&limit=10000`,
        { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
      );
      if (res.ok) rows = await res.json();
    } catch (e) { console.error("[standing] supabase error:", e); }
    return json({ ...agentStanding(aggregateAgentTrades(rows)), criteriaConfig: AGENT_BOARD }, request);
  }

  // ── /agents/copy-record/:leader — did copying THIS wallet actually work? ────
  // Closes the copy loop: aggregate the realized PnL of Nexus AGENT trades that
  // mirrored this leader (source_leader tagged at entry from a smart-money ⚡ copy
  // or autocopy). So a trader-detail can answer "copies of this whale returned Y",
  // graded on-chain-auditable closes — not the leader's self-reported number.
  // Degrades gracefully: if the source_leader column isn't migrated the query 400s,
  // res.ok is false, and we return an honest {available:false} instead of throwing.
  if (parts[0] === "agents" && parts[1] === "copy-record" && parts[2]) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    const leader = String(parts[2]).toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(leader)) return json({ error: "valid 0x leader required" }, request, 400);
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ leader, trades: 0, available: false }, request);
    const CACHE = `copyrec:${leader}`;
    const cached = await env.LAB_STORE.get(CACHE);
    if (cached) return json(JSON.parse(cached), request);
    let rows = [], available = true;
    try {
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/agent_trades?select=pnl,wallet_address&source_leader=ilike.${leader}&limit=10000`,
        { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
      );
      if (res.ok) rows = await res.json();
      else available = false; // column not migrated yet, or query rejected
    } catch (e) { console.error("[copy-record] supabase error:", e); available = false; }
    let net = 0, wins = 0; const copiers = new Set();
    for (const r of rows) { const p = parseFloat(r.pnl || 0); net += p; if (p > 0) wins++; if (r.wallet_address) copiers.add(String(r.wallet_address).toLowerCase()); }
    const trades = rows.length;
    const payload = {
      leader, available, trades, copiers: copiers.size,
      net: Math.round(net * 100) / 100, wins, losses: trades - wins,
      winRatePct: trades ? Math.round((wins / trades) * 1000) / 10 : null,
      note: "Realized PnL of Nexus agent trades that copied this leader (on-chain-auditable closes; scale-out slices count as separate closes).",
    };
    await env.LAB_STORE.put(CACHE, JSON.stringify(payload), { expirationTtl: 300 });
    return json(payload, request);
  }

  // ── /agents/ledger — verifiable, canonical hash of the agent trade ledger ──
  // Anyone can fetch the raw records, recompute the SHA-256 over the canonical
  // serialization, and confirm it matches `ledgerHash`. This makes every number
  // on the leaderboard provably derived from these exact records — no trust in
  // our DB required. Each read also checkpoints the hash into an append-only,
  // prev-linked chain (tamper-evidence over time). Anchor the latest root
  // on-chain (see /agents/ledger/chain) for full trustlessness.
  if (parts[0] === "agents" && parts[1] === "ledger") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, request, 405);
    const AGENT_KV = env.NEXUS_AGENT || env.LAB_STORE;

    const sha256Hex = async (s) => {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };

    // GET /agents/ledger/chain — the append-only checkpoint chain
    if (parts[2] === "chain") {
      const chainRaw = await AGENT_KV.get("agent:ledger:chain");
      const chain = chainRaw ? JSON.parse(chainRaw) : [];
      return json({ chain, length: chain.length, note: "Append-only, prev-linked SHA-256 checkpoints. Anchor the latest hash on-chain for full trustlessness." }, request);
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return json({ ledgerHash: null, count: 0, records: [] }, request);
    }

    let rows = [];
    try {
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/agent_trades?select=id,wallet_address,symbol,direction,entry_price,exit_price,qty,pnl,pnl_percent,reason,opened_at,closed_at&order=id.asc&limit=10000`,
        { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
      );
      if (res.ok) rows = await res.json();
    } catch (e) { console.error("[ledger] supabase error:", e); }

    // Canonical serialization: fixed field order per row, rows ordered by id.
    // Deterministic → any third party recomputes the identical hash.
    const FIELDS = ["id", "wallet_address", "symbol", "direction", "entry_price", "exit_price", "qty", "pnl", "pnl_percent", "reason", "opened_at", "closed_at"];
    const canonical = JSON.stringify(rows.map((r) => FIELDS.map((f) => r[f] ?? null)));
    const ledgerHash = await sha256Hex(canonical);

    // Checkpoint into the prev-linked chain only when the hash changes (dedup
    // so frequent reads don't spam the chain — it grows only as trades settle).
    try {
      const chainRaw = await AGENT_KV.get("agent:ledger:chain");
      const chain = chainRaw ? JSON.parse(chainRaw) : [];
      const last = chain[chain.length - 1];
      if (!last || last.ledgerHash !== ledgerHash) {
        const prevHash = last ? last.ledgerHash : "0".repeat(64);
        const linkHash = await sha256Hex(`${prevHash}:${ledgerHash}:${rows.length}`);
        chain.push({ ts: Date.now(), ledgerHash, prevHash, linkHash, count: rows.length });
        if (chain.length > 500) chain.shift();
        await AGENT_KV.put("agent:ledger:chain", JSON.stringify(chain));
      }
    } catch (e) { console.error("[ledger] chain checkpoint error:", e); }

    // On-chain anchor proof (written by nexus-ledger-anchor). `verified` is true
    // when the latest on-chain root matches the freshly computed ledger hash.
    let onChain = null;
    try {
      const ocRaw = await AGENT_KV.get("agent:ledger:onchain");
      if (ocRaw) {
        const oc = JSON.parse(ocRaw);
        onChain = { ...oc, verified: (oc.root || "").toLowerCase() === `0x${ledgerHash}`.toLowerCase() };
      }
    } catch { /* anchor not set up yet */ }

    return json({
      ledgerHash,
      algorithm: "sha256",
      canonicalForm: "JSON array of rows; each row = [" + FIELDS.join(", ") + "]; rows sorted by id asc",
      count: rows.length,
      generatedAt: Date.now(),
      onChain,
      records: rows,
    }, request);
  }

  return null; // an /agents/* path we don't serve → fall through
}
