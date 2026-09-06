// ── Nexus token terminal — data layer ────────────────────────────────────────
// A Definitive-style token page needs four public reads, all CLIENT-SIDE (the same
// reason NexusMarket fetches GeckoTerminal from the browser: GT/CoinGecko 403 datacenter
// IPs, so a worker proxy would be the thing that's blocked, not the browser):
//   1. DexScreener search / token → the header (price, MC/FDV, vol, liq, 24h%, buys/sells,
//      CA, socials) AND pool discovery, in ONE permissive call. This is the source of truth
//      for identity + stats.
//   2. GeckoTerminal pool OHLCV → the candles (DexScreener exposes no OHLC).
//   3. GeckoTerminal pool trades → the live tape (AMT / PRICE / ADDR / AGE).
//   4. Orderly public info → whether this symbol is a Nexus PERP, so the trade CTA can route
//      to real in-venue execution instead of only a deep-link out.
// Everything is fail-soft: a dead source renders its section empty, never blocks the page.

const DS_BASE = "https://api.dexscreener.com/latest/dex";
const GT_BASE = "https://api.geckoterminal.com/api/v2";
const ORDERLY_INFO = "https://api-evm.orderly.org/v1/public/info";
const AGENT_API = "https://og.nexustradinglabs.com";

// ── shared: a fetch that can't hang the UI (the watchdog lesson — an unsettled promise
// never runs your .catch, so cap it with an abort) ───────────────────────────────────
async function getJson(url: string, ms = 6000): Promise<unknown | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// DexScreener chainId → GeckoTerminal network slug. Most align; these are the ones that don't.
const GT_NETWORK: Record<string, string> = {
  ethereum: "eth",
  binance: "bsc",
  bsc: "bsc",
  polygon: "polygon_pos",
  avalanche: "avax",
  arbitrum: "arbitrum",
  optimism: "optimism",
  base: "base",
  solana: "solana",
  sui: "sui",
  ton: "ton",
};
export const gtNetwork = (chainId: string): string => GT_NETWORK[chainId] || chainId;

