// ── Smart Money routes (vertical slice) ──
// The multi-source on-chain trader-discovery subsystem: Orderly's public dashboard
// indexer as the primary source, Hyperliquid as secondary, plus the consensus board,
// per-trader x-ray, activity feed and watchlist.
//
// First family lifted out of index.js's 74-route fetch handler. Chosen deliberately:
// it is almost entirely READ-ONLY public data (the one mutation is a wallet-signed
// watchlist write), so a mistake here cannot move funds. Its helpers were already a
// contiguous cluster, which makes this a true vertical slice rather than a pile of
// loose pieces.
//
// ⚠️ Pure move — logic is byte-identical to what shipped in index.js.
//
// Contract: handleSmart returns a Response when it owns the path, or null so the
// remaining routes in index.js get their turn. Never throws for "not mine".
import { json, normalizeAddress, recoverEthAddress } from "./shared.mjs";
import { orderlyAccountId, xrayTrack } from "./logic.mjs";

// ── Smart Money (Phase 1) ─────────────────────────────────────────────────────
// Curated seed of top Hyperliquid traders (snapshotted from the public HL
// leaderboard, ranked by 30d PnL, gated on real size + volume + profitability).
// Auto-refresh from the live leaderboard is Phase 1.5 (the full leaderboard JSON
// is ~33MB — too heavy for a hot path). r=month ROI, p=month PnL$, v=month vol$.
const SMART_SEED = [
  { a: "0xd47587702a91731dc1089b5db0932cf820151a91", r: 0.222, p: 15399366, v: 145317737 },
  { a: "0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36", r: 0.394, p: 14071694, v: 167764018 },
  { a: "0x4e23288cee4960f9f962195c22948e4bc7ae20c3", r: 0.974, p: 12498366, v: 2129937212 },
  { a: "0xf822fa0fd364c573fcdb7009fcf47601bc8be01a", r: 0.141, p: 7557365, v: 171467747 },
  { a: "0x49e96e255ba418d08e66c35b588e2f2f3766e1d0", r: 0.312, p: 6985881, v: 1845673377 },
  { a: "0x4c78a97cef589b01bb91dbf893fffa14243d2444", r: 0.447, p: 6815542, v: 74310281 },
  { a: "0xebe126adabe1a8f08d3ce53b45e7cc994ca14070", r: 0.387, p: 6758750, v: 97628391 },
  { a: "0x45d26f28196d226497130c4bac709d808fed4029", r: 0.563, p: 6688135, v: 2104367 },
  { a: "0xfe7ce058edc7cfcde9ef8262ba51f8d4796ab7ae", r: 0.366, p: 6685355, v: 220771995 },
  { a: "0x5b5d51203a0f9079f8aeb098a6523a13f298c060", r: 0.629, p: 6647371, v: 95008793 },
  { a: "0xa312114b5795dff9b8db50474dd57701aa78ad1e", r: 0.587, p: 5784246, v: 209753340 },
  { a: "0xf02d16a272a842f8bac1d9a9e773aba1933454c6", r: 2.317, p: 5393746, v: 170521923 },
  { a: "0x856c35038594767646266bc7fd68dc26480e910d", r: 0.123, p: 5098872, v: 1336805870 },
  { a: "0xdfd526409007db0d524a62dedaaba7706736d88e", r: 1.147, p: 4693152, v: 31930324 },
  { a: "0xfc27136e42af1732ddc9ce2605ea9bff1b959d9d", r: 0.152, p: 4254603, v: 2063810275 },
  { a: "0x2d23b731e5f04996a2dfdbe434c7d922afdb5e00", r: 1, p: 4189403, v: 200843327 },
  { a: "0x48d826da83e69844f2f84b2db50703a933d137a2", r: 1.03, p: 4168538, v: 75207656 },
  { a: "0x469e9a7f624b04c24f0e64edf8d8a277e6bf58a5", r: 0.893, p: 4160121, v: 809778767 },
  { a: "0x7fba7e745bd97f828c824589680749b55a8c04ab", r: 0.666, p: 4157120, v: 623734104 },
  { a: "0x9e8b1e51c642f4c8b87c6ba11c53d516a218afc4", r: 0.581, p: 4116404, v: 122554657 },
  { a: "0x64a4fbb71858f681f3fa10a42b34180a9a48088d", r: 0.27, p: 4006643, v: 228840168 },
  { a: "0x3dc908374e11623d8eb9f07dfc7a2e5e803a54b0", r: 0.353, p: 3671798, v: 31557331 },
  { a: "0x6bb971430554e3af58fbd469bce46ab2359a2d23", r: 1.208, p: 3502970, v: 70449619 },
  { a: "0x484bc1608211d0604bf70bae72792a56884562f8", r: 0.422, p: 3432802, v: 38432293 },
];

// Orderly's PUBLIC dashboard indexer (on-chain settlement → analytics). Unlike the
// trading API (auth-gated, own-account only), this exposes per-account rankings +
// positions across the whole Orderly broker network with no auth.
async function orderlyDashboard(path) {
  const r = await fetch(`https://orderly-dashboard-query-service.orderly.network${path}`);
  if (!r.ok) throw new Error(`ord-dash ${r.status}`);
  return r.json();
}

// Brokers probed by the public wallet x-ray. OURS FIRST so a Nexus trader's own
// venue leads the result, then the highest-volume brokers by ranking presence.
// One indexer call each (all parallel) — keep this list bounded.
const NEXUS_BROKER_ID = "nexus_trading";
const ORDERLY_BROKERS = [NEXUS_BROKER_ID, "orderly", "woofi_pro", "raydium", "btse_dex", "aden", "vooi", "logx"];

// ── Public multi-venue wallet aggregate (the x-ray core) ─────────────────────
// Probe every broker's ranking by the address's derived account_id and fold the
// per-symbol realized/unrealized rows into one cross-venue record. Shared by the
// live /smart/xray read AND the snapshotter that builds the accruing Tracked
// Record, so the two can never grade different numbers. Returns null-safe zeros.
async function xrayAggregate(address) {
  const coin = (s) => String(s).replace("PERP_", "").replace("_USDC", "");
  const probed = await Promise.all(ORDERLY_BROKERS.map(async (brokerId) => {
    let accountId;
    try { accountId = orderlyAccountId(address, brokerId); } catch { return null; }
    try {
      const d = await orderlyDashboard(`/ranking/realized_pnl?account_id=${accountId}&limit=100`);
      const rows = d?.data?.rows || [];
      if (!rows.length) return null;
      let realized = 0, unrealized = 0, wins = 0, losses = 0;
      const bySymbol = rows.map((r) => {
        const rp = parseFloat(r.total_realized_pnl || "0");
        const up = parseFloat(r.un_realized_pnl || "0");
        const holding = parseFloat(r.holding || "0");
        realized += rp; unrealized += up;
        if (rp > 0) wins++; else if (rp < 0) losses++;
        return {
          sym: coin(r.symbol),
          realized: Math.round(rp), unrealized: Math.round(up),
          open: Math.abs(holding) > 1e-9,
          side: holding > 0 ? "LONG" : holding < 0 ? "SHORT" : null,
          szUsd: Math.round(Math.abs(parseFloat(r.holding_value || "0"))),
          entry: parseFloat(r.average_entry_price || "0"),
        };
      }).sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized));
      const graded = wins + losses;
      return {
        brokerId, accountId, isNexus: brokerId === NEXUS_BROKER_ID,
        realized: Math.round(realized), unrealized: Math.round(unrealized),
        markets: rows.length, wins, losses,
        profitableMarketsPct: graded ? Math.round((wins / graded) * 1000) / 10 : 0,
        openPositions: bySymbol.filter((s) => s.open).length,
        bySymbol,
      };
    } catch { return null; }
  }));
  const venues = probed.filter(Boolean)
    .sort((a, b) => (b.isNexus ? 1 : 0) - (a.isNexus ? 1 : 0) || b.realized - a.realized);
  return {
    address, venues,
    totalRealized: venues.reduce((s, v) => s + v.realized, 0),
    totalUnrealized: venues.reduce((s, v) => s + v.unrealized, 0),
    markets: venues.reduce((s, v) => s + v.markets, 0),
    totalWins: venues.reduce((s, v) => s + v.wins, 0),
    totalLosses: venues.reduce((s, v) => s + v.losses, 0),
    totalOpen: venues.reduce((s, v) => s + v.openPositions, 0),
    brokersChecked: ORDERLY_BROKERS.length,
  };
}

// ── Tracked Record: persist the x-ray aggregate as a daily time-series ───────
// Turns the point-in-time x-ray into an ACCRUING, self-grading record. Each
// snapshot stores the cumulative aggregate; xrayTrack (logic.mjs) grades the
// DELTAS between snapshots — the realized PnL the wallet actually earned while
// tracked. Throttled to ~1/day so a busy read path can't manufacture noise.
const XRAY_HIST_PREFIX = "xray:hist:";
const XRAY_SNAP_MIN_MS = 20 * 3600 * 1000; // ≥20h between stored snapshots (≈1/day)
const XRAY_HIST_CAP = 240;                  // ~8 months of daily points
const XRAY_HIST_TTL = 400 * 86400;