// ── types (only the fields the terminal reads) ────────────────────────────────
export interface TokenSocial { type: string; url: string }
export interface TokenPair {
  chainId: string;
  dexId: string;
  url: string;                 // DexScreener pair page (fallback trade link)
  pairAddress: string;         // == GeckoTerminal pool address on most chains
  baseSymbol: string;
  baseName: string;
  baseAddress: string;
  quoteSymbol: string;
  priceUsd: number | null;
  priceChange24h: number | null;
  liquidityUsd: number | null;
  fdv: number | null;
  marketCap: number | null;
  volume24h: number | null;
  volume1h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  imageUrl: string | null;
  websites: string[];
  socials: TokenSocial[];
  createdAt: number | null;
}
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
export interface Trade { ts: number; kind: "buy" | "sell"; amountUsd: number; priceUsd: number; wallet: string; tx: string }

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPair(p: any): TokenPair | null {
  if (!p || !p.baseToken || !p.chainId) return null;
  const info = p.info || {};
  return {
    chainId: String(p.chainId),
    dexId: String(p.dexId || ""),
    url: String(p.url || ""),
    pairAddress: String(p.pairAddress || ""),
    baseSymbol: String(p.baseToken.symbol || "").toUpperCase(),
    baseName: String(p.baseToken.name || p.baseToken.symbol || ""),
    baseAddress: String(p.baseToken.address || ""),
    quoteSymbol: String(p.quoteToken?.symbol || "USD").toUpperCase(),
    priceUsd: num(p.priceUsd),
    priceChange24h: num(p.priceChange?.h24),
    liquidityUsd: num(p.liquidity?.usd),
    fdv: num(p.fdv),
    marketCap: num(p.marketCap) ?? num(p.fdv),
    volume24h: num(p.volume?.h24),
    volume1h: num(p.volume?.h1),
    buys24h: num(p.txns?.h24?.buys),
    sells24h: num(p.txns?.h24?.sells),
    imageUrl: info.imageUrl || null,
    websites: Array.isArray(info.websites) ? info.websites.map((w: { url: string }) => w.url).filter(Boolean) : [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socials: Array.isArray(info.socials) ? info.socials.map((s: any) => ({ type: String(s.type || s.platform || "link"), url: String(s.url || s.handle || "") })).filter((s: TokenSocial) => s.url) : [],
    createdAt: num(p.pairCreatedAt),
  };
}

// The most LIQUID pair wins — that's the one a trader actually means, and the one with the
// deepest tape + chart. DexScreener returns every pair for a query; we rank by USD liquidity.
function bestPair(pairs: TokenPair[]): TokenPair | null {
  if (!pairs.length) return null;
  return [...pairs].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
}

// Search by symbol, name, or contract address (Definitive's "Search CA or Token"). Returns the
// deepest pair plus the ranked alternates (so the UI can offer "did you mean" for ambiguous
// tickers). A bare EVM/Solana address goes straight to the token endpoint for an exact hit.
export async function searchToken(query: string): Promise<{ best: TokenPair | null; alts: TokenPair[] }> {
  const q = query.trim();
  if (!q) return { best: null, alts: [] };
  const isAddress = /^0x[a-fA-F0-9]{40}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);
  const url = isAddress ? `${DS_BASE}/tokens/${encodeURIComponent(q)}` : `${DS_BASE}/search?q=${encodeURIComponent(q)}`;
  const j = (await getJson(url)) as { pairs?: unknown[] } | null;
  const pairs = Array.isArray(j?.pairs) ? j!.pairs!.map(toPair).filter((p): p is TokenPair => !!p) : [];
  const best = bestPair(pairs);
  const alts = pairs
    .filter((p) => p.pairAddress !== best?.pairAddress)
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .slice(0, 4);
  return { best, alts };
}

// GeckoTerminal OHLCV → candles. timeframe: day | hour | minute (+ aggregate for 5m/15m/4h).
export async function poolCandles(network: string, pool: string, timeframe = "hour", aggregate = 1, limit = 100): Promise<Candle[]> {
  if (!pool) return [];
  const url = `${GT_BASE}/networks/${gtNetwork(network)}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}`;
  const j = (await getJson(url)) as { data?: { attributes?: { ohlcv_list?: number[][] } } } | null;
  const list = j?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  // GT returns newest-first; the chart wants oldest→newest left→right.
  return list
    .map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }))
    .filter((c) => Number.isFinite(c.o) && Number.isFinite(c.c))
    .sort((a, b) => a.t - b.t);
}

// GeckoTerminal recent trades → the live tape.
export async function poolTrades(network: string, pool: string): Promise<Trade[]> {
  if (!pool) return [];
  const url = `${GT_BASE}/networks/${gtNetwork(network)}/pools/${pool}/trades`;
  const j = (await getJson(url)) as { data?: unknown[] } | null;
  if (!Array.isArray(j?.data)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (j!.data as any[])
    .map((d) => {
      const a = d?.attributes || {};
      const kind = a.kind === "sell" ? "sell" : "buy";
      const ts = a.block_timestamp ? Date.parse(a.block_timestamp) : NaN;
      return {
        ts: Number.isFinite(ts) ? ts : Date.now(),
        kind: kind as "buy" | "sell",
        amountUsd: num(a.volume_in_usd) ?? 0,
        priceUsd: num(a.price_to_in_usd) ?? num(a.price_from_in_usd) ?? 0,
        wallet: String(a.tx_from_address || ""),
        tx: String(a.tx_hash || ""),
      };
    })
    .filter((t) => t.amountUsd > 0)
    .slice(0, 40);
}

// Orderly perp base symbols (BTC, ETH, …) so the CTA can route to REAL Nexus execution when
// the token is one we list. Cached module-wide — the set changes rarely and the page mounts often.
let _perpSet: Set<string> | null = null;
let _perpAt = 0;
export async function orderlyPerpSet(): Promise<Set<string>> {
  if (_perpSet && Date.now() - _perpAt < 10 * 60 * 1000) return _perpSet;
  const j = (await getJson(ORDERLY_INFO)) as { data?: { rows?: { symbol: string }[] } } | null;
  const rows = j?.data?.rows;
  const set = new Set<string>();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const m = /^PERP_([A-Z0-9]+)_USDC$/.exec(String(r.symbol || ""));
      if (m) set.add(m[1]);
    }
  }
  if (set.size) { _perpSet = set; _perpAt = Date.now(); }
  return set;
}

// ── the Nexus edge, on any token we list ──────────────────────────────────────
// The differentiator vs a plain swap terminal: next to the chart, the SAME graded funding
// verdict the Board and the ticket show. Reads the canonical /signals row (the ONE verdict
// source) — the terminal never re-derives it, so it can't disagree with the Lab. Null when the
// token isn't a listed market (we don't compute funding/OI on arbitrary memecoins — honest).
export interface NexusSignal {
  symbol: string;
  verdict: "FADE" | "WATCH" | "NONE" | null;
  fadeDir: "LONG" | "SHORT" | "NONE" | null;
  fundingAnnualPct: number | null;
  stretched: boolean | null;
}
// ── chart overlays (graded calls + estimated liq) for a LISTED perp — the same sources the Lab
// QuickTrade chart plots, so the Spot chart can carry the Nexus social + liq layer too. ────────
export interface CallMark { t: number; entry: number; dir: "LONG" | "SHORT"; pfp: string | null; name: string | null; wallet: string }
export interface LiqMap { below: { price: number; mag: number }[]; above: { price: number; mag: number }[]; currentPrice: number }
const bareSym = (s: string) => String(s || "").toUpperCase().replace(/^PERP_/, "").replace(/_USDC$/, "");
export async function chartOverlays(coin: string): Promise<{ calls: CallMark[]; liq: LiqMap | null }> {
  const sym = bareSym(coin);
  const [feed, lm] = await Promise.all([
    getJson(`${AGENT_API}/feed`).catch(() => null),
    getJson(`${AGENT_API}/intel/liqmap/${sym}`).catch(() => null),
  ]);
  const rows = (Array.isArray(feed) ? feed : (feed as { feed?: unknown[]; items?: unknown[] })?.feed ?? (feed as { items?: unknown[] })?.items ?? []) as Record<string, unknown>[];
  const calls: CallMark[] = rows
    .map((t) => ({
      wallet: String(t.wallet || ""), pfp: (t.pfp as string) ?? null, name: (t.displayName as string) ?? null,
      dir: (t.direction === "SHORT" ? "SHORT" : "LONG") as "LONG" | "SHORT",
      entry: Number(t.entryPrice ?? t.entry_price ?? 0),
      t: Number(t.createdAt ?? t.created_at ?? 0),
      coin: bareSym(String(t.symbol || "")),
    }))
    .filter((c) => c.coin === sym && c.entry > 0 && c.t > 0)
    .slice(0, 16)
    .map((c) => ({ wallet: c.wallet, pfp: c.pfp, name: c.name, dir: c.dir, entry: c.entry, t: c.t }));
  const d = lm as { available?: boolean; below?: { price: number; mag: number }[]; above?: { price: number; mag: number }[]; currentPrice?: number } | null;
  const liq: LiqMap | null = d?.available && Number(d.currentPrice) > 0
    ? { below: d.below || [], above: d.above || [], currentPrice: Number(d.currentPrice) }
    : null;
  return { calls, liq };
}