async function readXrayHist(env, address) {
  const raw = await env.LAB_STORE.get(XRAY_HIST_PREFIX + address.toLowerCase());
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Append a snapshot if the last one is stale AND there's real indexed data to
// record (markets>0). Returns the (possibly unchanged) series. Never throws.
async function snapshotXray(env, address, agg) {
  try {
    const a = agg || await xrayAggregate(address);
    if (!a || a.markets <= 0) return await readXrayHist(env, address); // nothing indexed → don't store noise
    const hist = await readXrayHist(env, address);
    const last = hist[hist.length - 1];
    if (last && Number.isFinite(last.t) && Date.now() - last.t < XRAY_SNAP_MIN_MS) return hist; // fresh enough
    hist.push({
      t: Date.now(), realized: a.totalRealized, unrealized: a.totalUnrealized,
      markets: a.markets, wins: a.totalWins, losses: a.totalLosses, open: a.totalOpen,
    });
    const trimmed = hist.slice(-XRAY_HIST_CAP);
    await env.LAB_STORE.put(XRAY_HIST_PREFIX + address.toLowerCase(), JSON.stringify(trimmed), { expirationTtl: XRAY_HIST_TTL });
    return trimmed;
  } catch { return await readXrayHist(env, address); }
}

// Cron sweep: snapshot every wallet anyone has starred (union of all watchlists)
// so a Tracked Record accrues even when nobody is viewing it. Bounded + best-effort.
// Exported: the 12h cron in index.js drives it.
export async function sweepTrackedXray(env) {
  const listed = await env.LAB_STORE.list({ prefix: "sm:wl:" });
  const addrs = new Set();
  for (const k of listed.keys) {
    const raw = await env.LAB_STORE.get(k.name);
    if (!raw) continue;
    try { for (const a of JSON.parse(raw)) if (/^0x[a-f0-9]{40}$/i.test(a)) addrs.add(a.toLowerCase()); } catch { /* skip */ }
  }
  // Also snapshot the current board's traders so the leaderboard itself becomes a
  // GRADED-consistency board over time, not a raw single-number one (the moat move:
  // one big realized print can be luck; an accruing record can't).
  try {
    const braw = await env.LAB_STORE.get("sm:board:v5");
    if (braw) for (const t of (JSON.parse(braw).traders || [])) if (/^0x[a-f0-9]{40}$/i.test(t.address || "")) addrs.add(t.address.toLowerCase());
  } catch { /* non-fatal */ }
  const targets = [...addrs].slice(0, 200);
  let snapped = 0, events = 0;
  for (let i = 0; i < targets.length; i += 6) {
    await Promise.all(targets.slice(i, i + 6).map(async (a) => {
      const before = (await readXrayHist(env, a)).length;
      const series = await snapshotXray(env, a);
      if (series.length > before) { snapped++; if (await emitTierEvent(env, a, series)) events++; }
    }));
  }
  return { watched: targets.length, snapped, events };
}

// Graded, low-noise "tracked signals": when a fresh snapshot moves a wallet ACROSS
// a tier boundary (earned ▲ or lost ▽ its Operator tier), record one event. Diffed
// against the last-seen tier per wallet so we never spam — only real crossings, and
// only ~once/day (the snapshot cadence). Returns true if an event was emitted.
const XRAY_TIER_RANK = { "": 0, TRACKED: 1, POSITIVE: 2, CONSISTENT: 3 };
async function emitTierEvent(env, address, series) {
  try {
    const tk = xrayTrack(series);
    const toKey = tk.tier ? tk.tier.tier : "";
    const prevKey = (await env.LAB_STORE.get(`xray:tier:${address}`)) || "";
    if (toKey === prevKey) return false;
    await env.LAB_STORE.put(`xray:tier:${address}`, toKey, { expirationTtl: 400 * 86400 });
    const up = (XRAY_TIER_RANK[toKey] ?? 0) > (XRAY_TIER_RANK[prevKey] ?? 0);
    const ev = {
      wallet: address, kind: up ? "TIER_UP" : "TIER_DOWN",
      fromTier: prevKey || null, toTier: toKey || null,
      operatorScore: tk.operatorScore, netRealized: tk.netRealized, ts: Date.now(),
    };
    const exRaw = await env.LAB_STORE.get("xray:events");
    const merged = [ev, ...(exRaw ? JSON.parse(exRaw) : [])].slice(0, 40);
    await env.LAB_STORE.put("xray:events", JSON.stringify(merged), { expirationTtl: 14 * 86400 });
    return true;
  } catch { return false; }
}

// Build the Orderly-native smart-money board from the public realized-PnL ranking.
// One call returns the ecosystem's top traders + their live positions in Orderly
// symbols — so copies are NATIVE (no cross-venue mismatch, everything tradeable).
async function buildOrderlyBoard() {
  try {
    const d = await orderlyDashboard("/ranking/realized_pnl?limit=200"); // 200 = endpoint max
    const rows = d?.data?.rows || [];
    const coin = (s) => String(s).replace("PERP_", "").replace("_USDC", "");
    const byAddr = new Map();
    for (const r of rows) {
      const a = r.address;
      if (!a) continue;
      const e = byAddr.get(a) || { address: a, accountId: r.account_id, realized: 0, posMap: new Map() };
      e.realized += parseFloat(r.total_realized_pnl || "0");
      const h = parseFloat(r.holding || "0");
      if (Math.abs(h) > 1e-9) {
        const side = h > 0 ? "LONG" : "SHORT";
        const sym = coin(r.symbol);
        const key = `${sym}|${side}`;
        const szUsd = Math.round(Math.abs(parseFloat(r.holding_value || h * parseFloat(r.mark_price || "0"))));
        const uPnl = Math.round(parseFloat(r.un_realized_pnl || "0"));
        const prev = e.posMap.get(key);
        if (prev) { prev.szUsd += szUsd; prev.uPnl += uPnl; }
        else e.posMap.set(key, { coin: sym, sym, tradeable: true, side, szUsd, entry: parseFloat(r.average_entry_price || "0"), lev: null, uPnl });
      }
      byAddr.set(a, e);
    }
    return [...byAddr.values()]
      .map((e) => ({
        source: "orderly", address: e.address, accountId: e.accountId,
        pnl: Math.round(e.realized), pnlLabel: "realized", roi: null, accountValue: 0,
        positions: [...e.posMap.values()].filter((p) => p.szUsd >= 1000).sort((a, b) => b.szUsd - a.szUsd),
      }))
      // Actionable first: traders holding live positions lead, then by realized PnL.
      .sort((a, b) => (b.positions.length ? 1 : 0) - (a.positions.length ? 1 : 0) || b.pnl - a.pnl)
      .slice(0, 30);
  } catch { return []; }
}

// Orderly-native signal feed via position DIFF. The dashboard's raw trade/event
// endpoints are hash-encoded and awkward; instead we snapshot each top trader's
// live positions (already fetched for the board) and diff vs the last snapshot →
// clean OPEN/CLOSE events with readable symbols + addresses. Runs on board build.
async function updateOrderlyFeed(env, orderly) {
  try {
    const cur = {};
    for (const t of orderly) for (const p of t.positions) {
      cur[`${t.address}|${p.sym}|${p.side}`] = { address: t.address, sym: p.sym, side: p.side, szUsd: p.szUsd, entry: p.entry };
    }
    const prevRaw = await env.LAB_STORE.get("sm:ord:snap");
    await env.LAB_STORE.put("sm:ord:snap", JSON.stringify(cur), { expirationTtl: 7 * 86400 });
    if (!prevRaw) return; // first run — seed the snapshot, no diff yet
    const prev = JSON.parse(prevRaw);
    const now = Date.now();
    const ev = [];
    for (const k in cur) if (!prev[k]) ev.push({ source: "orderly", addr: cur[k].address, coin: cur[k].sym, sym: cur[k].sym, side: cur[k].side, type: "OPEN", price: cur[k].entry, szUsd: cur[k].szUsd, closedPnl: null, ts: now });
    for (const k in prev) if (!cur[k]) ev.push({ source: "orderly", addr: prev[k].address, coin: prev[k].sym, sym: prev[k].sym, side: prev[k].side, type: "CLOSE", price: prev[k].entry, szUsd: prev[k].szUsd, closedPnl: null, ts: now });
    if (ev.length) {
      const exRaw = await env.LAB_STORE.get("sm:ord:events");
      const merged = [...ev, ...(exRaw ? JSON.parse(exRaw) : [])].filter((e) => e.szUsd >= 5000).slice(0, 40);
      await env.LAB_STORE.put("sm:ord:events", JSON.stringify(merged), { expirationTtl: 3 * 86400 });
    }
  } catch { /* non-fatal */ }
}

// Store smart-money consensus (coin → dominant side + trader count) to the SHARED
// NEXUS_AGENT namespace so the agent brain can gate entries that fight it
// (respectSmartMoney). Keyed by bare coin; 1h TTL (fail-safe stale = no gating).
async function storeConsensus(env, traders) {
  try {
    const byCoin = {};
    for (const t of traders) for (const p of t.positions) {
      if (!p.sym) continue;
      const c = byCoin[p.sym] || (byCoin[p.sym] = { long: new Set(), short: new Set() });
      (p.side === "LONG" ? c.long : c.short).add(t.address);
    }
    const out = {};
    for (const coin in byCoin) {
      const l = byCoin[coin].long.size, s = byCoin[coin].short.size;
      const count = Math.max(l, s);
      if (count >= 2) out[coin] = { side: l >= s ? "LONG" : "SHORT", count };
    }
    await env.NEXUS_AGENT.put("sm:consensus", JSON.stringify(out), { expirationTtl: 3600 });
  } catch { /* non-fatal */ }
}

// POST to Hyperliquid's public info API. Same source as the /analyze x-ray.
async function hlInfo(body) {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL ${res.status}`);
  return res.json();
}

// Run tasks in bounded-concurrency batches (mirrors exec's scaling pattern).
async function batched(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

// Map a Hyperliquid coin ticker to the Orderly perp coin, or null if it can't be
// copied on Nexus. `xyz:`-style prefixes are HL builder/HIP-3 markets (different
// venue) → skip. HL's lowercase-k prefix means 1000× (kPEPE → 1000PEPE).
function hlCoinToOrderly(coin) {
  if (!coin || coin.includes(":")) return null;
  if (/^k[A-Z]/.test(coin)) return "1000" + coin.slice(1);
  return coin;
}

// Set of coins that exist as Orderly perps (PERP_<COIN>_USDC). Cached 1h. Used to
// gate ⚡ TRADE so a copy never produces a directive on a non-existent market.
async function orderlyPerpCoins(env) {
  const CACHE = "sm:orderly_coins";
  const cached = await env.LAB_STORE.get(CACHE);
  if (cached) return new Set(JSON.parse(cached));
  try {
    const d = await (await fetch("https://api-evm.orderly.org/v1/public/info")).json();
    const coins = (d.data?.rows || []).map((x) => String(x.symbol).split("_")[1]).filter(Boolean);
    await env.LAB_STORE.put(CACHE, JSON.stringify(coins), { expirationTtl: 3600 });
    return new Set(coins);
  } catch { return new Set(); }
}

// Normalize a clearinghouseState into compact open positions — dust filtered
// (< $1k notional), sorted by size, and tagged with the Orderly-copyable symbol.
function hlPositions(state, coinSet) {
  const rows = state?.assetPositions || [];
  return rows.map((ap) => {
    const p = ap.position || {};
    const szi = parseFloat(p.szi || "0");
    if (!szi) return null;
    const sym = hlCoinToOrderly(p.coin);
    return {
      coin: p.coin,
      sym,                                   // Orderly coin to copy, or null
      tradeable: !!sym && coinSet.has(sym),  // is it a Nexus/Orderly market?
      side: szi > 0 ? "LONG" : "SHORT",
      szUsd: Math.round(Math.abs(parseFloat(p.positionValue || "0"))),
      entry: parseFloat(p.entryPx || "0"),
      lev: parseFloat(p.leverage?.value || p.leverage || "0") || null,
      uPnl: Math.round(parseFloat(p.unrealizedPnl || "0")),
    };
  }).filter((p) => p && p.szUsd >= 1000).sort((a, b) => b.szUsd - a.szUsd);
}

// Refresh the tracked set from the live HL leaderboard (Phase 1.5). The full JSON
// is ~33MB — heavy for a Worker, so this is best-effort: on ANY failure the caller
// falls back to the static SMART_SEED. Ranks by 30d PnL, gated on real size.
// Exported: the 12h cron in index.js drives this (routes are read-only consumers).
export async function refreshSmartSeed(env) {
  const res = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  const data = await res.json();
  const rows = data?.leaderboardRows || [];
  const perf = (r, w) => (r.windowPerformances || []).find((x) => x[0] === w)?.[1] || {};
  const seed = rows.map((r) => {
    const m = perf(r, "month");
    return { a: String(r.ethAddress).toLowerCase(), av: parseFloat(r.accountValue || "0"), r: parseFloat(m.roi || "0"), p: parseFloat(m.pnl || "0"), v: parseFloat(m.vlm || "0") };
  })
    .filter((x) => x.av > 200000 && x.v > 2000000 && x.r > 0.1 && x.p > 50000)
    .sort((a, b) => b.p - a.p).slice(0, 24)
    .map((x) => ({ a: x.a, r: Math.round(x.r * 1000) / 1000, p: Math.round(x.p), v: Math.round(x.v) }));
  if (seed.length >= 8) {
    await env.LAB_STORE.put("sm:watch", JSON.stringify({ seed, updatedAt: Date.now() }), { expirationTtl: 7 * 86400 });
  }
  return seed.length;
}

// The active tracked set: freshest auto-refreshed watch, else the static seed.
async function smartSeed(env) {
  try {
    const raw = await env.LAB_STORE.get("sm:watch");
    if (raw) { const w = JSON.parse(raw); if (Array.isArray(w.seed) && w.seed.length >= 8) return w.seed; }
  } catch { /* fall through */ }
  return SMART_SEED;
}

// ── Route dispatcher ──────────────────────────────────────────────────────────
// ⚠️ `ctx` is required, not optional: /smart/board schedules background work via
// ctx.waitUntil (feed diff + consensus store). Dropping it here would ReferenceError
// at runtime while still bundling cleanly.
export async function handleSmart(parts, request, env, ctx) {
  if (parts[0] !== "smart") return null;
  // Derived here rather than passed in: it's a property of the request, and relying on
  // the caller's scope is exactly what broke /smart/trader and /smart/xray on the first
  // extraction (free variable → clean bundle → ReferenceError in production).
  const url = new URL(request.url);

  if (parts[0] === "smart" && parts[1] === "board" && request.method === "GET") {
    const CACHE_KEY = "sm:board:v5";
    const cached = await env.LAB_STORE.get(CACHE_KEY);
    if (cached) return json(JSON.parse(cached), request);
    const [orderly, seed, coinSet] = await Promise.all([buildOrderlyBoard(), smartSeed(env), orderlyPerpCoins(env)]);
    // HL secondary — top 10 by 30d PnL, mapped into the unified shape.
    const hl = await batched(seed.slice(0, 10), 8, async (s) => {
      try {
        const state = await hlInfo({ type: "clearinghouseState", user: s.a });
        return {
          source: "hl", address: s.a, pnl: s.p, pnlLabel: "30d", roi: s.r,
          accountValue: Math.round(parseFloat(state?.marginSummary?.accountValue || "0")),
          positions: hlPositions(state, coinSet),
        };
      } catch {
        return { source: "hl", address: s.a, pnl: s.p, pnlLabel: "30d", roi: s.r, accountValue: 0, positions: [] };
      }
    });
    const traders = [...orderly, ...hl]; // Orderly first (primary)
    ctx.waitUntil(updateOrderlyFeed(env, orderly)); // diff → Orderly signal feed
    ctx.waitUntil(storeConsensus(env, traders)); // → agent respectSmartMoney gate
    const payload = { traders, count: traders.length, orderly: orderly.length, hl: hl.length, updatedAt: Date.now() };
    await env.LAB_STORE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: 600 });
    return json(payload, request);
  }

  // ── GET /smart/trader?account_id= — one unified Orderly trader detail ────────
  // Per-account realized+unrealized PnL by market + live positions (public
  // dashboard indexer, by account_id → no broker_id needed). KV-cached 5min.
  if (parts[0] === "smart" && parts[1] === "trader" && request.method === "GET") {
    const accountId = url.searchParams.get("account_id");
    if (!accountId) return json({ error: "account_id required" }, request, 400);
    const CACHE = `sm:trader:${accountId}`;
    const cached = await env.LAB_STORE.get(CACHE);
    if (cached) return json(JSON.parse(cached), request);
    try {
      const d = await orderlyDashboard(`/ranking/realized_pnl?account_id=${encodeURIComponent(accountId)}&limit=50`);
      const rows = d?.data?.rows || [];
      const coin = (s) => String(s).replace("PERP_", "").replace("_USDC", "");
      let totalRealized = 0, totalUnrealized = 0, wins = 0, losses = 0;
      const bySymbol = rows.map((r) => {
        const realized = Math.round(parseFloat(r.total_realized_pnl || "0"));
        const unrealized = Math.round(parseFloat(r.un_realized_pnl || "0"));
        const holding = parseFloat(r.holding || "0");
        totalRealized += realized; totalUnrealized += unrealized;
        if (realized > 0) wins++; else if (realized < 0) losses++;
        return {
          sym: coin(r.symbol), realized, unrealized,
          open: Math.abs(holding) > 1e-9,
          side: holding > 0 ? "LONG" : holding < 0 ? "SHORT" : null,
          szUsd: Math.round(Math.abs(parseFloat(r.holding_value || "0"))),
          entry: parseFloat(r.average_entry_price || "0"),
        };
      }).sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized));
      const graded = wins + losses;
      const payload = {
        accountId, address: rows[0]?.address || null, totalRealized, totalUnrealized,
        profitableMarketsPct: graded ? Math.round((wins / graded) * 1000) / 10 : 0,
        markets: rows.length, wins, losses, bySymbol,
      };
      await env.LAB_STORE.put(CACHE, JSON.stringify(payload), { expirationTtl: 300 });
      return json(payload, request);
    } catch (e) {
      return json({ error: String(e) }, request, 502);
    }
  }

  // ── GET /smart/xray?address= — PUBLIC multi-venue Orderly wallet x-ray ───────
  // The dashboard indexer is keyed by account_id, NOT address — orderlyAccountId()
  // derives that deterministically per broker, so ANY wallet can be x-rayed across
  // the Orderly network instead of only the top-200 ranking. Nexus is probed first.
  // ⚠️ The indexer exposes per-SYMBOL aggregates, not a per-trade tape (/trades is
  // hash-encoded, /events_v2 empty). So this is a venue + market breakdown — it
  // CANNOT produce the hold-time/timing analytics the HL fill history supports.
  // Don't promise per-trade stats off this endpoint. KV-cached 5min.
  if (parts[0] === "smart" && parts[1] === "xray" && parts[2] === "history" && request.method === "GET") {
    // ── GET /smart/xray/history?address= — the accruing Tracked Record ─────────
    // Grades the wallet's realized-PnL over time (xrayTrack). Self-seeding: if the
    // stored series is empty or stale it snapshots a fresh aggregate first, so
    // simply opening a wallet's detail begins its record. Cheap on repeat views —
    // it only pays the multi-broker fetch when a new daily snapshot is due.
    const address = (url.searchParams.get("address") || "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return json({ error: "valid 0x address required" }, request, 400);
    let hist = await readXrayHist(env, address);
    const last = hist[hist.length - 1];
    const stale = !last || !Number.isFinite(last.t) || Date.now() - last.t >= XRAY_SNAP_MIN_MS;
    if (stale) { try { hist = await snapshotXray(env, address); } catch { /* keep stored */ } }
    return json({ address, snapshots: hist.length, track: xrayTrack(hist), updatedAt: Date.now() }, request);
  }

  if (parts[0] === "smart" && parts[1] === "xray" && parts[2] === "events" && request.method === "GET") {
    // ── GET /smart/xray/events — graded "tracked signals" (tier crossings) ─────
    // A wallet earning ▲ or losing ▽ its Operator tier. Emitted by the daily cron
    // sweep, so it's a real crossing, not noise. Public read.
    const raw = await env.LAB_STORE.get("xray:events");
    return json({ events: raw ? JSON.parse(raw) : [], updatedAt: Date.now() }, request);
  }

  if (parts[0] === "smart" && parts[1] === "xray" && parts[2] === "tracked" && request.method === "GET") {
    // ── GET /smart/xray/tracked?addresses=a,b,c — batch graded records ─────────
    // KV-only (no external fetch): reads each wallet's stored snapshot series and
    // grades it. Powers the compact Operator Score / tier chip on the Smart Money
    // board + watchlist rows without an aggregate fetch per row. Only wallets that
    // have accrued ≥2 snapshots appear — the rest simply aren't tracked yet.
    const addrs = [...new Set((url.searchParams.get("addresses") || "").split(",")
      .map((s) => s.trim().toLowerCase()).filter((a) => /^0x[a-f0-9]{40}$/.test(a)))].slice(0, 60);
    const out = {};
    await Promise.all(addrs.map(async (a) => {
      const hist = await readXrayHist(env, a);
      if (hist.length < 2) return;
      const tk = xrayTrack(hist);
      out[a] = {
        operatorScore: tk.operatorScore, tier: tk.tier, scored: tk.scored,
        netRealized: tk.netRealized, daysTracked: tk.daysTracked, trend: tk.trend, points: tk.points,
      };
    }));
    return json({ tracked: out }, request);
  }

  if (parts[0] === "smart" && parts[1] === "xray" && request.method === "GET") {
    const address = (url.searchParams.get("address") || "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return json({ error: "valid 0x address required" }, request, 400);
    const CACHE = `sm:xray:${address.toLowerCase()}`;
    const cached = await env.LAB_STORE.get(CACHE);
    if (cached) {
      // Even a cache hit should keep the Tracked Record accruing (throttled inside).
      ctx.waitUntil(snapshotXray(env, address));
      return json(JSON.parse(cached), request);
    }
    const payload = await xrayAggregate(address);
    await env.LAB_STORE.put(CACHE, JSON.stringify(payload), { expirationTtl: 300 });
    // Seed/extend the accruing record off the aggregate we already fetched.
    ctx.waitUntil(snapshotXray(env, address, payload));
    return json(payload, request);
  }

  // ── POST /smart/refresh — best-effort auto-refresh of the tracked set ────────
  // From the live HL leaderboard (33MB → best-effort, falls back to static seed).
  // Also fired on cron. No auth: read-only public-data digest.
  if (parts[0] === "smart" && parts[1] === "refresh") {
    try {
      const n = await refreshSmartSeed(env);
      return json({ ok: true, tracked: n }, request);
    } catch (e) {
      return json({ ok: false, error: String(e), fallback: "static seed" }, request);
    }
  }

  // ── GET /smart/events — recent opens/closes across the tracked set ──────────
  // Merged, time-sorted signal feed from userFills. Only Orderly-copyable coins,
  // deduped (partial fills of one move collapse into a single row). KV-cached 3min.
  if (parts[0] === "smart" && parts[1] === "events" && request.method === "GET") {
    const CACHE_KEY = "sm:events:v3";
    const cached = await env.LAB_STORE.get(CACHE_KEY);
    if (cached) return json(JSON.parse(cached), request);
    const [seed, coinSet] = await Promise.all([smartSeed(env), orderlyPerpCoins(env)]);
    // key → aggregated event; collapses partial fills of the same action.
    const byKey = new Map();
    await batched(seed.slice(0, 14), 6, async (s) => {
      try {
        const fills = await hlInfo({ type: "userFills", user: s.a });
        for (const f of (Array.isArray(fills) ? fills.slice(0, 12) : [])) {
          const dir = f.dir || "";
          const isOpen = /^Open/.test(dir), isClose = /^Close/.test(dir);
          if (!isOpen && !isClose) continue;
          const sym = hlCoinToOrderly(f.coin);
          if (!sym || !coinSet.has(sym)) continue;          // Orderly-copyable only
          const side = /Long/.test(dir) ? "LONG" : "SHORT";
          const type = isOpen ? "OPEN" : "CLOSE";
          const key = `${s.a}|${sym}|${side}|${type}`;
          const szUsd = Math.round(parseFloat(f.px || "0") * parseFloat(f.sz || "0"));
          const prev = byKey.get(key);
          if (prev) {
            prev.szUsd += szUsd;
            prev.closedPnl = prev.closedPnl == null ? (isClose ? Math.round(parseFloat(f.closedPnl || "0")) : null) : prev.closedPnl + (isClose ? Math.round(parseFloat(f.closedPnl || "0")) : 0);
            if (f.time > prev.ts) { prev.ts = f.time; prev.price = parseFloat(f.px || "0"); }
          } else {
            byKey.set(key, {
              source: "hl", addr: s.a, coin: f.coin, sym, side, type,
              price: parseFloat(f.px || "0"), szUsd,
              closedPnl: isClose ? Math.round(parseFloat(f.closedPnl || "0")) : null,
              ts: f.time,
            });
          }
        }
      } catch { /* skip this trader */ }
      return null;
    });
    // Merge the Orderly-native diff feed (primary) with the HL fills feed.
    const ordRaw = await env.LAB_STORE.get("sm:ord:events");
    const ordEvents = ordRaw ? JSON.parse(ordRaw) : [];
    const events = [...ordEvents, ...byKey.values()].sort((a, b) => b.ts - a.ts).slice(0, 30);
    const payload = { events, updatedAt: Date.now() };
    await env.LAB_STORE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: 180 });
    return json(payload, request);
  }

  // ── Smart Money watchlist (v2) — cross-device sync of starred wallets ────────
  // GET is public (returns a wallet's saved list); POST is owner-authed via the
  // static walletSig (recovers to the caller → they can only write their own).
  if (parts[0] === "smart" && parts[1] === "watchlist" && parts[2] && request.method === "GET") {
    const raw = await env.LAB_STORE.get(`sm:wl:${normalizeAddress(parts[2])}`);
    return json({ watch: raw ? JSON.parse(raw) : [] }, request);
  }
  if (parts[0] === "smart" && parts[1] === "watchlist" && request.method === "POST") {
    let body = {}; try { body = await request.json(); } catch { /* ignore */ }
    const caller = typeof body.walletSig === "string" ? recoverEthAddress("nexus-trading-key-v1", body.walletSig) : null;
    if (!caller) return json({ error: "walletSig_required" }, request, 401);
    const clean = Array.isArray(body.watch)
      ? [...new Set(body.watch.filter((x) => typeof x === "string" && /^0x[a-f0-9]{40}$/i.test(x)).map((x) => x.toLowerCase()))].slice(0, 100)
      : [];
    await env.LAB_STORE.put(`sm:wl:${caller}`, JSON.stringify(clean), { expirationTtl: 365 * 86400 });
    return json({ ok: true, watch: clean }, request);
  }

  // ── POST /tg/webhook — Telegram bot updates (link a chat ↔ wallet) ──────────
  // The bot deep-link t.me/nexustradinglabs_bot?start=<wallet> sends "/start <wallet>".
  // We map chat_id ↔ wallet in KV so the exec can DM the owner on agent trades. Public
  // (Telegram calls it); nothing sensitive is exposed. Reply needs TELEGRAM_TOKEN, but
  // the mapping is stored even without it (degrades to no confirmation message).
  return null; // a /smart/* path we don't serve → fall through
}