// ── Spot TAKES — ungraded bull/bear conviction on a token, discussable (FOMO-style, but on
// verifiable wallet identity). Firewalled server-side under takes:{chain}:{ca} — never touches
// grading / the caller leaderboard / the ledger. Each take's `id` seeds a SocialBar (🔥 + comments).
export interface Take {
  id: string; wallet: string; direction: "BULL" | "BEAR"; text: string;
  target: number | null; sym?: string; pfp?: string | null; displayName?: string | null; createdAt: number;
}
export async function fetchTakes(chain: string, ca: string): Promise<Take[]> {
  const j = (await getJson(`${AGENT_API}/takes/${encodeURIComponent(chain)}/${encodeURIComponent(ca)}`)) as { takes?: Take[] } | null;
  return Array.isArray(j?.takes) ? j!.takes! : [];
}
export async function postTake(
  chain: string, ca: string,
  body: { wallet: string; direction: "BULL" | "BEAR"; text: string; target?: number | null; sym?: string },
): Promise<Take | null> {
  try {
    const r = await fetch(`${AGENT_API}/takes/${encodeURIComponent(chain)}/${encodeURIComponent(ca)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { take?: Take };
    return j?.take ?? null;
  } catch { return null; }
}
// ── Caller merit map — a take carries its author's EARNED graded rank (the FOMO-killer: they
// show self-reported PnL, we show "this bull take is from a 55%-hit Apex caller"). Sourced from
// the SAME /theses/leaderboard the Feed ranks on, module-cached so repeated /token views share
// one call. Only RANKED callers (5+ graded calls, net-positive R) appear; everyone else = no badge.
export interface CallerMerit { tier: string; title: string; glyph: string; hitRate: number; avgR: number; calls: number }
let _meritCache: { at: number; map: Record<string, CallerMerit> } | null = null;
export async function fetchCallerMerit(): Promise<Record<string, CallerMerit>> {
  if (_meritCache && Date.now() - _meritCache.at < 120000) return _meritCache.map;
  const map: Record<string, CallerMerit> = {};
  try {
    const j = (await getJson(`${AGENT_API}/theses/leaderboard`)) as { leaderboard?: Record<string, unknown>[] } | null;
    for (const e of (Array.isArray(j?.leaderboard) ? j!.leaderboard! : [])) {
      const w = String(e.wallet || "").toLowerCase();
      const m = e.meritRank as { tier?: string; title?: string; glyph?: string } | null;
      if (!w || !m || !m.glyph) continue;
      map[w] = { tier: String(m.tier || ""), title: String(m.title || ""), glyph: String(m.glyph), hitRate: Number(e.hitRate) || 0, avgR: Number(e.avgR) || 0, calls: Number(e.calls) || 0 };
    }
    _meritCache = { at: Date.now(), map };
  } catch { /* fail-soft — no badges rather than a broken page */ }
  return map;
}

export async function deleteTake(chain: string, ca: string, id: string, wallet: string): Promise<boolean> {
  try {
    const r = await fetch(`${AGENT_API}/takes/${encodeURIComponent(chain)}/${encodeURIComponent(ca)}/${encodeURIComponent(id)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet }),
    });
    return r.ok;
  } catch { return false; }
}

export async function nexusSignal(symbol: string): Promise<NexusSignal | null> {
  const j = (await getJson(`${AGENT_API}/signals`)) as { signals?: unknown[] } | null;
  const rows = Array.isArray(j?.signals) ? j!.signals! : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (rows as any[]).find((x) => String(x?.symbol || "").toUpperCase() === symbol.toUpperCase());
  if (!r) return null;
  return {
    symbol: symbol.toUpperCase(),
    verdict: r.verdict === "FADE" || r.verdict === "WATCH" || r.verdict === "NONE" ? r.verdict : null,
    fadeDir: r.fade_dir === "LONG" || r.fade_dir === "SHORT" || r.fade_dir === "NONE" ? r.fade_dir : null,
    fundingAnnualPct: num(r.funding_annual_pct),
    stretched: typeof r.stretched === "boolean" ? r.stretched : null,
  };
}

// ── in-app swap QUOTE (preview only — no signing this pass) ───────────────────
// Grok/borst rails: a router + a preview, never a Nexus book. Jupiter is the one router I can
// quote KEYLESS and CORS-open from the browser with no wallet — so Solana tokens get a real
// route check + price impact here. EVM routers (WooFi/0x) need a key or the full widget, so
// EVM stays on the honest named deep-link rather than a faked quote. Fail-soft: any error →
// null → the panel falls back to the deep-link, so a changed Jupiter endpoint never breaks the
// page, it just hides the badge. This does NOT execute anything; signing is a separate pass.
// Jupiter quote via OUR worker (og.nexustradinglabs.com/swap/jup/quote) so the api.jup.ag x-api-key
// stays server-side; response shape is unchanged (Jupiter /swap/v1 == the old /v6 schema).
const JUP_QUOTE = `${AGENT_API}/swap/jup/quote`;
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC mint, Solana
// USDC by DexScreener chainId → numeric chainId, for the EVM (Fabric) quote probe. Only chains
// where we know the canonical USDC; anything else simply doesn't get an EVM quote (deep-link).
const EVM_USDC: Record<string, { chainId: number; usdc: string }> = {
  base:      { chainId: 8453,  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  ethereum:  { chainId: 1,     usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  arbitrum:  { chainId: 42161, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  optimism:  { chainId: 10,    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  polygon:   { chainId: 137,   usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
};
export interface SwapQuote { router: string; priceImpactPct: number | null; probeUsd: number }

// Preview-only quote (NO signing). Solana → keyless Jupiter, client-side. EVM → Fabric, but ONLY
// through our worker (the App ID is a server secret) — /swap/quote injects the X-App-Id header.
// Fail-soft everywhere: any miss returns null and the panel keeps the honest deep-link.
export async function swapQuote(pair: TokenPair, probeUsd = 100): Promise<SwapQuote | null> {
  if (!pair.baseAddress) return null;
  const amount = Math.round(probeUsd * 1e6); // USDC has 6 decimals on both Solana and EVM
  if (pair.chainId === "solana") {
    const url = `${JUP_QUOTE}?inputMint=${USDC_SOL}&outputMint=${encodeURIComponent(pair.baseAddress)}&amount=${amount}&slippageBps=100`;
    const j = (await getJson(url)) as { outAmount?: string; priceImpactPct?: string } | null;
    if (!j || !j.outAmount) return null;
    const impact = Number(j.priceImpactPct); // Jupiter returns a fraction (0.012 = 1.2%)
    return { router: "Jupiter", priceImpactPct: Number.isFinite(impact) ? impact * 100 : null, probeUsd };
  }
  const evm = EVM_USDC[pair.chainId];
  if (!evm) return null;
  const url = `${AGENT_API}/swap/quote?chain=${evm.chainId}&tokenIn=${evm.usdc}&tokenOut=${encodeURIComponent(pair.baseAddress)}&amount=${amount}`;
  const j = (await getJson(url)) as { ok?: boolean; router?: string; priceImpact?: unknown } | null;
  if (!j || !j.ok) return null; // no route / secret unset / unknown shape → deep-link fallback
  const impact = Number(j.priceImpact);
  return { router: j.router || "Fabric", priceImpactPct: Number.isFinite(impact) ? impact : null, probeUsd };
}

// ── formatters (compact, terminal register) ──────────────────────────────────
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
// Tape AMOUNT column: ONE unit for the whole scroll — whole dollars with commas — so a
// $1 stable print and a $2,449 print read as the same kind of number (not "$1.00" mixed
// with "$2.4K"/"$1.20M", which made the column jump units row-to-row). Sub-$1 prints
// collapse to "<$1" so the column stays integer-aligned.
export function fmtTapeUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 1) return "<$1";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  // sub-cent memecoin price — ~4 significant figures, no scientific notation
  return `$${n.toPrecision(4).replace(/e[-+]?\d+$/i, "")}`;
}
export function fmtAge(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
export const shortAddr = (a: string): string => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "—");
